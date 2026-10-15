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
  CHARSADDA: ["charsadda", "chārsaddah"],
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

function cityMatches(geocodedCity: string, selectedCity: string): boolean {
  const geocoded = normalize(geocodedCity);
  const selected = normalize(selectedCity);
  if (!geocoded || !selected) return false;
  if (geocoded === selected || geocoded.includes(selected)) return true;

  const aliases = CITY_ALIASES[selectedCity.trim().toUpperCase()] ?? [];
  return aliases.some((alias) => {
    const normalizedAlias = normalize(alias);
    return geocoded === normalizedAlias || geocoded.includes(normalizedAlias);
  });
}

function extractCity(address: AddressComponents): string {
  return (
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.county ||
    address.state_district ||
    ""
  ).trim();
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
  const city = normalize(String(input.city || ""));
  const candidateText = normalize(
    [formatCandidate(candidate), ...Object.values(candidate.address || {})]
      .filter(Boolean)
      .join(" "),
  );
  const genericTokens = new Set(["house", "home", "street", "road", "block", "phase", "plot", "flat", "shop"]);
  const addressTokens = normalize(String(input.address1 || ""))
    .split(" ")
    .filter(
      (token) =>
        token &&
        token !== city &&
        !genericTokens.has(token) &&
        (token.length >= 3 || /^\d+$/.test(token)),
    );

  return addressTokens.length > 0 && addressTokens.some((token) => candidateText.includes(token));
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
  const detectedCity = extractCity(resultAddress);

  if (!formattedAddress || !detectedCity || !hasStreetLevelResult(resultAddress)) {
    return {
      ok: false,
      code: "ADDRESS_AMBIGUOUS",
      message:
        "The address is incomplete or ambiguous. A street-level address could not be verified; no address was guessed.",
      detectedCity: detectedCity || undefined,
      suggestedAddress: formattedAddress || undefined,
    };
  }

  if (!hasAddressEvidence(input, candidate)) {
    return {
      ok: false,
      code: "ADDRESS_AMBIGUOUS",
      message:
        "The geocoder found a nearby address, but it could not match the supplied street or house details. No address was guessed.",
      detectedCity,
      suggestedAddress: formattedAddress,
    };
  }

  if (!countryLooksPakistani(resultAddress)) {
    return {
      ok: false,
      code: "ADDRESS_AMBIGUOUS",
      message: "The address could not be verified as a Pakistan delivery address.",
      suggestedAddress: formattedAddress,
    };
  }

  if (!cityMatches(detectedCity, String(input.city))) {
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

  const inputZip = input.zip?.trim();
  const resultZip = resultAddress.postcode?.trim();
  if (inputZip && (!resultZip || !postalMatches(inputZip, resultZip))) {
    return {
      ok: false,
      code: "POSTAL_CODE_MISMATCH",
      message:
        `Postal-code mismatch: Shopify has ${inputZip}, but the verified address has ${resultZip || "no postal code"}. ` +
        "Please correct the address before booking.",
      detectedCity,
      suggestedAddress: formattedAddress,
    };
  }

  return {
    ok: true,
    verifiedAddress: {
      formattedAddress,
      city: detectedCity,
      province: extractProvince(resultAddress),
      postalCode: resultZip || null,
      source,
    },
  };
}

async function geocodeMapsCo(query: string): Promise<GeocodeCandidate | null> {
  const apiKey = process.env.GEOCODE_MAPS_API_KEY;
  if (!apiKey) return null;

  const url =
    `https://geocode.maps.co/search?q=${encodeURIComponent(query)}` +
    `&api_key=${encodeURIComponent(apiKey)}&format=json&limit=1&addressdetails=1&countrycodes=pk`;
  const response = await fetch(url, {
    headers: {"User-Agent": "InstaWorld-Booking/1.0"},
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const results = (await response.json().catch(() => [])) as GeocodeCandidate[];
  return Array.isArray(results) && results[0] ? results[0] : null;
}

async function geocodeNominatim(query: string): Promise<GeocodeCandidate | null> {
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}` +
    "&format=json&limit=1&addressdetails=1&countrycodes=pk";
  const response = await fetch(url, {
    headers: {"User-Agent": "InstaWorld-Booking/1.0 (contact: admin@talwarstore.com)"},
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return null;
  const results = (await response.json().catch(() => [])) as GeocodeCandidate[];
  return Array.isArray(results) && results[0] ? results[0] : null;
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

  const query = queryFor(input);
  let candidate: GeocodeCandidate | null = null;
  let source: VerifiedAddress["source"] = "nominatim";

  try {
    candidate = await geocodeMapsCo(query);
    if (candidate) source = "geocode.maps.co";
  } catch {
    // Try the independent fallback provider below.
  }

  if (!candidate) {
    try {
      candidate = await geocodeNominatim(query);
      source = "nominatim";
    } catch {
      return {
        ok: false,
        code: "ADDRESS_VERIFICATION_UNAVAILABLE",
        message: "Address verification is temporarily unavailable. No shipment was created; please try again.",
      };
    }
  }

  if (!candidate) {
    return {
      ok: false,
      code: "ADDRESS_NOT_FOUND",
      message: "The address could not be found. Please provide a more complete street address; no address was guessed.",
    };
  }

  return candidateResult(candidate, source, input);
}

/** Backward-compatible helper for callers that only need the error message. */
export async function verifyAddressCity(
  address: string | null | undefined,
  selectedCity: string | null | undefined,
): Promise<string | null> {
  const result = await verifyDeliveryAddress({address1: address, city: selectedCity});
  return result.ok ? null : result.message;
}
