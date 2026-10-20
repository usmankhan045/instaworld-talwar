import {useEffect} from "react";
import type {LoaderFunctionArgs} from "react-router";
import {useLoaderData, useRevalidator} from "react-router";

import prisma from "../db.server";
import {authenticate} from "../shopify.server";
import {isTerminalInstaWorldStatus} from "../lib/instaworld-shipments.server";

export async function loader({request}: LoaderFunctionArgs) {
  const {session} = await authenticate.admin(request);
  const now = new Date();
  const cutoff = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const [shipments, accounts, syncState] = await Promise.all([
    prisma.shipment.findMany({
      where: {
        shop: session.shop,
        trackingNumber: {not: null},
        OR: [
          {bookedAt: {lt: cutoff}},
          {bookedAt: null, createdAt: {lt: cutoff}},
        ],
      },
      select: {
        refNo: true,
        trackingNumber: true,
        instaworldStatus: true,
        instaworldAccountId: true,
        bookedAt: true,
        createdAt: true,
      },
    }),
    prisma.instaWorldAccount.findMany({
      where: {shop: session.shop},
      select: {id: true, name: true},
    }),
    prisma.syncState.findUnique({where: {shop: session.shop}, select: {lastSyncedAt: true}}),
  ]);
  const accountNames = new Map(accounts.map((account) => [account.id, account.name]));

  const overdue = shipments
    .filter((shipment) => !isTerminalInstaWorldStatus(shipment.instaworldStatus ?? ""))
    .map((shipment) => {
      const createdAt = shipment.bookedAt ?? shipment.createdAt;
      return {
        trackingNumber: shipment.trackingNumber!,
        reference: shipment.refNo,
        status: shipment.instaworldStatus ?? "AWAITING_SYNC",
        accountName: shipment.instaworldAccountId
          ? accountNames.get(shipment.instaworldAccountId) ?? "InstaWorld"
          : "InstaWorld",
        createdAt: createdAt.toISOString(),
        ageDays: Math.floor((now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000)),
      };
    })
    .sort((left, right) => right.ageDays - left.ageDays);

  return {
    overdue,
    checkedCount: shipments.length,
    checkedAt: syncState?.lastSyncedAt.toISOString() ?? null,
  };
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Karachi",
  }).format(new Date(value));
}

export default function OverdueOrders() {
  const {overdue, checkedCount, checkedAt} = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const isRefreshing = revalidator.state !== "idle";

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        void revalidator.revalidate();
      }
    };
    const interval = window.setInterval(refresh, 5 * 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [revalidator]);

  return <s-page heading="Overdue InstaWorld orders" inlineSize="base">
    <s-button slot="primary-action" variant="primary" loading={isRefreshing} onClick={() => revalidator.revalidate()}>Refresh list</s-button>
    <s-stack direction="block" gap="base">
      <s-banner heading={`${overdue.length} order${overdue.length === 1 ? "" : "s"} need attention`} tone={overdue.length ? "warning" : "success"}>
        {checkedAt ? `Last InstaWorld sync: ${displayDate(checkedAt)}.` : "Waiting for the first InstaWorld sync."} Checked {checkedCount} shipments older than three days. GitHub Actions syncs statuses every 15 minutes; this screen uses the saved results and never calls InstaWorld itself.
      </s-banner>
      <s-section heading="Orders to follow up">
        {overdue.length ? <s-table variant="auto" loading={isRefreshing}>
          <s-table-header-row>
            <s-table-header listSlot="primary">Order reference</s-table-header>
            <s-table-header>Tracking</s-table-header>
            <s-table-header>Status from InstaWorld</s-table-header>
            <s-table-header>Account</s-table-header>
            <s-table-header format="numeric">Age</s-table-header>
            <s-table-header>Booked</s-table-header>
          </s-table-header-row>
          <s-table-body>{overdue.map((shipment) => <s-table-row key={`${shipment.accountName}-${shipment.trackingNumber}`}>
            <s-table-cell>{shipment.reference}</s-table-cell>
            <s-table-cell><s-link href={`https://one-be.instaworld.pk/tracking/${encodeURIComponent(shipment.trackingNumber)}`} target="_blank">{shipment.trackingNumber}</s-link></s-table-cell>
            <s-table-cell><s-badge tone="warning">{shipment.status.replaceAll("_", " ")}</s-badge></s-table-cell>
            <s-table-cell>{shipment.accountName}</s-table-cell>
            <s-table-cell>{shipment.ageDays} days</s-table-cell>
            <s-table-cell>{displayDate(shipment.createdAt)}</s-table-cell>
          </s-table-row>)}</s-table-body>
        </s-table> : <s-box padding="large" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="base" alignItems="center">
            <s-heading>No overdue orders</s-heading>
            <s-paragraph>Every active InstaWorld shipment is either less than three days old or already complete.</s-paragraph>
          </s-stack>
        </s-box>}
      </s-section>
    </s-stack>
  </s-page>;
}
