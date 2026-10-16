import prisma from "../db.server";
import type {InstaWorldConfig} from "./instaworld.server";
import {decryptSecret, encryptSecret} from "./secret-crypto.server";

const DEFAULT_BASE_URL = "https://api.instaworld.pk/v2";

export async function discoverInstaWorldLocation(apiKey: string, mode: string, baseUrl = DEFAULT_BASE_URL): Promise<number> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/locations`, {
    headers: {Authorization: `Bearer ${apiKey}`, Accept: "application/json"},
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Could not connect this ${mode} InstaWorld account. Check the API key.`);
  const raw = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
  const location = raw.find((item: any) => Number(item?.id ?? item?.location_id) > 0);
  const locationId = Number(location?.id ?? location?.location_id);
  if (!Number.isInteger(locationId) || locationId <= 0) throw new Error("This InstaWorld API account did not return a usable location.");
  return locationId;
}

export async function listInstaWorldAccounts(shop: string) {
  const stored = await prisma.instaWorldAccount.findMany({
    where: {shop}, orderBy: [{isDefault: "desc"}, {createdAt: "asc"}],
    select: {id: true, name: true, locationId: true, mode: true, isDefault: true},
  });
  return stored;
}

export async function resolveInstaWorldConfig(shop: string, accountId?: string): Promise<InstaWorldConfig & {id?: string; name?: string}> {
  const account = accountId
    ? await prisma.instaWorldAccount.findFirst({where: {id: accountId, shop}})
    : await prisma.instaWorldAccount.findFirst({where: {shop, isDefault: true}});
  if (account) return {id: account.id, name: account.name, account: "live", apiKey: decryptSecret(account.apiKeyEncrypted), baseUrl: account.baseUrl, locationId: account.locationId, refPrefix: ""};
  const {getInstaWorldConfig} = await import("./instaworld.server");
  return getInstaWorldConfig(shop);
}

export {encryptSecret};
