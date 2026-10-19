import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";
import {useFetcher, useLoaderData} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";
import {encryptSecret} from "../lib/secret-crypto.server";
import {discoverInstaWorldAccount, listInstaWorldAccounts, resolveInstaWorldConfig} from "../lib/instaworld-accounts.server";
import {INSTAWORLD_API_BASE_URL} from "../lib/instaworld.server";
import styles from "../styles/ui.module.css";

type AccountActionData = {ok?: boolean; error?: string};

export async function loader({request}: LoaderFunctionArgs) {
  const {session} = await authenticate.admin(request);
  return {accounts: await listInstaWorldAccounts(session.shop)};
}

export async function action({request}: ActionFunctionArgs) {
  const {session} = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "create");
  try {
    if (intent === "delete") {
      const id = String(form.get("id") || "");
      await prisma.$transaction(async (tx) => {
        const account = await tx.instaWorldAccount.findFirst({where: {id, shop: session.shop}});
        if (!account) return;
        await tx.instaWorldAccount.delete({where: {id: account.id}});
        if (account.isDefault) {
          const replacement = await tx.instaWorldAccount.findFirst({
            where: {shop: session.shop},
            orderBy: {createdAt: "asc"},
            select: {id: true},
          });
          if (replacement) await tx.instaWorldAccount.update({where: {id: replacement.id}, data: {isDefault: true}});
        }
      });
    } else if (intent === "set-default") {
      const id = String(form.get("id") || "");
      const selected = await prisma.instaWorldAccount.findFirst({where: {id, shop: session.shop}, select: {id: true}});
      if (!selected) return Response.json({error: "That InstaWorld account was not found for this store."}, {status: 404});
      await prisma.$transaction([
        prisma.instaWorldAccount.updateMany({where: {shop: session.shop}, data: {isDefault: false}}),
        prisma.instaWorldAccount.update({where: {id: selected.id}, data: {isDefault: true}}),
      ]);
    } else if (intent === "refresh") {
      const id = String(form.get("id") || "");
      const config = await resolveInstaWorldConfig(session.shop, id);
      const snapshot = await discoverInstaWorldAccount(config.apiKey);
      await prisma.instaWorldAccount.update({
        where: {id: config.id},
        data: {
          name: snapshot.name,
          externalAccountId: snapshot.externalAccountId,
          locationId: snapshot.locationId,
          accountDetailsJson: JSON.stringify(snapshot.details),
          locationsJson: JSON.stringify(snapshot.locations),
          couriersJson: JSON.stringify(snapshot.couriers),
          lastSyncedAt: new Date(),
        },
      });
    } else {
      const apiKey = String(form.get("apiKey") || "").trim();
      if (!apiKey) return Response.json({error: "InstaWorld API key is required."}, {status: 400});
      const snapshot = await discoverInstaWorldAccount(apiKey);
      const count = await prisma.instaWorldAccount.count({where: {shop: session.shop}});
      const existing = await prisma.instaWorldAccount.findFirst({
        where: {
          shop: session.shop,
          OR: [
            ...(snapshot.externalAccountId ? [{externalAccountId: snapshot.externalAccountId}] : []),
            {name: snapshot.name},
          ],
        },
        select: {id: true},
      });
      const data = {
        name: snapshot.name,
        apiKeyEncrypted: encryptSecret(apiKey),
        locationId: snapshot.locationId,
        externalAccountId: snapshot.externalAccountId,
        accountDetailsJson: JSON.stringify(snapshot.details),
        locationsJson: JSON.stringify(snapshot.locations),
        couriersJson: JSON.stringify(snapshot.couriers),
        lastSyncedAt: new Date(),
        baseUrl: INSTAWORLD_API_BASE_URL,
        mode: "live",
      };
      if (existing) {
        await prisma.instaWorldAccount.update({where: {id: existing.id}, data});
      } else {
        await prisma.instaWorldAccount.create({data: {...data, shop: session.shop, isDefault: count === 0}});
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update the InstaWorld account.";
    if (/unique constraint/i.test(message)) {
      return Response.json({error: "An account with this name already exists for this store."}, {status: 409});
    }
    return Response.json({error: message}, {status: 400});
  }
  return Response.json({ok: true});
}

export default function Accounts() {
  const {accounts} = useLoaderData<typeof loader>();
  const fetcher = useFetcher<AccountActionData>();
  return <s-page heading="InstaWorld accounts" inlineSize="base">
    <div className={styles.pageContent}>
    <s-section heading="Connect courier accounts">
      <s-paragraph>Paste this store’s InstaWorld API key. The account name, pickup locations, and available couriers are read directly from InstaWorld.</s-paragraph>
      {fetcher.data?.ok && <div className={styles.statusMessage}><s-banner heading="Account connected" tone="success">The live InstaWorld account is ready to use.</s-banner></div>}
      {fetcher.data?.error && <div className={styles.statusMessage}><s-banner heading="Could not connect account" tone="critical">{fetcher.data.error}</s-banner></div>}
      <fetcher.Form method="post" className={styles.accountForm}>
        <s-grid gridTemplateColumns="1fr" gap="base">
          <s-text-field label="InstaWorld API key" name="apiKey" required />
        </s-grid>
        <div className={styles.helperCard}><s-box padding="base" background="subdued" borderRadius="base"><s-stack direction="inline" gap="base" alignItems="center"><s-badge tone="success">LIVE</s-badge><s-stack direction="block" gap="base"><s-text type="strong">Location detected automatically</s-text><s-text tone="neutral">We verify the API key and read the account’s pickup location from InstaWorld.</s-text></s-stack></s-stack></s-box></div>
        <s-paragraph tone="neutral">We’ll verify the API key and automatically read the account’s pickup location.</s-paragraph>
        <s-button type="submit" variant="primary" loading={fetcher.state !== "idle"}>Connect live account</s-button>
      </fetcher.Form>
    </s-section>
    <s-section heading="Connected accounts">
      {accounts.length === 0 ? <s-banner heading="Connect an account to start booking" tone="warning">This store cannot access another store’s credentials. Add its InstaWorld API key above.</s-banner> : <s-table><s-table-header-row><s-table-header>Account</s-table-header><s-table-header>Pickup locations</s-table-header><s-table-header>Couriers</s-table-header><s-table-header>Status</s-table-header><s-table-header>Action</s-table-header></s-table-header-row><s-table-body>{accounts.map((account) => <s-table-row key={account.id}><s-table-cell>{account.name}</s-table-cell><s-table-cell>{account.locations.map((location) => location.name || location.city || `Location ${location.id}`).join(", ")}</s-table-cell><s-table-cell>{account.couriers.length ? account.couriers.map((courier) => courier.name).join(", ") : "Assigned automatically by InstaWorld"}</s-table-cell><s-table-cell><s-badge tone="success">API connected</s-badge>{account.isDefault ? " Default" : ""}</s-table-cell><s-table-cell><s-stack direction="inline" gap="base"><fetcher.Form method="post"><input type="hidden" name="intent" value="refresh" /><input type="hidden" name="id" value={account.id} /><s-button type="submit" variant="tertiary">Refresh from API</s-button></fetcher.Form>{!account.isDefault && <fetcher.Form method="post"><input type="hidden" name="intent" value="set-default" /><input type="hidden" name="id" value={account.id} /><s-button type="submit" variant="tertiary">Make default</s-button></fetcher.Form>}<fetcher.Form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={account.id} /><s-button type="submit" tone="critical" variant="tertiary">Remove</s-button></fetcher.Form></s-stack></s-table-cell></s-table-row>)}</s-table-body></s-table>}
    </s-section>
    </div>
  </s-page>;
}
