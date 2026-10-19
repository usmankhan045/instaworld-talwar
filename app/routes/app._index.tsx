import type {LoaderFunctionArgs} from "react-router";
import {useLoaderData} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";
import {listInstaWorldAccounts} from "../lib/instaworld-accounts.server";

function accountDetailRows(details: Record<string, unknown>) {
  return Object.entries(details)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => ({label: key.replace(/_/g, " "), value: String(value)}));
}

export async function loader({request}: LoaderFunctionArgs) {
  const {session} = await authenticate.admin(request);
  const [shipments, accounts, recent] = await Promise.all([
    prisma.shipment.groupBy({where: {shop: session.shop}, by: ["status"], _count: {_all: true}}),
    listInstaWorldAccounts(session.shop),
    prisma.shipment.findMany({where: {shop: session.shop}, orderBy: {updatedAt: "desc"}, take: 5, select: {id: true, refNo: true, status: true, trackingNumber: true, updatedAt: true}}),
  ]);
  return {counts: Object.fromEntries(shipments.map((item) => [item.status, item._count._all])), accounts, recent: recent.map((item) => ({...item, updatedAt: item.updatedAt.toISOString()}))};
}

export default function Dashboard() {
  const {counts, accounts, recent} = useLoaderData<typeof loader>();
  const booked = (counts.booked || 0) + (counts.delivered || 0);
  return <s-page heading="InstaWorld control center" inlineSize="base">
    <s-box padding="base" background="subdued" borderRadius="base"><s-grid gridTemplateColumns="1.6fr 1fr" gap="base" alignItems="center"><s-stack direction="block" gap="base"><s-heading>Ship every order with confidence</s-heading><s-paragraph>Connect this store’s InstaWorld account, choose the right pickup account at booking time, and track every shipment from one workspace.</s-paragraph><s-stack direction="inline" gap="base"><s-button href="/app/accounts" variant="primary">Manage accounts</s-button><s-button href="/app/bulk-booking" variant="secondary">Book from CSV</s-button></s-stack></s-stack><s-box padding="base" background="base" borderRadius="base"><s-stack direction="block" gap="base"><s-text type="strong">Today’s focus</s-text><s-heading>{counts.reserved || 0} shipments</s-heading><s-paragraph tone="neutral">currently reserved or moving through booking</s-paragraph></s-stack></s-box></s-grid></s-box>
    <s-section heading="Your operation at a glance"><s-grid gridTemplateColumns="repeat(4, 1fr)" gap="base"><s-box padding="base" borderWidth="base" borderRadius="base"><s-text tone="neutral">Booked</s-text><s-heading>{booked}</s-heading><s-badge tone="success">Live</s-badge></s-box><s-box padding="base" borderWidth="base" borderRadius="base"><s-text tone="neutral">In progress</s-text><s-heading>{counts.reserved || 0}</s-heading><s-badge tone="info">Queue</s-badge></s-box><s-box padding="base" borderWidth="base" borderRadius="base"><s-text tone="neutral">Delivered</s-text><s-heading>{counts.delivered || 0}</s-heading><s-badge tone="success">Complete</s-badge></s-box><s-box padding="base" borderWidth="base" borderRadius="base"><s-text tone="neutral">Needs attention</s-text><s-heading>{(counts.failed || 0) + (counts.reconciling || 0)}</s-heading><s-badge tone="warning">Review</s-badge></s-box></s-grid></s-section>
    <s-grid gridTemplateColumns="1.3fr 1fr" gap="base"><s-section heading="Recent shipments"><s-table><s-table-header-row><s-table-header>Reference</s-table-header><s-table-header>Status</s-table-header><s-table-header>Tracking</s-table-header><s-table-header>Updated</s-table-header></s-table-header-row><s-table-body>{recent.length ? recent.map((shipment) => <s-table-row key={shipment.id}><s-table-cell>{shipment.refNo}</s-table-cell><s-table-cell><s-badge tone={shipment.status === "failed" ? "critical" : shipment.status === "delivered" ? "success" : "info"}>{shipment.status}</s-badge></s-table-cell><s-table-cell>{shipment.trackingNumber || "—"}</s-table-cell><s-table-cell>{shipment.updatedAt.slice(0, 16).replace("T", " ")}</s-table-cell></s-table-row>) : <s-table-row><s-table-cell>No shipments yet</s-table-cell><s-table-cell>—</s-table-cell><s-table-cell>—</s-table-cell><s-table-cell>—</s-table-cell></s-table-row>}</s-table-body></s-table></s-section><s-section heading="Connected InstaWorld account"><s-stack direction="block" gap="base">{accounts.length ? accounts.map((account) => <s-box key={account.id} padding="base" background="subdued" borderRadius="base"><s-stack direction="block" gap="base"><s-stack direction="inline" gap="base" alignItems="center"><s-avatar initials={account.name.slice(0, 2).toUpperCase()} /><s-stack direction="block" gap="base"><s-text type="strong">{account.name}</s-text>{account.externalAccountId && <s-text tone="neutral">Account ID: {account.externalAccountId}</s-text>}</s-stack>{account.isDefault && <s-badge tone="success">Active</s-badge>}</s-stack>{accountDetailRows(account.details).map((detail) => <s-text key={detail.label}>{detail.label}: {detail.value}</s-text>)}<s-text type="strong">Pickup locations</s-text>{account.locations.map((location) => <s-text key={location.id}>{location.name || `Location ${location.id}`}{location.address ? ` · ${location.address}` : ""}{location.city ? ` · ${location.city}` : ""}</s-text>)}<s-text type="strong">Available couriers</s-text>{account.couriers.length ? account.couriers.map((courier) => <s-text key={courier.id || courier.name}>{courier.name}{courier.status ? ` · ${courier.status}` : ""}</s-text>) : <s-text tone="neutral">InstaWorld will automatically assign an eligible courier enabled for this API account.</s-text>}<s-text tone="neutral">Last read from API: {account.lastSyncedAt.slice(0, 16).replace("T", " ")}</s-text></s-stack></s-box>) : <s-banner heading="Connect InstaWorld to begin" tone="warning">Open Accounts and paste this store’s InstaWorld API key.</s-banner>}<s-button href="/app/accounts" variant="tertiary">Manage or refresh API account</s-button></s-stack></s-section></s-grid>
  </s-page>;
}
