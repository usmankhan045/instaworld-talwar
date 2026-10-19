import {useState} from "react";
import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";
import {useFetcher, useLoaderData} from "react-router";

import {authenticate} from "../shopify.server";
import {bookBulkGroups, validateBulkCsv, type BulkBookingResult, type BulkBookingGroup} from "../lib/bulk-booking.server";
import prisma from "../db.server";
import styles from "../styles/ui.module.css";

export async function loader({request}: LoaderFunctionArgs) {
  const {session} = await authenticate.admin(request);
  return {accounts: await prisma.instaWorldAccount.findMany({where: {shop: session.shop}, select: {id: true, name: true, mode: true, isDefault: true}, orderBy: [{isDefault: "desc"}, {createdAt: "asc"}]})};
}

export async function action({request}: ActionFunctionArgs) {
  const {session} = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "preview");
  const csvText = String(form.get("csvText") || "");
  if (!csvText.trim()) return Response.json({ok: false, errors: ["Upload a CSV file first."]}, {status: 400});
  try {
    const validation = validateBulkCsv(csvText);
    if (validation.errors.length > 0 || intent !== "book") {
      return Response.json({ok: validation.errors.length === 0, ...validation, csvText: validation.errors.length === 0 ? csvText : undefined});
    }
    const assignments = JSON.parse(String(form.get("accountAssignments") || "{}")) as Record<string, string>;
    const groups = validation.groups.map((group) => ({...group, accountId: assignments[group.reference] || undefined}));
    const results = await bookBulkGroups(session.shop, groups);
    return Response.json({ok: true, ...validation, results});
  } catch (error) {
    return Response.json({ok: false, errors: [error instanceof Error ? error.message : "Bulk booking failed."]}, {status: 400});
  }
}

type BulkPageData = {
  ok?: boolean;
  errors?: string[];
  groups?: BulkBookingGroup[];
  rowCount?: number;
  csvText?: string;
  results?: BulkBookingResult[];
};

export default function BulkBooking() {
  const {accounts} = useLoaderData<typeof loader>();
  const fetcher = useFetcher<BulkPageData>();
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const data = fetcher.data;
  const busy = fetcher.state !== "idle";
  const previewed = Boolean(data?.ok && data.csvText);
  const [accountAssignments, setAccountAssignments] = useState<Record<string, string>>({});
  const showAccountRouting = accounts.length > 1;
  const submitCsv = (intent: "preview" | "book") => fetcher.submit({intent, csvText, accountAssignments: JSON.stringify(accountAssignments)}, {method: "post"});

  return (
    <s-page heading="Bulk shipment booking">
      <s-button slot="primary-action" href="/templates/whatsapp-booking-template.csv" download="whatsapp-booking-template.csv" variant="secondary">
        Download CSV template
      </s-button>
      <div className={styles.pageContent}>
      <s-section heading="1 · Upload your shipment file">
        <s-paragraph>Use one row per product. Repeat the same reference for multiple products in one shipment. Matching references are grouped into one 0.8 kg shipment.</s-paragraph>
        <div className={styles.uploadZone}>
          <s-stack direction="block" gap="base">
            <s-text type="strong">Choose a CSV file</s-text>
            <s-text tone="neutral">Up to 500 product rows and 100 shipments per upload.</s-text>
            <input className={styles.fileInput} type="file" accept=".csv,text/csv" onChange={async (event) => { const file = event.currentTarget.files?.[0]; if (!file) return; setFileName(file.name); setCsvText(await file.text()); }} />
            {fileName && <div className={styles.fileName}><s-text tone="success">Ready: {fileName}</s-text></div>}
            <s-button variant="primary" disabled={!csvText || busy} loading={busy} onClick={() => submitCsv("preview")}>Review shipments</s-button>
          </s-stack>
        </div>
      </s-section>
      {data?.errors?.length ? (
        <s-section heading="Fix these CSV errors">
          <s-unordered-list>{data.errors.map((error: string) => <s-list-item key={error}>{error}</s-list-item>)}</s-unordered-list>
        </s-section>
      ) : null}
      {data?.ok && data.groups ? (
        <s-section heading="2 · Review before booking">
          <s-banner heading={`${data.groups.length} shipments ready`} tone="info">{data.rowCount} product rows were grouped successfully. Check the destination and courier account before booking.</s-banner>
          <s-table>
            <s-table-header-row><s-table-header>Reference</s-table-header><s-table-header>Customer</s-table-header><s-table-header>City</s-table-header><s-table-header>Products</s-table-header><s-table-header>Amount</s-table-header>{showAccountRouting && <s-table-header>Book with</s-table-header>}</s-table-header-row>
            <s-table-body>{data.groups.map((group) => <s-table-row key={group.reference}><s-table-cell>{group.reference}</s-table-cell><s-table-cell>{group.firstName} {group.lastName}</s-table-cell><s-table-cell>{group.city}</s-table-cell><s-table-cell>{group.items.map((item) => `${item.title}${item.color ? ` (${item.color})` : ""}`).join("; ")}</s-table-cell><s-table-cell>{group.amount}</s-table-cell>{showAccountRouting && <s-table-cell><s-select label="Account" labelAccessibilityVisibility="exclusive" value={accountAssignments[group.reference] || accounts.find((account) => account.isDefault)?.id || accounts[0]?.id || ""} onChange={(event) => setAccountAssignments((current) => ({...current, [group.reference]: (event.target as HTMLSelectElement).value}))}>{accounts.map((account) => <s-option key={account.id} value={account.id}>{account.name} · {account.mode}</s-option>)}</s-select></s-table-cell>}</s-table-row>)}</s-table-body>
          </s-table>
          {!data.results && <s-button variant="primary" tone="critical" disabled={busy} loading={busy} onClick={() => submitCsv("book")}>Book all shipments</s-button>}
        </s-section>
      ) : null}
      {data?.results ? (
        <s-section heading="Booking results">
          {data.results.some((result) => result.status === "failed") ? (
            <s-banner heading="Some shipments failed" tone="critical">
              <s-unordered-list>
                {data.results.filter((result) => result.status === "failed").map((result) => <s-list-item key={result.reference}>{result.error || `${result.reference}: Booking failed. Retry this order.`}</s-list-item>)}
              </s-unordered-list>
            </s-banner>
          ) : null}
          <s-table><s-table-header-row><s-table-header>Reference</s-table-header><s-table-header>Status</s-table-header><s-table-header>Tracking / message</s-table-header></s-table-header-row><s-table-body>{data.results.map((result) => <s-table-row key={result.reference}><s-table-cell>{result.reference}</s-table-cell><s-table-cell>{result.status}</s-table-cell><s-table-cell>{result.status === "failed" ? result.error : result.trackingNumber || result.message || ""}</s-table-cell></s-table-row>)}</s-table-body></s-table>
        </s-section>
      ) : null}
      <s-section heading="File format">
        <s-paragraph>Required: reference, first_name, phone, address, city, amount, product_title, quantity. Optional: last_name, email, province, postal_code, country, sku, color, payment_type.</s-paragraph>
      </s-section>
      </div>
    </s-page>
  );
}
