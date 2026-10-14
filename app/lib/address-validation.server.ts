/**
 * Address–city validation helpers.
 *
 * Strategy:
 *  1. Try geocode.maps.co (free, 25 000 req/month, 5 req/sec, no CC needed).
 *     Requires GEOCODE_MAPS_API_KEY in .env (free sign-up at geocode.maps.co).
 *  2. Fall back to Nominatim (OpenStreetMap) — completely free, no key required,
 *     but rate-limited to 1 req/sec and less accurate for rural Pakistan.
 *  3. If both fail (timeout / network error), fail-open so bookings are not blocked.
 *
 * Returns null if the address is valid for the city, or an error string if not.
 */

/**
 * City aliases used when comparing the geocoded result against the selected city.
 * Keys are InstaWorld/normalised city names (uppercase).
 */
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

function cityMatches(geocodedCity: string, selectedCity: string): boolean {
  const gc = geocodedCity.trim().toLowerCase();
  const sel = selectedCity.trim().toUpperCase();

  // Direct match (case-insensitive)
  if (gc === sel.toLowerCase()) return true;

  // Check alias list for the selected city
  const aliases = CITY_ALIASES[sel] ?? [];
  if (aliases.some((alias) => gc.includes(alias) || alias.includes(gc))) return true;

  // Last resort: check if either string contains the other (handles "Islamabad Capital Territory" etc.)
  if (gc.includes(sel.toLowerCase()) || sel.toLowerCase().includes(gc)) return true;

  return false;
}

/** Extract city-level name from Nominatim/geocode.maps.co address component */
function extractCityFromAddress(addressObj: Record<string, string>): string {
  // Nominatim returns city > town > village > county in priority order
  return (
    addressObj.city ||
    addressObj.town ||
    addressObj.village ||
    addressObj.county ||
    addressObj.state_district ||
    ""
  );
}

/**
 * Geocode using geocode.maps.co (primary).
 * Free sign-up: https://geocode.maps.co — set GEOCODE_MAPS_API_KEY in .env
 */
async function geocodeMapsCo(address: string): Promise<string | null> {
  const apiKey = process.env.GEOCODE_MAPS_API_KEY;
  if (!apiKey) return null; // key not configured — skip

  const query = `${address}, Pakistan`;
  const url = `https://geocode.maps.co/search?q=${encodeURIComponent(query)}&api_key=${apiKey}&format=json&limit=1&addressdetails=1&countrycodes=pk`;

  const res = await fetch(url, {
    headers: {"User-Agent": "InstaWorld-Booking/1.0"},
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;

  const results: Array<{address?: Record<string, string>}> = await res.json().catch(() => []);
  if (!Array.isArray(results) || results.length === 0) return null;

  const addrObj = results[0]?.address ?? {};
  return extractCityFromAddress(addrObj);
}

/**
 * Geocode using OpenStreetMap Nominatim (fallback, no key needed).
 * Rate limit: 1 req/sec. We use a 5 s timeout.
 */
async function geocodeNominatim(address: string): Promise<string | null> {
  const query = `${address}, Pakistan`;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1&countrycodes=pk`;

  const res = await fetch(url, {
    headers: {"User-Agent": "InstaWorld-Booking/1.0 (contact: admin@talwarstore.com)"},
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return null;

  const results: Array<{address?: Record<string, string>}> = await res.json().catch(() => []);
  if (!Array.isArray(results) || results.length === 0) return null;

  const addrObj = results[0]?.address ?? {};
  return extractCityFromAddress(addrObj);
}

/**
 * Verify that `address` actually belongs to `selectedCity`.
 *
 * @returns null if valid (or if verification could not be performed — fail-open)
 * @returns An error message string if the address clearly belongs to a different city
 */
export async function verifyAddressCity(
  address: string | null | undefined,
  selectedCity: string | null | undefined,
): Promise<string | null> {
  if (!address || !selectedCity) return null; // can't check — fail-open

  const trimmedAddress = address.trim();
  const trimmedCity = selectedCity.trim().toUpperCase();
  if (!trimmedAddress || !trimmedCity) return null;

  try {
    // Try primary geocoder first, then fallback
    let geocodedCity: string | null = null;
    try {
      geocodedCity = await geocodeMapsCo(trimmedAddress);
    } catch {
      // primary failed — try fallback
    }
    if (!geocodedCity) {
      try {
        geocodedCity = await geocodeNominatim(trimmedAddress);
      } catch {
        // both failed — fail-open
        return null;
      }
    }

    if (!geocodedCity) return null; // no result — fail-open (address might be too rural)

    const valid = cityMatches(geocodedCity, trimmedCity);
    if (!valid) {
      return (
        `Address mismatch: the address "${trimmedAddress}" appears to be in ` +
        `${geocodedCity.charAt(0).toUpperCase() + geocodedCity.slice(1)}, ` +
        `not ${trimmedCity.charAt(0) + trimmedCity.slice(1).toLowerCase()}. ` +
        `Please check that the delivery address matches the selected city.`
      );
    }
  } catch {
    // Network / timeout / parse error — fail-open, don't block bookings
    return null;
  }

  return null; // address is valid for the city
}
