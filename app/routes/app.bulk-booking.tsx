import {useState} from "react";
import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";
import {useFetcher} from "react-router";

import {authenticate} from "../shopify.server";
import {bookBulkGroups, validateBulkCsv, type BulkBookingResult, type BulkBookingGroup} from "../lib/bulk-booking.server";
import {requireInstaWorldConfig} from "../lib/instaworld.server";

export async function loader({request}: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return null;
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
    const config = requireInstaWorldConfig(session.shop);
    const results = await bookBulkGroups(session.shop, validation.groups, config.locationId!);
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
  const fetcher = useFetcher<BulkPageData>();
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const data = fetcher.data;
  const busy = fetcher.state !== "idle";
  const previewed = Boolean(data?.ok && data.csvText);
  const submitCsv = (intent: "preview" | "book") => fetcher.submit({intent, csvText}, {method: "post"});

  return (
    <s-page heading="WhatsApp bulk booking">
      <s-button slot="primary-action" href="/templates/whatsapp-booking-template.csv" download="whatsapp-booking-template.csv" variant="secondary">
        Download CSV template
      </s-button>
      <s-section heading="1. Upload order CSV">
        <s-paragraph>Use one row per product. Repeat the same reference for multiple products in one shipment.</s-paragraph>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            if (!file) return;
            setFileName(file.name);
            setCsvText(await file.text());
          }}
        />
        {fileName && <s-paragraph>Selected: {fileName}</s-paragraph>}
        <s-button variant="primary" disabled={!csvText || busy} loading={busy} onClick={() => submitCsv("preview")}>
          Validate and preview
        </s-button>
      </s-section>
      {data?.errors?.length ? (
        <s-section heading="Fix these CSV errors">
          <s-unordered-list>{data.errors.map((error: string) => <s-list-item key={error}>{error}</s-list-item>)}</s-unordered-list>
        </s-section>
      ) : null}
      {data?.ok && data.groups ? (
        <s-section heading="2. Review and book">
          <s-paragraph>{data.groups.length} shipments from {data.rowCount} product rows. Every shipment will be booked at 0.8 kg total.</s-paragraph>
          <s-table>
            <s-table-header-row><s-table-header>Reference</s-table-header><s-table-header>Customer</s-table-header><s-table-header>City</s-table-header><s-table-header>Products</s-table-header><s-table-header>Amount</s-table-header></s-table-header-row>
            <s-table-body>{data.groups.map((group) => <s-table-row key={group.reference}><s-table-cell>{group.reference}</s-table-cell><s-table-cell>{group.firstName} {group.lastName}</s-table-cell><s-table-cell>{group.city}</s-table-cell><s-table-cell>{group.items.map((item) => `${item.title}${item.color ? ` (${item.color})` : ""}`).join("; ")}</s-table-cell><s-table-cell>{group.amount}</s-table-cell></s-table-row>)}</s-table-body>
          </s-table>
          {!data.results && <s-button variant="primary" tone="critical" disabled={busy} loading={busy} onClick={() => submitCsv("book")}>Book all shipments</s-button>}
        </s-section>
      ) : null}
      {data?.results ? (
        <s-section heading="Booking results">
          <s-table><s-table-header-row><s-table-header>Reference</s-table-header><s-table-header>Status</s-table-header><s-table-header>Tracking / message</s-table-header></s-table-header-row><s-table-body>{data.results.map((result) => <s-table-row key={result.reference}><s-table-cell>{result.reference}</s-table-cell><s-table-cell>{result.status}</s-table-cell><s-table-cell>{result.trackingNumber || result.message || ""}</s-table-cell></s-table-row>)}</s-table-body></s-table>
        </s-section>
      ) : null}
      <s-section heading="CSV columns">
        <s-paragraph>Required: reference, first_name, phone, address, city, amount, product_title, quantity. Optional: last_name, email, province, postal_code, country, sku, color, payment_type.</s-paragraph>
      </s-section>
    </s-page>
  );
}
