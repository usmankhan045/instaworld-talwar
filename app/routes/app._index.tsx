import type {LoaderFunctionArgs} from "react-router";
import {useLoaderData} from "react-router";

import prisma from "../db.server";
import {listInstaWorldAccounts} from "../lib/instaworld-accounts.server";
import {isTerminalInstaWorldStatus} from "../lib/instaworld-shipments.server";
import {authenticate} from "../shopify.server";

const DAY_MS = 24 * 60 * 60 * 1000;

function displayDate(value: string | null) {
  if (!value) return "Not synced yet";
  return new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Karachi",
  }).format(new Date(value));
}

function displayStatus(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTone(status: string): "success" | "critical" | "warning" | "info" | "neutral" {
  const normalized = status.toUpperCase();
  if (normalized.includes("DELIVERED")) return "success";
  if (normalized.includes("CANCEL") || normalized.includes("RETURNED")) return "neutral";
  if (normalized.includes("FAILED") || normalized.includes("ACTION_REQUIRED") || normalized.includes("HOLD")) return "critical";
  if (normalized.includes("BOOK") || normalized.includes("TRANSIT") || normalized.includes("PICKED") || normalized.includes("DELIVERY")) return "info";
  return "warning";
}

export async function loader({request}: LoaderFunctionArgs) {
  const {session} = await authenticate.admin(request);
  const now = new Date();
  const overdueCutoff = new Date(now.getTime() - 3 * DAY_MS);
  const [accounts, shipments, recent, syncState] = await Promise.all([
    listInstaWorldAccounts(session.shop),
    prisma.shipment.findMany({
      where: {shop: session.shop, trackingNumber: {not: null}},
      select: {id: true, status: true, instaworldStatus: true, bookedAt: true, createdAt: true},
    }),
    prisma.shipment.findMany({
      where: {shop: session.shop},
      orderBy: {updatedAt: "desc"},
      take: 8,
      select: {
        id: true,
        refNo: true,
        status: true,
        instaworldStatus: true,
        trackingNumber: true,
        bookedAt: true,
        updatedAt: true,
      },
    }),
    prisma.syncState.findUnique({where: {shop: session.shop}, select: {lastSyncedAt: true}}),
  ]);

  const active = shipments.filter((shipment) => !isTerminalInstaWorldStatus(shipment.instaworldStatus ?? ""));
  const delivered = shipments.filter((shipment) => (shipment.instaworldStatus ?? "").toUpperCase().includes("DELIVERED"));
  const overdue = active.filter((shipment) => (shipment.bookedAt ?? shipment.createdAt) < overdueCutoff);
  const bookingIssues = shipments.filter((shipment) => ["failed", "reconciling"].includes(shipment.status)).length;

  return {
    accounts,
    stats: {
      total: shipments.length,
      active: active.length,
      delivered: delivered.length,
      overdue: overdue.length,
      needsAttention: overdue.length + bookingIssues,
    },
    recent: recent.map((shipment) => ({
      ...shipment,
      displayStatus: shipment.instaworldStatus ?? shipment.status,
      bookedAt: shipment.bookedAt?.toISOString() ?? null,
      updatedAt: shipment.updatedAt.toISOString(),
    })),
    lastShipmentSyncAt: syncState?.lastSyncedAt.toISOString() ?? null,
  };
}

export default function Dashboard() {
  const {accounts, stats, recent, lastShipmentSyncAt} = useLoaderData<typeof loader>();

  return <s-page heading="InstaWorld control center" inlineSize="base">
    <s-stack direction="block" gap="large">
      <s-section heading="Connected InstaWorld account">
        {accounts.length ? <s-grid gridTemplateColumns="repeat(auto-fit, minmax(320px, 1fr))" gap="base">
          {accounts.map((account) => {
            const location = account.locations.find((item) => item.isDefault) ?? account.locations[0];
            return <s-box key={account.id} padding="large" background="subdued" border="base" borderRadius="large">
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-avatar initials={account.name.slice(0, 2).toUpperCase()} size="large" />
                  <s-stack direction="block" gap="small-200">
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-heading>{account.name}</s-heading>
                      <s-badge tone="success">Connected</s-badge>
                      {account.isDefault && <s-badge tone="info">Default</s-badge>}
                    </s-stack>
                    <s-text tone="neutral">Account ID: {account.externalAccountId || "Not provided"}</s-text>
                  </s-stack>
                </s-stack>

                <s-grid gridTemplateColumns="repeat(auto-fit, minmax(190px, 1fr))" gap="base">
                  <s-box padding="base" background="base" borderRadius="base">
                    <s-stack direction="block" gap="small-200">
                      <s-text type="strong">Pickup location</s-text>
                      <s-text>{location?.name || `Location ${account.locationId}`}</s-text>
                      <s-text tone="neutral">{[location?.address, location?.city].filter(Boolean).join(" · ") || "Address not available"}</s-text>
                    </s-stack>
                  </s-box>
                  <s-box padding="base" background="base" borderRadius="base">
                    <s-stack direction="block" gap="small-200">
                      <s-text type="strong">Courier availability</s-text>
                      <s-text>{account.couriers.length ? `${account.couriers.length} courier${account.couriers.length === 1 ? "" : "s"} available` : "Assigned automatically"}</s-text>
                      <s-text tone="neutral">{account.couriers.length ? account.couriers.map((courier) => courier.name).join(", ") : "InstaWorld selects an eligible courier at booking."}</s-text>
                    </s-stack>
                  </s-box>
                  <s-box padding="base" background="base" borderRadius="base">
                    <s-stack direction="block" gap="small-200">
                      <s-text type="strong">Status synchronization</s-text>
                      <s-text>{displayDate(lastShipmentSyncAt)}</s-text>
                      <s-text tone="neutral">Automatically checked every 15 minutes</s-text>
                      <s-text tone="neutral">Account profile refreshed {displayDate(account.lastSyncedAt)}</s-text>
                    </s-stack>
                  </s-box>
                </s-grid>

                <s-stack direction="inline" gap="base">
                  <s-button href="/app/accounts" variant="secondary">Manage account</s-button>
                  <s-button href="/app/bulk-booking" variant="primary">Book shipments</s-button>
                </s-stack>
              </s-stack>
            </s-box>;
          })}
        </s-grid> : <s-banner heading="Connect InstaWorld to begin" tone="warning">
          Add this store’s InstaWorld API key to start booking and monitoring shipments.
          <s-button href="/app/accounts" slot="secondary-actions">Connect account</s-button>
        </s-banner>}
      </s-section>

      {stats.overdue > 0 && <s-banner heading={`${stats.overdue} overdue order${stats.overdue === 1 ? "" : "s"} need follow-up`} tone="warning">
        These shipments are more than three days old and InstaWorld has not marked them delivered, cancelled, or returned.
        <s-button href="/app/overdue-orders" slot="secondary-actions">Review overdue orders</s-button>
      </s-banner>}

      <s-section heading="Delivery overview">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(190px, 1fr))" gap="base">
          <s-box padding="large" border="base" borderRadius="large"><s-stack direction="block" gap="small-200"><s-text tone="neutral">Tracked shipments</s-text><s-heading>{stats.total}</s-heading><s-text tone="neutral">Booked through this app</s-text></s-stack></s-box>
          <s-box padding="large" border="base" borderRadius="large"><s-stack direction="block" gap="small-200"><s-text tone="neutral">Active deliveries</s-text><s-heading>{stats.active}</s-heading><s-badge tone="info">In progress</s-badge></s-stack></s-box>
          <s-box padding="large" border="base" borderRadius="large"><s-stack direction="block" gap="small-200"><s-text tone="neutral">Delivered</s-text><s-heading>{stats.delivered}</s-heading><s-badge tone="success">Complete</s-badge></s-stack></s-box>
          <s-box padding="large" border="base" borderRadius="large" background={stats.needsAttention ? "subdued" : "base"}><s-stack direction="block" gap="small-200"><s-text tone="neutral">Needs attention</s-text><s-heading>{stats.needsAttention}</s-heading><s-badge tone={stats.needsAttention ? "warning" : "success"}>{stats.needsAttention ? "Review" : "All clear"}</s-badge></s-stack></s-box>
        </s-grid>
      </s-section>

      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(320px, 1fr))" gap="base">
        <s-section heading="Recent shipments">
          <s-table variant="auto">
            <s-table-header-row><s-table-header listSlot="primary">Reference</s-table-header><s-table-header>Status</s-table-header><s-table-header>Tracking</s-table-header><s-table-header>Booked</s-table-header></s-table-header-row>
            <s-table-body>{recent.length ? recent.map((shipment) => <s-table-row key={shipment.id}>
              <s-table-cell>{shipment.refNo}</s-table-cell>
              <s-table-cell><s-badge tone={statusTone(shipment.displayStatus)}>{displayStatus(shipment.displayStatus)}</s-badge></s-table-cell>
              <s-table-cell>{shipment.trackingNumber ? <s-link href={`https://one-be.instaworld.pk/tracking/${encodeURIComponent(shipment.trackingNumber)}`} target="_blank">{shipment.trackingNumber}</s-link> : "—"}</s-table-cell>
              <s-table-cell>{displayDate(shipment.bookedAt ?? shipment.updatedAt)}</s-table-cell>
            </s-table-row>) : <s-table-row><s-table-cell>No shipments yet</s-table-cell><s-table-cell>—</s-table-cell><s-table-cell>—</s-table-cell><s-table-cell>—</s-table-cell></s-table-row>}</s-table-body>
          </s-table>
        </s-section>

        <s-section heading="Quick actions">
          <s-stack direction="block" gap="base">
            <s-box padding="base" background="subdued" borderRadius="base"><s-stack direction="block" gap="small-200"><s-text type="strong">Overdue monitoring</s-text><s-text tone="neutral">Follow up on active shipments older than three days.</s-text><s-button href="/app/overdue-orders" variant={stats.overdue ? "primary" : "secondary"}>View {stats.overdue} overdue</s-button></s-stack></s-box>
            <s-box padding="base" background="subdued" borderRadius="base"><s-stack direction="block" gap="small-200"><s-text type="strong">Bulk booking</s-text><s-text tone="neutral">Create multiple InstaWorld shipments from a prepared CSV.</s-text><s-button href="/app/bulk-booking" variant="secondary">Open bulk booking</s-button></s-stack></s-box>
            <s-text tone="neutral">Statuses are read by the worker from InstaWorld. Shopify fulfillment is only created during booking.</s-text>
          </s-stack>
        </s-section>
      </s-grid>
    </s-stack>
  </s-page>;
}
