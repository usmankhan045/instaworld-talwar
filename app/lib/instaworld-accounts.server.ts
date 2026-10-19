import prisma from "../db.server.ts";
import {INSTAWORLD_API_BASE_URL, type InstaWorldConfig} from "./instaworld.server.ts";
import {decryptSecret, encryptSecret} from "./secret-crypto.server.ts";

type JsonRecord = Record<string, unknown>;

export type InstaWorldLocationSummary = {
  id: number;
  name: string | null;
  address: string | null;
  city: string | null;
  isDefault: boolean;
};

export type InstaWorldCourierSummary = {
  id: string | null;
  name: string;
  status: string | null;
};

export type InstaWorldAccountSnapshot = {
  externalAccountId: string | null;
  name: string;
  locationId: number;
  details: JsonRecord;
  locations: InstaWorldLocationSummary[];
  couriers: InstaWorldCourierSummary[];
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function scalar(record: JsonRecord | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function findScalar(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 3) return null;
  const record = asRecord(value);
  const direct = scalar(record, keys);
  if (direct) return direct;
  if (!record) return null;
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") {
      const nested = findScalar(child, keys, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function sanitized(value: unknown, depth = 0): unknown {
  if (depth > 5) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitized(item, depth + 1));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !/(api.?key|token|secret|password|authorization)/i.test(key))
    .map(([key, child]) => [key, sanitized(child, depth + 1)]));
}

function dataRecords(payload: unknown): JsonRecord[] {
  const root = asRecord(payload);
  const data = root && "data" in root ? root.data : payload;
  if (Array.isArray(data)) return data.map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  const record = asRecord(data);
  return record ? [record] : [];
}

function nestedRecords(value: unknown, matchingKey: RegExp, depth = 0): JsonRecord[] {
  if (depth > 5) return [];
  if (Array.isArray(value)) return value.flatMap((item) => nestedRecords(item, matchingKey, depth + 1));
  const record = asRecord(value);
  if (!record) return [];
  const found: JsonRecord[] = [];
  for (const [key, child] of Object.entries(record)) {
    if (matchingKey.test(key)) found.push(...dataRecords(child));
    if (child && typeof child === "object") found.push(...nestedRecords(child, matchingKey, depth + 1));
  }
  return found;
}

async function accountResource(apiKey: string, path: string, required = false): Promise<unknown | null> {
  const response = await fetch(`${INSTAWORLD_API_BASE_URL}${path}`, {
    headers: {Authorization: `Bearer ${apiKey}`, Accept: "application/json"},
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => null);
  if (response.ok) return payload;
  if (!required) return null;
  throw new Error("Could not connect this InstaWorld account. Check the API key and try again.");
}

export async function discoverInstaWorldAccount(apiKey: string): Promise<InstaWorldAccountSnapshot> {
  const [profilePayload, locationsPayload] = await Promise.all([
    accountResource(apiKey, "/me", true),
    accountResource(apiKey, "/locations", true),
  ]);
  const locationRecords = [
    ...dataRecords(locationsPayload),
    ...nestedRecords(locationsPayload, /^(locations?|pickup_locations?)$/i),
  ];
  const locationMap = new Map<number, InstaWorldLocationSummary>();
  for (const location of locationRecords) {
    const id = Number(scalar(location, ["id", "location_id"]));
    if (!Number.isInteger(id) || id <= 0) continue;
    locationMap.set(id, {
      id,
      name: scalar(location, ["name", "title", "location_name", "pickup_name"]),
      address: scalar(location, ["address", "full_address", "pickup_address", "address_line_1"]),
      city: scalar(location, ["city", "city_name"]),
      isDefault: [location.is_default, location.default, location.isDefault].includes(true),
    });
  }
  const locations = [...locationMap.values()];
  if (locations.length === 0) throw new Error("This InstaWorld API key did not return a usable pickup location.");
  const selectedLocation = locations.find((location) => location.isDefault) || locations[0];

  const nestedCourierRecords = [
    ...nestedRecords(locationsPayload, /(couriers?|partners?|delivery_providers?)/i),
    ...nestedRecords(profilePayload, /(couriers?|partners?|delivery_providers?)/i),
  ];
  const courierMap = new Map<string, InstaWorldCourierSummary>();
  for (const courier of nestedCourierRecords) {
    const name = scalar(courier, ["name", "title", "courier_name", "company_name", "provider_name"]);
    if (!name) continue;
    const id = scalar(courier, ["id", "courier_id", "company_id", "provider_id"]);
    courierMap.set(id || name.toLowerCase(), {
      id,
      name,
      status: scalar(courier, ["status", "state"]) || (courier.active === true || courier.enabled === true ? "active" : null),
    });
  }

  const profileRecord = dataRecords(profilePayload)[0] || {};
  const externalAccountId = findScalar(profilePayload, ["merchant_id", "account_id", "id"])
    || findScalar(locationsPayload, ["merchant_id", "account_id"]);
  const accountName = findScalar(profilePayload, ["business_name", "merchant_name", "company_name", "name"])
    || findScalar(locationsPayload, ["business_name", "merchant_name", "company_name"])
    || selectedLocation.name
    || `InstaWorld account ${externalAccountId || selectedLocation.id}`;

  return {
    externalAccountId,
    name: accountName,
    locationId: selectedLocation.id,
    details: sanitized(profileRecord) as JsonRecord,
    locations,
    couriers: [...courierMap.values()],
  };
}

export async function listInstaWorldAccounts(shop: string) {
  const stored = await prisma.instaWorldAccount.findMany({
    where: {shop}, orderBy: [{isDefault: "desc"}, {createdAt: "asc"}],
    select: {
      id: true, name: true, locationId: true, mode: true, isDefault: true,
      externalAccountId: true, accountDetailsJson: true, locationsJson: true,
      couriersJson: true, lastSyncedAt: true,
    },
  });
  return stored.map((account) => ({
    ...account,
    details: JSON.parse(account.accountDetailsJson) as JsonRecord,
    locations: JSON.parse(account.locationsJson) as InstaWorldLocationSummary[],
    couriers: JSON.parse(account.couriersJson) as InstaWorldCourierSummary[],
    lastSyncedAt: account.lastSyncedAt.toISOString(),
  }));
}

export async function resolveInstaWorldConfig(shop: string, accountId?: string): Promise<InstaWorldConfig & {id?: string; name?: string}> {
  let account = accountId
    ? await prisma.instaWorldAccount.findFirst({where: {id: accountId, shop}})
    : await prisma.instaWorldAccount.findFirst({where: {shop, isDefault: true}});
  if (!account && !accountId) {
    account = await prisma.instaWorldAccount.findFirst({where: {shop}, orderBy: {createdAt: "asc"}});
  }
  if (!account) {
    throw new Error("No InstaWorld account is connected for this store. Open the Accounts page and connect this store's API key first.");
  }
  const apiKey = decryptSecret(account.apiKeyEncrypted).trim();
  if (!apiKey || !Number.isInteger(account.locationId) || account.locationId <= 0) {
    throw new Error("This store's InstaWorld account is incomplete. Reconnect it from the Accounts page.");
  }
  return {
    id: account.id,
    name: account.name,
    account: "live",
    apiKey,
    baseUrl: INSTAWORLD_API_BASE_URL,
    locationId: account.locationId,
    refPrefix: "",
  };
}

export {encryptSecret};
