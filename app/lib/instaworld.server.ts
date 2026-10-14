/* eslint-disable @typescript-eslint/no-explicit-any */

export type InstaWorldShipment = {
  trackingNumber: string;
  raw: unknown;
};

/**
 * Matches InstaWorld v2 CreateShipmentRequest schema exactly.
 * payment.type: "cod" | "paid"
 * consignee.first_name is required
 * items use kg (not weight)
 */
export type InstaWorldRequest = {
  refNo: string | null;
  locationId: number;
  payment: {type: "cod" | "paid"; amount: number};
  consignee: {
    first_name: string;
    last_name?: string;
    phone: string;
    address: string;
    city: string;
    email?: string;
  };
  items: Array<{title?: string; sku?: string | null; quantity: number; kg: number; price?: number}>;
};

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a Pakistani phone number to InstaWorld-accepted format.
 * Accepts: 03001234567 | +923001234567 | 923001234567 | 3001234567
 * Always outputs: 03001234567  (11 digits, leading 0)
 * Falls back to the raw value if it cannot be parsed — InstaWorld will
 * return a clear `invalid_phone` error in that case.
 */
export function normalisePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  // Strip everything except digits and leading +
  const stripped = raw.replace(/[^\d+]/g, "");

  // Already in +92XXXXXXXXXX format → convert to 0XXXXXXXXXX
  if (/^\+92\d{10}$/.test(stripped)) {
    return "0" + stripped.slice(3);
  }
  // +92 with wrong digit count — keep + strip
  if (stripped.startsWith("+92")) {
    return "0" + stripped.slice(3);
  }
  // 92XXXXXXXXXX (no +) → 0XXXXXXXXXX
  if (/^92\d{10}$/.test(stripped)) {
    return "0" + stripped.slice(2);
  }
  // 03XXXXXXXXX — standard Pakistani format, keep as-is
  if (/^0\d{10}$/.test(stripped)) {
    return stripped;
  }
  // 3XXXXXXXXX (10 digits starting with 3) → prepend 0
  if (/^3\d{9}$/.test(stripped)) {
    return "0" + stripped;
  }
  // Unknown format — return raw digits; InstaWorld will surface the exact error
  return stripped || raw.trim();
}

/**
 * Normalise a city name to match InstaWorld's exact city list.
 * InstaWorld cities are UPPERCASE e.g. LAHORE, KARACHI, RAHIM YAR KHAN.
 * We also fix common alternate spellings used in Shopify shipping addresses.
 */
export function normaliseCity(raw: string | null | undefined): string {
  if (!raw) return "";
  let city = raw.trim().toUpperCase();

  // Common alternate spellings / abbreviations seen in Pakistani Shopify stores
  const aliases: Record<string, string> = {
    "RAHIMYAR KHAN": "RAHIM YAR KHAN",
    "RAHIM YAR KHAN": "RAHIM YAR KHAN",
    "RYK": "RAHIM YAR KHAN",
    "DGK": "DERA GHAZI KHAN",
    "DERA GHAZI KHAN": "DERA GHAZI KHAN",
    "D.G. KHAN": "DERA GHAZI KHAN",
    "D G KHAN": "DERA GHAZI KHAN",
    "DGIVKHAN": "DERA GHAZI KHAN",
    "DERA ISMAIL KHAN": "DERA ISMAIL KHAN",
    "D.I. KHAN": "DERA ISMAIL KHAN",
    "DIK": "DERA ISMAIL KHAN",
    "ISB": "ISLAMABAD",
    "LHR": "LAHORE",
    "KHI": "KARACHI",
    "KHI.": "KARACHI",
    "PEW": "PESHAWAR",
    "PESH": "PESHAWAR",
    "MULTAN CITY": "MULTAN",
    "RAWALPINDI": "RAWALPINDI",
    "RWP": "RAWALPINDI",
    "PINDI": "RAWALPINDI",
    "GUJRANWALA": "GUJRANWALA",
    "GUJRAT": "GUJRAT",
    "SIALKOT": "SIALKOT",
    "FAISALABAD": "FAISALABAD",
    "FSD": "FAISALABAD",
    "BAHAWALPUR": "BAHAWALPUR",
    "BWP": "BAHAWALPUR",
    "SARGODHA": "SARGODHA",
    "SAHIWAL": "SAHIWAL",
    "SHEIKHUPURA": "SHEIKHUPURA",
    "KASUR": "KASUR",
    "OKARA": "OKARA",
    "NAROWAL": "NAROWAL",
    "HAFIZABAD": "HAFIZABAD",
    "MANDI BAHAUDDIN": "MANDI BAHAUDDIN",
    "M.B. DIN": "MANDI BAHAUDDIN",
    "CHINIOT": "CHINIOT",
    "JHANG": "JHANG",
    "TOBA TEK SINGH": "TOBA TEK SINGH",
    "T.T. SINGH": "TOBA TEK SINGH",
    "VEHARI": "VEHARI",
    "KHANEWAL": "KHANEWAL",
    "LODHRAN": "LODHRAN",
    "PAKPATTAN": "PAKPATTAN",
    "MUZAFFARGARH": "MUZAFFARGARH",
    "LAYYAH": "LAYYAH",
    "RAJANPUR": "RAJANPUR",
    "DADU": "DADU",
    "HYDERABAD": "HYDERABAD",
    "SUKKUR": "SUKKUR",
    "LARKANA": "LARKANA",
    "NAWABSHAH": "NAWABSHAH",
    "MIRPURKHAS": "MIRPURKHAS",
    "MIRPUR KHAS": "MIRPURKHAS",
    "JACOBABAD": "JACOBABAD",
    "SHIKARPUR": "SHIKARPUR",
    "KHAIRPUR": "KHAIRPUR",
    "SANGHAR": "SANGHAR",
    "QUETTA": "QUETTA",
    "TURBAT": "TURBAT",
    "GWADAR": "GWADAR",
    "HUB": "HUB",
    "ABBOTTABAD": "ABBOTTABAD",
    "MANSEHRA": "MANSEHRA",
    "MARDAN": "MARDAN",
    "SWAT": "SWAT",
    "SWABI": "SWABI",
    "NOWSHERA": "NOWSHERA",
    "CHARSADDA": "CHARSADDA",
    "KOHAT": "KOHAT",
    "BANNU": "BANNU",
    "MUZAFFARABAD": "MUZAFFARABAD",
    "MIRPUR": "MIRPUR",
    "KOTLI": "KOTLI",
  };

  return aliases[city] ?? city;
}

