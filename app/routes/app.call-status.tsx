import type {LoaderFunctionArgs} from "react-router";
import {useLoaderData} from "react-router";

import prisma from "../db.server";
import {authenticate} from "../shopify.server";

const RECENT_JOB_LIMIT = 50;

function orderNumberFromSearch(value: string | null): string | null {
  if (!value) return null;
  const number = value.trim().replace(/^#/, "");
  return /^\d{1,32}$/.test(number) ? number : null;
}

export async function loader({request}: LoaderFunctionArgs) {
  const {session} = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("order")?.trim() || "";
  const orderNumber = orderNumberFromSearch(search);

  const jobs = search && !orderNumber ? [] : await prisma.callJob.findMany({
    where: {
      shop: session.shop,
      ...(orderNumber ? {shopifyOrderNumber: orderNumber} : {}),
    },
    orderBy: [{createdAt: "desc"}, {id: "desc"}],
    take: RECENT_JOB_LIMIT,
    select: {
      id: true,
      shopifyOrderNumber: true,
      customerName: true,
      productSummary: true,
      normalizedAddress: true,
      orderStatus: true,
      addressStatus: true,
      callStatus: true,
      attemptCount: true,
      bookingAttemptId: true,
      createdAt: true,
      attempts: {
        orderBy: [{attemptNumber: "desc"}],
        take: 1,
        select: {
          status: true,
          callResult: true,
          spokenAddressText: true,
          failureMessage: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
        },
      },
    },
  });

  return {
    search,
    invalidSearch: Boolean(search && !orderNumber),
    limited: !orderNumber && jobs.length === RECENT_JOB_LIMIT,
    jobs: jobs.map(({attempts, ...job}) => ({
      ...job,
      createdAt: job.createdAt.toISOString(),
      lastAttempt: attempts[0] ? {
        ...attempts[0],
        startedAt: attempts[0].startedAt?.toISOString() ?? null,
        completedAt: attempts[0].completedAt?.toISOString() ?? null,
        createdAt: attempts[0].createdAt.toISOString(),
      } : null,
    })),
  };
}

function label(value: string | null | undefined): string {
  return value?.replaceAll("_", " ") || "Pending";
}

function dateLabel(value: string | null | undefined): string {
  return value ? `${value.slice(0, 16).replace("T", " ")} UTC` : "—";
}

export default function CallStatus() {
  const {jobs, search, invalidSearch, limited} = useLoaderData<typeof loader>();

  return (
    <s-page heading="Order confirmation calls">
      <s-section heading="Find an order">
        <form method="get" action="/app/call-status">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
            <s-search-field label="Shopify order number" name="order" defaultValue={search} placeholder="For example, 1150" />
            <s-button type="submit" variant="primary">Search</s-button>
          </s-grid>
        </form>
        {search ? <s-link href="/app/call-status">Show recent orders</s-link> : null}
        {invalidSearch ? <s-paragraph>Enter the numeric Shopify order number, with or without #.</s-paragraph> : null}
      </s-section>

      <s-section heading={search ? "Matching call jobs" : "Recent call jobs"}>
        <s-paragraph>Call preparation is currently in dry-run mode. No telephone calls are placed by this view.</s-paragraph>
        {jobs.length === 0 && !invalidSearch ? <s-paragraph>No call job found for this order.</s-paragraph> : null}
        {limited ? <s-paragraph>Showing the 50 most recent jobs. Search by order number for older jobs.</s-paragraph> : null}
        {jobs.length ? (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Call status</s-table-header>
              <s-table-header>Confirmations</s-table-header>
              <s-table-header>Attempts</s-table-header>
              <s-table-header>Last attempt</s-table-header>
              <s-table-header>Booking</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {jobs.map((job) => (
                <s-table-row key={job.id}>
                  <s-table-cell><s-link href={`/app/call-status?order=${encodeURIComponent(job.shopifyOrderNumber)}`}>#{job.shopifyOrderNumber}</s-link></s-table-cell>
                  <s-table-cell>{job.customerName}</s-table-cell>
                  <s-table-cell>{label(job.callStatus)}</s-table-cell>
                  <s-table-cell>Order: {label(job.orderStatus)}; address: {label(job.addressStatus)}</s-table-cell>
                  <s-table-cell>{job.attemptCount}</s-table-cell>
                  <s-table-cell>{dateLabel(job.lastAttempt?.startedAt ?? job.lastAttempt?.createdAt)}</s-table-cell>
                  <s-table-cell>{job.callStatus.startsWith("booking_") ? label(job.callStatus) : job.bookingAttemptId ? "Booking attempt recorded" : "Not booked by calls"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : null}
      </s-section>

      {search && !invalidSearch ? jobs.map((job) => (
        <s-section key={job.id} heading={`#${job.shopifyOrderNumber} · ${job.customerName}`}>
          <s-paragraph>Product: {job.productSummary}</s-paragraph>
          <s-paragraph>Call result: {label(job.lastAttempt?.callResult ?? job.callStatus)}. Latest attempt: {label(job.lastAttempt?.status)}. Completed: {dateLabel(job.lastAttempt?.completedAt)}.</s-paragraph>
          <s-paragraph>{job.lastAttempt?.spokenAddressText ? "Address recorded as spoken:" : "Address prepared for speech:"} {job.lastAttempt?.spokenAddressText || job.normalizedAddress}</s-paragraph>
          {job.lastAttempt?.failureMessage ? <s-paragraph>Latest issue: {job.lastAttempt.failureMessage}</s-paragraph> : null}
        </s-section>
      )) : null}
    </s-page>
  );
}
