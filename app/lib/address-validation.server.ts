/**
 * Strict delivery-address verification.
 *
 * This module never invents or silently accepts an address. A booking is
 * allowed only when a geocoder returns a street-level result, the returned
 * city matches Shopify's city, and (when supplied) the postal code matches.
 * A provider outage or ambiguous result is a validation failure, not a
 * fail-open condition.
 */

export type DeliveryAddressInput = {
  address1: string | null | undefined;
  address2?: string | null | undefined;
  city: string | null | undefined;
  province?: string | null | undefined;
  zip?: string | null | undefined;
  country?: string | null | undefined;
  countryCode?: string | null | undefined;
};

export type VerifiedAddress = {
  formattedAddress: string;
  city: string;
  province: string | null;
  postalCode: string | null;
  source: "geocode.maps.co" | "nominatim";
  confidence: "street" | "locality";
  warning?: string;
};

export type AddressVerificationResult =
  | {ok: true; verifiedAddress: VerifiedAddress}
  | {
      ok: false;
      code:
        | "ADDRESS_REQUIRED"
        | "ADDRESS_NOT_FOUND"
        | "ADDRESS_AMBIGUOUS"
        | "ADDRESS_CITY_MISMATCH"
        | "POSTAL_CODE_MISMATCH"
        | "ADDRESS_VERIFICATION_UNAVAILABLE";
      message: string;
      detectedCity?: string;
      suggestedAddress?: string;
    };

type AddressComponents = Record<string, string | undefined>;

type GeocodeCandidate = {
  display_name?: string;
  address?: AddressComponents;
};

/** City aliases used by InstaWorld/Shopify addresses in Pakistan. */
const CITY_ALIASES: Record<string, string[]> = {
  ISLAMABAD: ["islamabad", "isb"],
  RAWALPINDI: ["rawalpindi", "rawalpinḍi", "pindi", "rwp"],
  LAHORE: ["lahore", "lhr"],
  KARACHI: ["karachi", "khi"],
  PESHAWAR: ["peshawar", "peshāwar", "pew"],
  FAISALABAD: ["faisalabad", "lyallpur", "fsd"],
  MULTAN: ["multan"],
  GUJRANWALA: ["gujranwala", "gujranwālā"],
  QUETTA: ["quetta"],
  HYDERABAD: ["hyderabad", "ḥaidarābād"],
  SIALKOT: ["sialkot"],
  BAHAWALPUR: ["bahawalpur", "bwp"],
  SARGODHA: ["sargodha"],
  ABBOTTABAD: ["abbottabad"],
  CHARSADDA: ["charsadda", "chārsaddah", "چارسدہ"],
  MARDAN: ["mardan"],
  SUKKUR: ["sukkur"],
  LARKANA: ["larkana", "lārkāna"],
  GUJRAT: ["gujrat"],
  SHEIKHUPURA: ["sheikhupura"],
  RAHIM_YAR_KHAN: ["rahim yar khan", "rahimyarkhan", "ryk"],
  "DERA GHAZI KHAN": ["dera ghazi khan", "d.g. khan", "dgk"],
  "DERA ISMAIL KHAN": ["dera ismail khan", "d.i. khan", "dik"],
  MUZAFFARABAD: ["muzaffarabad"],
  MIRPUR: ["mirpur"],
  SAHIWAL: ["sahiwal"],
  OKARA: ["okara"],
  KASUR: ["kasur"],
  JHANG: ["jhang"],
  NAROWAL: ["narowal"],
  HAFIZABAD: ["hafizabad"],
  CHINIOT: ["chiniot"],
  VEHARI: ["vehari"],
  KHANEWAL: ["khanewal"],
  SWAT: ["swat", "swāt"],
  NOWSHERA: ["nowshera"],
  KOHAT: ["kohat"],
  BANNU: ["bannu"],
};

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function stripCityQualifier(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/^(district|city|tehsil|gpo|division|ضلع|تحصیل)\s+/i, "")
    .replace(/\s+(district|city|tehsil|gpo|division)$/i, "")
    .trim();
}

function canonicalCity(value: string): string {
  const raw = stripCityQualifier(value);
  const normalized = normalize(raw);
  for (const [canonical, aliases] of Object.entries(CITY_ALIASES)) {
    const candidates = [canonical.replace(/_/g, " "), ...aliases];
    if (candidates.some((candidate) => {
      const candidateRaw = stripCityQualifier(candidate);
      const candidateNormalized = normalize(candidateRaw);
      return raw === candidateRaw || (Boolean(normalized) && normalized === candidateNormalized);
    })) {
      return canonical;
    }
  }
  return normalized || raw;
}

