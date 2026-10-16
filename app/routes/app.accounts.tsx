import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";
import {useFetcher, useLoaderData} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";
import {encryptSecret} from "../lib/secret-crypto.server";
import {discoverInstaWorldLocation} from "../lib/instaworld-accounts.server";

export async function loader({request}: LoaderFunctionArgs) {
  const {session} = await authenticate.admin(request);
  return {accounts: await prisma.instaWorldAccount.findMany({where: {shop: session.shop}, orderBy: [{isDefault: "desc"}, {createdAt: "asc"}], select: {id: true, name: true, locationId: true, mode: true, isDefault: true}})};
}

export async function action({request}: ActionFunctionArgs) {
  const {session} = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "create");
  if (intent === "delete") {
    await prisma.instaWorldAccount.deleteMany({where: {id: String(form.get("id")), shop: session.shop}});
  } else {
    const name = String(form.get("name") || "").trim();
    const apiKey = String(form.get("apiKey") || "").trim();
    if (!name || !apiKey) return Response.json({error: "Account name and API key are required."}, {status: 400});
    const count = await prisma.instaWorldAccount.count({where: {shop: session.shop}});
    const mode = "live";
    const baseUrl = String(form.get("baseUrl") || "https://api.instaworld.pk/v2");
    const locationId = await discoverInstaWorldLocation(apiKey, mode, baseUrl);
    await prisma.instaWorldAccount.create({data: {shop: session.shop, name, apiKeyEncrypted: encryptSecret(apiKey), locationId, baseUrl, mode, isDefault: count === 0}});
  }
  return Response.json({ok: true});
}

export default function Accounts() {
  const {accounts} = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  return <s-page heading="InstaWorld accounts" inlineSize="base">
    <s-section heading="Connect courier accounts">
      <s-paragraph>Add separate InstaWorld credentials for Talwar Store, Talwar Food, or any future brand. Booking screens will let you choose the account per shipment.</s-paragraph>
      <fetcher.Form method="post">
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-text-field label="Account name" name="name" placeholder="Talwar Food" required />
          <s-text-field label="InstaWorld API key" name="apiKey" required />
          <s-box padding="base" background="subdued" borderRadius="base"><s-text type="strong">Live account</s-text><s-paragraph tone="neutral">All connected accounts use the live InstaWorld API.</s-paragraph></s-box>
        </s-grid>
        <s-paragraph tone="neutral">We’ll verify the API key and automatically read the account’s pickup location.</s-paragraph>
        <s-button type="submit" variant="primary">Add account</s-button>
      </fetcher.Form>
    </s-section>
    <s-section heading="Connected accounts">
      {accounts.length === 0 ? <s-paragraph>No saved accounts yet. The existing environment configuration will continue to work as the fallback.</s-paragraph> : <s-table><s-table-header-row><s-table-header>Account</s-table-header><s-table-header>Mode</s-table-header><s-table-header>Location</s-table-header><s-table-header>Status</s-table-header><s-table-header>Action</s-table-header></s-table-header-row><s-table-body>{accounts.map((account) => <s-table-row key={account.id}><s-table-cell>{account.name}</s-table-cell><s-table-cell>{account.mode}</s-table-cell><s-table-cell>{account.locationId}</s-table-cell><s-table-cell><s-badge tone="success">Ready</s-badge>{account.isDefault ? " Default" : ""}</s-table-cell><s-table-cell><fetcher.Form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={account.id} /><s-button type="submit" tone="critical" variant="tertiary">Remove</s-button></fetcher.Form></s-table-cell></s-table-row>)}</s-table-body></s-table>}
    </s-section>
  </s-page>;
}
