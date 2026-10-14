/* eslint-disable @typescript-eslint/no-explicit-any */

export type InstaWorldShipment = {
  trackingNumber: string;
  raw: unknown;
};

/**
 * Internal request shape — matches the InstaWorld v2 CreateShipmentRequest schema exactly.
 * payment.type: "cod" | "paid"  (NOT "COD"/"PREPAID")
 * consignee: first_name (required), last_name (optional)
 * items: kg (not weight)
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

function getBaseUrl() {
  return process.env.INSTAWORLD_BASE_URL || "https://one-be.instaworld.pk/merchant-api/v2";
}

export function buildStableReference(operationId: string) {
  const prefix = process.env.INSTAWORLD_REF_PREFIX || "";
  // ref_no maxLength is 200 per spec — trim UUID to keep well within limit
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
 * API success responses are wrapped: { data: { tracking_number, ... } }
 * List responses:                    { data: [...], meta: {...} }
 * Error responses:                   { error: { code, message, details, request_id } }
 */
function extractTrackingNumber(payload: any): string | null {
  // Single shipment response: { data: { tracking_number } }
  const candidate = payload?.data;
  const trackingNumber =
    (typeof candidate === "object" && !Array.isArray(candidate) && candidate?.tracking_number) ||
    // List response (findByReference): { data: [ { tracking_number } ] }
    (Array.isArray(candidate) && candidate[0]?.tracking_number) ||
    null;
  return typeof trackingNumber === "string" && trackingNumber.length > 0 ? trackingNumber : null;
}

function extractErrorMessage(payload: any, status: number): string {
  // Spec: { error: { code, message, details, request_id } }
  const err = payload?.error;
  if (err?.message) return String(err.message);
  if (err?.code) return `InstaWorld error: ${err.code}`;
  return `InstaWorld booking failed with HTTP ${status}.`;
}

export async function findShipmentByReference(refNo: string): Promise<InstaWorldShipment | null> {
  validateReference(refNo);
  const response = await request(`/shipments?ref_no=${encodeURIComponent(refNo)}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`InstaWorld lookup failed with HTTP ${response.status}.`);
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
    payment: requestPayload.payment,  // { type: "cod"|"paid", amount: number }
    consignee: requestPayload.consignee,
    items: requestPayload.items,      // each item has { quantity, kg, title?, sku?, price? }
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
  // Response: { data: { tracking_number, ... } }
  const trackingNumber = extractTrackingNumber(payload);
  if (!trackingNumber) throw new Error("InstaWorld returned success without a tracking number.");
  return {trackingNumber, raw: payload.data};
}

/**
 * Payment type as required by InstaWorld v2 spec:
 *   COD orders  → "cod"
 *   Prepaid     → "paid"
 */
export function getPaymentType(treatment: "cod" | "prepaid"): "cod" | "paid" {
  return treatment === "cod" ? "cod" : "paid";
}

export function isContractConfirmed() {
  return true;
}