function cityMatches(geocodedCity: string, selectedCity: string): boolean {
  return Boolean(geocodedCity && selectedCity) && canonicalCity(geocodedCity) === canonicalCity(selectedCity);
}

function extractCity(address: AddressComponents, requestedCity?: string): string {
  const primaryNames = [address.city, address.town, address.municipality]
    .filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim());
  const secondaryNames = [address.county, address.state_district, address.village]
    .filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim());
  const names = [...primaryNames, ...secondaryNames];
  return (
    names.find((name) => requestedCity && cityMatches(name, requestedCity)) ||
    names[0] ||
    ""
  ).trim();
}

function candidateMatchesCity(address: AddressComponents, selectedCity: string): boolean {
  const primaryNames = [address.city, address.town, address.municipality]
    .filter((value): value is string => Boolean(value?.trim()));
  const secondaryNames = [address.county, address.state_district, address.village]
    .filter((value): value is string => Boolean(value?.trim()));

  // An explicit city/town takes precedence. A district match must not rescue
  // a result whose actual city is different.
  if (primaryNames.length > 0) {
    return primaryNames.some((name) => cityMatches(name, selectedCity));
  }
  return secondaryNames.some((name) => cityMatches(name, selectedCity));
}

function extractProvince(address: AddressComponents): string | null {
  return (
    address.state ||
    address.province ||
    address.state_district ||
    null
  )?.trim() || null;
}

function hasStreetLevelResult(address: AddressComponents): boolean {
  return Boolean(
    address.house_number ||
      address.road ||
      address.pedestrian ||
      address.residential,
  );
}

function formatCandidate(candidate: GeocodeCandidate): string {
  return String(candidate.display_name || "").trim();
}

function hasAddressEvidence(
  input: DeliveryAddressInput,
  candidate: GeocodeCandidate,
): boolean {
  const candidateText = normalize(
    [formatCandidate(candidate), ...Object.values(candidate.address || {})]
      .filter(Boolean)
      .join(" "),
  );
  const genericTokens = new Set([
    "house", "home", "street", "road", "main", "boulevard", "sector", "block", "phase", "plot", "flat", "shop",
    "village", "vill", "post", "office", "tehsil", "district", "near", "opposite",
    "beside", "mohalla", "mauza", "po", "p", "o", "general", "store", "madina",
  ]);
  const excludedTokens = new Set([
    ...normalize(String(input.city || "")).split(" "),
    ...normalize(String(input.province || "")).split(" "),
    String(input.zip || "").trim(),
  ]);
  const inputText = normalize([input.address1, input.address2].filter(Boolean).join(" "));
  const addressTokens = inputText
    .split(" ")
    .filter(
      (token) =>
        token &&
        !excludedTokens.has(token) &&
        !genericTokens.has(token) &&
        (token.length >= 4 || /^\d+$/.test(token)),
    );

  const matchedTokens = addressTokens.filter((token) => candidateText.includes(token));
  const locationClues = inputText.match(/\b(?:sector|block|phase|g)\s*[a-z0-9-]+\b/g) || [];
  const matchedLocationClues = locationClues.filter((clue) => candidateText.includes(clue));
  const postalMatchesCandidate = Boolean(
    input.zip && candidate.address?.postcode && postalMatches(input.zip, candidate.address.postcode),
  );

  // One generic word such as “store” or “shop” is never enough. Accept two
  // independent clues, two location markers, or one distinctive landmark /
  // locality name (six or more characters) paired with the verified city.
  return (
    matchedTokens.length >= 2 ||
    matchedLocationClues.length >= 2 ||
    matchedTokens.some((token) => token.length >= 6) ||
    (postalMatchesCandidate && matchedTokens.length >= 1)
  );
}

function isRuralAddress(input: DeliveryAddressInput): boolean {
  const text = [input.address1, input.address2].filter(Boolean).join(" ");
  return /\b(village|vill|v\/o|p\.?\s*o\.?|post office|tehsil|district|mauza|mohalla|chak|killi|kalay|cheena|near|opposite|beside|shop|store|school|college|mosque|masjid|market|hospital|petrol)\b/i.test(text) ||
    !/\b\d{1,5}\b/.test(String(input.address1 || ""));
}