/**
 * Truncate a string to a max byte/char length, trimming at a word boundary.
 */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max).replace(/\s+\S*$/, "").trim() || value.slice(0, max).trim();
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

function getBaseUrl() {
  return process.env.INSTAWORLD_BASE_URL || "https://one-be.instaworld.pk/merchant-api/v2";
}

export function buildStableReference(operationId: string): string {
  const prefix = process.env.INSTAWORLD_REF_PREFIX || "";
  return `${prefix}${operationId}`.slice(0, 200);
}

export function validateReference(refNo: string | null) {
  if (!refNo || refNo.length > 200) {
    throw new Error("The generated InstaWorld ref_no is empty or exceeds 200 characters.");
  }
}

async function request(path: string, init?: RequestInit) {
  const apiKey = process.env.INSTAWORLD_API_KEY;
  if (!apiKey) throw new Error("INSTAWORLD_API_KEY is not configured.");
  return fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

/**
 * Extract a user-friendly error message from InstaWorld's error envelope.
 * Spec: { error: { code, message, details: [{field, issue}], request_id } }
 */
function extractErrorMessage(payload: any, status: number): string {
  const err = payload?.error;
  if (!err) return `InstaWorld returned HTTP ${status}.`;

  // Field-level validation errors → list them clearly
  if (Array.isArray(err.details) && err.details.length > 0) {
    const fieldErrors = err.details
      .map((d: any) => (d.field ? `${d.field}: ${d.issue ?? "invalid"}` : d.issue ?? JSON.stringify(d)))
      .join("; ");
    return `InstaWorld validation failed — ${fieldErrors}`;
  }

  if (err.message) return String(err.message);
  if (err.code) {
    // Map known codes to friendly messages
    const codeMessages: Record<string, string> = {
      city_not_serviceable: "The destination city is not serviceable by InstaWorld.",
      invalid_phone: "The consignee phone number is invalid. Please update the shipping address.",
      location_not_owned: "The configured InstaWorld location ID does not belong to your account.",
      invalid_api_key: "InstaWorld API key is invalid or revoked. Please update INSTAWORLD_API_KEY.",
      account_inactive: "Your InstaWorld account is inactive.",
      booking_failed: "No courier accepted the shipment. Please try again in a few minutes.",
      rate_limited: "InstaWorld rate limit reached. Please wait a moment and try again.",
    };
    return codeMessages[err.code] ?? `InstaWorld error: ${err.code}`;
  }
  return `InstaWorld returned HTTP ${status}.`;
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

export async function findShipmentByReference(refNo: string): Promise<InstaWorldShipment | null> {
  validateReference(refNo);
  const response = await request(`/shipments?ref_no=${encodeURIComponent(refNo)}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(extractErrorMessage(payload, response.status));
  // Response: { data: [ {...} ], meta: {...} }
  const list = Array.isArray(payload?.data) ? payload.data : [];
  const candidate = list[0];
  if (!candidate?.tracking_number) return null;
  return {trackingNumber: String(candidate.tracking_number), raw: candidate};
}

export async function createShipment(
  requestPayload: InstaWorldRequest,
  idempotencyKey: string,
): Promise<InstaWorldShipment> {
  validateReference(requestPayload.refNo);
  const body: Record<string, unknown> = {
    location_id: requestPayload.locationId,
    payment: requestPayload.payment,
    consignee: requestPayload.consignee,
    items: requestPayload.items,
  };
  if (requestPayload.refNo) body.ref_no = requestPayload.refNo;

  const response = await request("/shipments", {
    method: "POST",
    headers: {"Idempotency-Key": idempotencyKey},
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = extractErrorMessage(payload, response.status);
    const error = new Error(message);
    Object.assign(error, {status: response.status, code: payload?.error?.code});
    throw error;
  }

  // Success response: { data: { tracking_number, ... } }
  const data = payload?.data;
  const trackingNumber =
    typeof data === "object" && !Array.isArray(data) && typeof data?.tracking_number === "string"
      ? data.tracking_number
      : null;
  if (!trackingNumber) throw new Error("InstaWorld returned success without a tracking number.");
  return {trackingNumber, raw: data};
}

/**
 * Payment type per InstaWorld v2 spec enum: "cod" | "paid"
 */
export function getPaymentType(treatment: "cod" | "prepaid"): "cod" | "paid" {
  return treatment === "cod" ? "cod" : "paid";
}

export function isContractConfirmed() {
  return true;
}

