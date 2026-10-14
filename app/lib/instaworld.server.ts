/* eslint-disable @typescript-eslint/no-explicit-any */

export type InstaWorldShipment = {
  trackingNumber: string;
  raw: unknown;
};

export type InstaWorldRequest = {
  refNo: string;
  payment: {type: string; amount: number};
  consignee: {name: string; phone: string; city: string; address: string};
  items: Array<{name: string; sku: string | null; quantity: number; weight: number}>;
  dispatchLocationId: number;
};

function getBaseUrl() {
  return process.env.INSTAWORLD_BASE_URL || "https://one-be.instaworld.pk/merchant-api/v2";
}

function contractConfig() {
  return {
    maxLength: Number(process.env.INSTAWORLD_REF_MAX_LENGTH) || 100,
    paymentType: process.env.INSTAWORLD_COD_PAYMENT_TYPE || "COD",
    prepaidPaymentType: process.env.INSTAWORLD_PREPAID_PAYMENT_TYPE || "PREPAID",
  };
}

export function buildStableReference(operationId: string) {
  return `${process.env.INSTAWORLD_REF_PREFIX || ""}${operationId}`;
}

export function validateReference(refNo: string) {
  const {maxLength} = contractConfig();
  if (!refNo || refNo.length > maxLength) {
    throw new Error(`The generated InstaWorld ref_no exceeds the max allowed length of ${maxLength}.`);
  }
}

function extractTrackingNumber(payload: any) {
  const trackingNumber =
    payload?.tracking_number ||
    payload?.trackingNumber ||
    payload?.shipment?.tracking_number ||
    payload?.shipment?.trackingNumber;
  return typeof trackingNumber === "string" && trackingNumber.length > 0 ? trackingNumber : null;
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

export async function findShipmentByReference(refNo: string): Promise<InstaWorldShipment | null> {
  validateReference(refNo);
  const response = await request(`/shipments?ref_no=${encodeURIComponent(refNo)}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`InstaWorld lookup failed with HTTP ${response.status}.`);
  const candidate = Array.isArray(payload)
    ? payload[0]
    : payload?.shipment || payload?.data?.[0] || payload?.data;
  const trackingNumber = extractTrackingNumber(candidate);
  return trackingNumber ? {trackingNumber, raw: candidate} : null;
}

export async function createShipment(
  requestPayload: InstaWorldRequest,
  idempotencyKey: string,
): Promise<InstaWorldShipment> {
  validateReference(requestPayload.refNo);
  const response = await request("/shipments", {
    method: "POST",
    headers: {"Idempotency-Key": idempotencyKey},
    body: JSON.stringify({
      ref_no: requestPayload.refNo,
      dispatch_location_id: requestPayload.dispatchLocationId,
      payment: requestPayload.payment,
      consignee: requestPayload.consignee,
      items: requestPayload.items,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      String(payload?.message || payload?.error || `InstaWorld booking failed with HTTP ${response.status}.`),
    );
    Object.assign(error, {status: response.status, code: payload?.code});
    throw error;
  }
  const trackingNumber = extractTrackingNumber(payload);
  if (!trackingNumber) throw new Error("InstaWorld returned success without a tracking number.");
  return {trackingNumber, raw: payload};
}

export function getPaymentType(treatment: "cod" | "prepaid") {
  const {paymentType, prepaidPaymentType} = contractConfig();
  return treatment === "cod" ? paymentType : prepaidPaymentType;
}

export function isContractConfirmed() {
  return true;
}