function originalAddress(input: DeliveryAddressInput): string {
  return [
    input.address1,
    input.address2,
    input.city,
    input.province,
    input.zip,
    input.country || "Pakistan",
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");
}

function postalOfficeFromInput(input: DeliveryAddressInput): string | null {
  const text = [input.address1, input.address2].filter(Boolean).join(" ");
  const match = text.match(/(?:p\.?\s*o\.?|post office)\s+([^,]+?)(?=\s+(?:tehsil|district)\b|,|$)/i);
  return match?.[1]?.trim() || null;
}

function queryFor(address: DeliveryAddressInput): string {
  return [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.zip,
    address.country || "Pakistan",
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");
}

function countryLooksPakistani(address: AddressComponents): boolean {
  const countryCode = normalize(address.country_code || "");
  const country = normalize(address.country || "");
  return (
    (!countryCode && !country) ||
    countryCode === "pk" ||
    country === "pakistan" ||
    country.includes("pakistan")
  );
}

function postalMatches(input: string, result: string): boolean {
  return normalize(input).replace(/ /g, "") === normalize(result).replace(/ /g, "");
}

function candidateResult(
  candidate: GeocodeCandidate,
  source: VerifiedAddress["source"],
  input: DeliveryAddressInput,
): AddressVerificationResult {
  const resultAddress = candidate.address ?? {};
  const formattedAddress = formatCandidate(candidate);
  const detectedCity = extractCity(resultAddress, String(input.city || ""));
  const cityMatchesRequested = candidateMatchesCity(resultAddress, String(input.city || ""));
  const ruralAddress = isRuralAddress(input);
  const streetLevel = hasStreetLevelResult(resultAddress);

  if (!formattedAddress || !detectedCity) {
    return {
      ok: false,
      code: "ADDRESS_AMBIGUOUS",
      message:
        "The address is incomplete or ambiguous. A street-level address could not be verified; no address was guessed.",
      detectedCity: detectedCity || undefined,
      suggestedAddress: formattedAddress || undefined,
    };
  }

  if (!cityMatchesRequested) {
    return {
      ok: false,
      code: "ADDRESS_CITY_MISMATCH",
      message:
        `Address mismatch: the verified result belongs to ${detectedCity}, not ${input.city}. ` +
        "No shipment was created.",
      detectedCity,
      suggestedAddress: formattedAddress,
    };
  }

  const addressEvidence = hasAddressEvidence(input, candidate);
  const warnings: string[] = [];
  if (!addressEvidence) {
    warnings.push(
      "The map result is broader than the supplied address details; the original customer address will be used.",
    );
  }

  if (!countryLooksPakistani(resultAddress)) {
    return {
      ok: false,
      code: "ADDRESS_AMBIGUOUS",
      message: "The address could not be verified as a Pakistan delivery address.",
      suggestedAddress: formattedAddress,
    };
  }

  const inputZip = input.zip?.trim();
  const resultZip = resultAddress.postcode?.trim();
  if (inputZip && ((streetLevel && !resultZip) || (resultZip && !postalMatches(inputZip, resultZip)))) {
    if (resultZip && !postalMatches(inputZip, resultZip)) {
      warnings.push(
        `The map provider returned postal code ${resultZip}, while the customer supplied ${inputZip}.`,
      );
    } else if (!resultZip && streetLevel) {
      warnings.push(`The map provider could not confirm postal code ${inputZip}.`);
    }

    return {
      ok: true,
      verifiedAddress: {
        formattedAddress: originalAddress(input),
        city: String(input.city).trim(),
        province: extractProvince(resultAddress) || input.province?.trim() || null,
        postalCode: inputZip,
        source,
        confidence: "locality",
        warning: `${warnings.join(" ")} The city matches, so the original customer address will be used.`,
      },
    };
  }

  if (!streetLevel) {
    if (!ruralAddress || !addressEvidence) {
      return {
        ok: false,
        code: "ADDRESS_AMBIGUOUS",
        message:
          "The address is incomplete or ambiguous. A street-level address could not be verified; no address was guessed.",
        detectedCity,
        suggestedAddress: formattedAddress,
      };
    }

    return {
      ok: true,
      verifiedAddress: {
        // Preserve the merchant's complete rural address; never replace it
        // with a broad village or road result from the map provider.
        formattedAddress: originalAddress(input),
        city: String(input.city).trim(),
        province: extractProvince(resultAddress) || input.province?.trim() || null,
        postalCode: inputZip || resultZip || null,
        source,
        confidence: "locality",
        warning: warnings.length > 0 ? warnings.join(" ") : undefined,
      },
    };
  }

  return {
    ok: true,
    verifiedAddress: {
      formattedAddress: addressEvidence ? formattedAddress : originalAddress(input),
      city: detectedCity,
      province: extractProvince(resultAddress),
      postalCode: resultZip || null,
      source,
      confidence: addressEvidence ? "street" : "locality",
      warning: warnings.length > 0 ? warnings.join(" ") : undefined,
    },
  };
}

async function geocodeMapsCo(query: string): Promise<GeocodeCandidate[]> {
  const apiKey = process.env.GEOCODE_MAPS_API_KEY;
  if (!apiKey) return [];

  const url =
    `https://geocode.maps.co/search?q=${encodeURIComponent(query)}` +
    `&api_key=${encodeURIComponent(apiKey)}&format=json&limit=5&addressdetails=1&countrycodes=pk`;
  const response = await fetch(url, {
    headers: {"User-Agent": "InstaWorld-Booking/1.0"},
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return [];
  const results = (await response.json().catch(() => [])) as GeocodeCandidate[];
  return Array.isArray(results) ? results : [];
}

async function geocodeNominatim(query: string): Promise<GeocodeCandidate[]> {
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}` +
    "&format=json&limit=5&addressdetails=1&countrycodes=pk";
  const response = await fetch(url, {
    headers: {"User-Agent": "InstaWorld-Booking/1.0 (contact: admin@talwarstore.com)"},
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return [];
  const results = (await response.json().catch(() => [])) as GeocodeCandidate[];
  return Array.isArray(results) ? results : [];
}

export function validateGeocodeCandidate(
  candidate: GeocodeCandidate,
  input: DeliveryAddressInput,
  source: VerifiedAddress["source"] = "nominatim",
): AddressVerificationResult {
  return candidateResult(candidate, source, input);
}

/** Verify and normalize a Shopify delivery address. This is fail-closed. */
export async function verifyDeliveryAddress(
  input: DeliveryAddressInput,
): Promise<AddressVerificationResult> {
  const address1 = input.address1?.trim();
  const city = input.city?.trim();
  if (!address1 || !city) {
    return {
      ok: false,
      code: "ADDRESS_REQUIRED",
      message: "A complete street address and city are required before booking.",
    };
  }
  if (address1.length < 5) {
    return {
      ok: false,
      code: "ADDRESS_AMBIGUOUS",
      message: "The delivery address is too short to verify. Please enter the house/street address.",
    };
  }

  const fullQuery = queryFor(input);
  const locality = postalOfficeFromInput(input);
  const queries = [...new Set([
    fullQuery,
    queryFor({...input, zip: null}),
    locality && `${locality}, ${input.city}, ${input.province || ""}, ${input.country || "Pakistan"}`,
    `${input.city}, ${input.zip || ""}, ${input.country || "Pakistan"}`,
    ...[input.address1, input.address2]
      .filter((part): part is string => Boolean(part?.trim()))
      .flatMap((part) => part.split(/[,;]+/).map((segment) => `${segment.trim()}, ${input.city}, ${input.country || "Pakistan"}`)),
  ].filter((query): query is string => Boolean(query?.trim())))];
  const candidates: Array<{candidate: GeocodeCandidate; source: VerifiedAddress["source"]}> = [];

  for (const query of queries) {
    try {
      for (const candidate of await geocodeMapsCo(query)) {
        candidates.push({candidate, source: "geocode.maps.co"});
      }
    } catch {
      // Try the independent fallback provider below.
    }
  }

  for (const query of queries) {
    try {
      for (const candidate of await geocodeNominatim(query)) {
        candidates.push({candidate, source: "nominatim"});
      }
    } catch {
      // Keep trying other query forms/providers.
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      code: "ADDRESS_NOT_FOUND",
      message: "The address could not be verified using the available map data. It may be a valid rural or landmark address; add a recognizable landmark, village, road, or nearby shop name so it can be checked without guessing.",
    };
  }

  let bestFailure: AddressVerificationResult | null = null;
  for (const {candidate, source} of candidates) {
    const result = candidateResult(candidate, source, input);
    if (result.ok) return result;
    if (!bestFailure || result.code === "POSTAL_CODE_MISMATCH" || result.code === "ADDRESS_CITY_MISMATCH") {
      bestFailure = result;
    }
  }

  return bestFailure || {
    ok: false,
    code: "ADDRESS_NOT_FOUND",
    message: "The address could not be verified using the available map data. Add a recognizable landmark, village, road, or nearby shop name; no address was guessed.",
  };
}

/** Backward-compatible helper for callers that only need the error message. */
export async function verifyAddressCity(
  address: string | null | undefined,
  selectedCity: string | null | undefined,
): Promise<string | null> {
  const result = await verifyDeliveryAddress({address1: address, city: selectedCity});
  return result.ok ? null : result.message;
}
