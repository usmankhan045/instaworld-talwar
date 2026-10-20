import {listInstaWorldAccounts, resolveInstaWorldConfig} from "./instaworld-accounts.server.ts";

type JsonRecord = Record<string, unknown>;

export type InstaWorldShipmentRecord = JsonRecord & {
  accountId: string;
  accountName: string;
};

export type InstaWorldShipmentListResult = {
  shipments: InstaWorldShipmentRecord[];
  warnings: string[];
};

const MAX_PAGE_ATTEMPTS = 3;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function wait(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchShipmentPage(url: string, apiKey: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {Authorization: `Bearer ${apiKey}`, Accept: "application/json"},
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < MAX_PAGE_ATTEMPTS) await wait(250 * 2 ** (attempt - 1));
  }
  throw lastError ?? new Error("InstaWorld request failed.");
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function readString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function instaWorldStatusCode(shipment: JsonRecord): string {
  const status = asRecord(shipment.status);
  return (readString(status ?? {}, ["code", "name", "label"])
    ?? readString(shipment, ["public_status_code", "public_status", "shipment_status", "status_code"])
    ?? (typeof shipment.status === "string" ? shipment.status : ""))
    .trim()
    .toUpperCase();
}

export function instaWorldTrackingNumber(shipment: JsonRecord): string {
  return readString(shipment, ["tracking_number", "tracking_no", "trackingNumber"]) ?? "";
}

export function instaWorldReference(shipment: JsonRecord): string {
  return readString(shipment, ["ref_no", "reference", "reference_number", "order_number"]) ?? "—";
}

export function instaWorldShipmentDate(shipment: JsonRecord): Date | null {
  const raw = readString(shipment, ["created_at", "booked_at", "booking_date", "createdAt"]);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isTerminalInstaWorldStatus(status: string): boolean {
  const normalized = status.toUpperCase();
  return normalized.includes("DELIVERED")
    || normalized.includes("CANCEL")
    || normalized === "RTO_RETURNED_TO_SHIPPER"
    || normalized === "RETURNED_TO_SHIPPER";
}

export function isOverdueInstaWorldShipment(
  shipment: JsonRecord,
  now = new Date(),
  fallbackDate?: Date | null,
): boolean {
  const status = instaWorldStatusCode(shipment);
  const createdAt = instaWorldShipmentDate(shipment) ?? fallbackDate ?? null;
  return Boolean(
    status
    && !isTerminalInstaWorldStatus(status)
    && createdAt
    && now.getTime() - createdAt.getTime() > 3 * 24 * 60 * 60 * 1000,
  );
}

export async function listAllInstaWorldShipments(shop: string): Promise<InstaWorldShipmentListResult> {
  const accounts = await listInstaWorldAccounts(shop);
  const results: InstaWorldShipmentRecord[] = [];
  const warnings: string[] = [];

  for (const account of accounts) {
    let config: Awaited<ReturnType<typeof resolveInstaWorldConfig>>;
    try {
      config = await resolveInstaWorldConfig(shop, account.id);
    } catch (error) {
      warnings.push(`${account.name}: account configuration unavailable (${errorMessage(error)}).`);
      continue;
    }
    let cursor: string | null = null;
    const seenCursors = new Set<string>();

    do {
      let response: Response;
      try {
        const params = new URLSearchParams({limit: "200"});
        if (cursor) params.set("cursor", cursor);
        response = await fetchShipmentPage(`${config.baseUrl}/shipments?${params}`, config.apiKey);
      } catch (error) {
        warnings.push(`${account.name}: shipment page unavailable after ${MAX_PAGE_ATTEMPTS} attempts (${errorMessage(error)}).`);
        break;
      }
      const payload = await response.json().catch(() => ({})) as {
        data?: unknown;
        meta?: {next_cursor?: unknown};
        error?: {message?: unknown; code?: unknown};
      };
      if (!response.ok) {
        const detail = payload.error?.message ?? payload.error?.code ?? `HTTP ${response.status}`;
        warnings.push(`${account.name}: InstaWorld declined the shipment lookup (${String(detail)}).`);
        break;
      }

      if (!Array.isArray(payload.data)) {
        warnings.push(`${account.name}: InstaWorld returned no shipment list on this page.`);
        break;
      }
      const page = payload.data.map(asRecord).filter(Boolean) as JsonRecord[];
      results.push(...page.map((shipment) => ({
        ...shipment,
        accountId: account.id,
        accountName: account.name,
      })));

      const nextCursor = typeof payload.meta?.next_cursor === "string" && payload.meta.next_cursor
        ? payload.meta.next_cursor
        : null;
      if (nextCursor && seenCursors.has(nextCursor)) {
        warnings.push(`${account.name}: InstaWorld repeated a shipment cursor; pagination stopped safely.`);
        break;
      }
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
  }

  return {shipments: results, warnings};
}
