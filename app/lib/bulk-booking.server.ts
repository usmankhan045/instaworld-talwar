import {randomUUID} from "node:crypto";

import prisma from "../db.server.ts";
import {
  allocateShipmentWeight,
  buildInstaWorldAddress,
  createShipment,
  FIXED_SHIPMENT_WEIGHT_KG,
  getPaymentType,
  isCancelledShipment,
  findShipmentByReference,
  normaliseCity,
  normalisePhone,
  truncate,
  type InstaWorldRequest,
} from "./instaworld.server.ts";

export const BULK_CSV_HEADERS = [
  "reference",
  "first_name",
  "last_name",
  "phone",
  "email",
  "address",
  "city",
  "province",
  "postal_code",
  "country",
  "amount",
  "product_title",
  "sku",
  "color",
  "quantity",
  "payment_type",
] as const;

const REQUIRED_CSV_HEADERS = ["reference", "first_name", "phone", "address", "city", "amount", "product_title", "quantity"] as const;

type BulkCsvHeader = (typeof BULK_CSV_HEADERS)[number];

export type BulkBookingItem = {
  title: string;
  sku: string | null;
  color: string | null;
  quantity: number;
};

export type BulkBookingGroup = {
  reference: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  address: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  amount: number;
  paymentType: "cod" | "paid";
  items: BulkBookingItem[];
};

export type BulkValidation = {
  groups: BulkBookingGroup[];
  errors: string[];
  rowCount: number;
};

export type BulkBookingResult = {
  reference: string;
  status: "booked" | "skipped" | "failed";
  trackingNumber?: string;
  message?: string;
};

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("The CSV must include a header row and at least one order row.");
  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  const missing = REQUIRED_CSV_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length > 0) throw new Error(`Missing CSV columns: ${missing.join(", ")}`);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

const value = (row: Record<string, string>, key: BulkCsvHeader) => row[key]?.trim() || "";

export function validateBulkCsv(text: string): BulkValidation {
  const rows = parseCsv(text);
  const errors: string[] = [];
  const groups = new Map<string, BulkBookingGroup>();
  if (rows.length > 500) errors.push("A CSV upload may contain at most 500 product rows.");

  rows.forEach((row, rowIndex) => {
    const line = rowIndex + 2;
    const reference = value(row, "reference");
    const amount = Number(value(row, "amount"));
    const quantity = Number(value(row, "quantity"));
    const paymentType = (value(row, "payment_type") || "cod").toLowerCase();
    const required: Array<[BulkCsvHeader, string]> = [
      ["reference", reference], ["first_name", value(row, "first_name")], ["phone", value(row, "phone")],
      ["address", value(row, "address")], ["city", value(row, "city")], ["amount", value(row, "amount")],
      ["product_title", value(row, "product_title")], ["quantity", value(row, "quantity")],
    ];
    for (const [field, fieldValue] of required) if (!fieldValue) errors.push(`Row ${line}: ${field} is required.`);
    if (reference && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(reference)) {
      errors.push(`Row ${line}: reference must use letters, numbers, hyphens, or underscores only.`);
    }
    if (value(row, "phone") && !normalisePhone(value(row, "phone"))) errors.push(`Row ${line}: phone is invalid.`);
    if (value(row, "amount") && (!Number.isFinite(amount) || amount <= 0)) errors.push(`Row ${line}: amount must be positive.`);
    if (value(row, "quantity") && (!Number.isInteger(quantity) || quantity <= 0)) errors.push(`Row ${line}: quantity must be a positive whole number.`);
    if (!(["cod", "paid"] as string[]).includes(paymentType)) errors.push(`Row ${line}: payment_type must be cod or paid.`);
    if (!reference || !value(row, "product_title") || !Number.isInteger(quantity) || quantity <= 0) return;

    const existing = groups.get(reference);
    const rowData = {
      reference,
      firstName: value(row, "first_name"), lastName: value(row, "last_name"), phone: normalisePhone(value(row, "phone")),
      email: value(row, "email") || null, address: value(row, "address"), city: normaliseCity(value(row, "city")),
      province: value(row, "province"), postalCode: value(row, "postal_code"), country: value(row, "country") || "Pakistan",
      amount, paymentType: paymentType as "cod" | "paid",
    };
    if (existing) {
      const sameCustomer = ["firstName", "lastName", "phone", "email", "address", "city", "province", "postalCode", "country", "amount", "paymentType"]
        .every((key) => existing[key as keyof BulkBookingGroup] === rowData[key as keyof typeof rowData]);
      if (!sameCustomer) errors.push(`Row ${line}: reference ${reference} does not match the other rows for this shipment.`);
      existing.items.push({title: value(row, "product_title"), sku: value(row, "sku") || null, color: value(row, "color") || null, quantity});
    } else {
      groups.set(reference, {...rowData, items: [{title: value(row, "product_title"), sku: value(row, "sku") || null, color: value(row, "color") || null, quantity}]});
    }
  });
  if (groups.size > 100) errors.push("A CSV upload may contain at most 100 shipments.");
  return {groups: [...groups.values()], errors, rowCount: rows.length};
}

function requestFor(group: BulkBookingGroup, locationId: number): InstaWorldRequest {
  const weights = allocateShipmentWeight(group.items.length);
  return {
    refNo: group.reference,
    locationId,
    payment: {type: getPaymentType(group.paymentType === "cod" ? "cod" : "prepaid"), amount: group.amount},
    consignee: {
      first_name: truncate(group.firstName, 80), last_name: truncate(group.lastName, 80), phone: group.phone,
      ...(group.email ? {email: truncate(group.email, 150)} : {}), city: group.city,
      address: truncate(buildInstaWorldAddress([group.address, group.city, group.province, group.postalCode, group.country]), 200),
    },
    items: group.items.map((item, index) => ({title: truncate(item.title, 100), sku: item.sku, product_detail: item.color || undefined, quantity: item.quantity, kg: weights[index]})),
  };
}

async function bookOneBulkGroup(shop: string, group: BulkBookingGroup, locationId: number): Promise<BulkBookingResult> {
  try {
    // InstaWorld is the source of truth. A cancelled remote shipment may be
    // booked again; an active remote shipment is skipped as a duplicate.
    const remote = await findShipmentByReference(group.reference, shop);
    if (remote && !isCancelledShipment(remote)) {
      return {reference: group.reference, status: "skipped", trackingNumber: remote.trackingNumber, message: "Already booked in InstaWorld."};
    }
    const local = await prisma.shipment.findUnique({where: {shipment_shop_refNo_key: {shop, refNo: group.reference}}, select: {trackingNumber: true}});
    const bookingReference = local ? `${group.reference}-R${randomUUID().slice(0, 8)}`.slice(0, 100) : group.reference;
    const requestPayload = requestFor({...group, reference: bookingReference}, locationId);
    const idempotencyKey = randomUUID();
    const shipment = await prisma.shipment.create({data: {shop, refNo: bookingReference, status: "submitting", declaredWeight: FIXED_SHIPMENT_WEIGHT_KG, paymentType: group.paymentType, amountDue: group.amount, currencyCode: "PKR"}});
    const attempt = await prisma.bookingAttempt.create({data: {shop, shipmentId: shipment.id, idempotencyKey, status: "submitting", requestFingerprint: JSON.stringify({source: "whatsapp-csv", reference: group.reference}), requestPayload: JSON.stringify(requestPayload)}});
    try {
      const result = await createShipment(requestPayload, idempotencyKey, shop);
      await prisma.$transaction([
        prisma.shipment.update({where: {id: shipment.id}, data: {status: "booked", trackingNumber: result.trackingNumber, bookedAt: new Date()}}),
        prisma.bookingAttempt.update({where: {id: attempt.id}, data: {status: "succeeded", completedAt: new Date()}}),
      ]);
      return {reference: group.reference, status: "booked", trackingNumber: result.trackingNumber};
    } catch (error) {
      const message = error instanceof Error ? error.message : "Booking failed.";
      await prisma.$transaction([
        prisma.shipment.update({where: {id: shipment.id}, data: {status: "failed"}}),
        prisma.bookingAttempt.update({where: {id: attempt.id}, data: {status: "definite_failure", completedAt: new Date(), lastErrorMessage: message}}),
      ]);
      return {reference: group.reference, status: "failed", message};
    }
  } catch (error) {
    return {reference: group.reference, status: "failed", message: error instanceof Error ? error.message : "Booking failed."};
  }
}

export async function bookBulkGroups(shop: string, groups: BulkBookingGroup[], locationId: number): Promise<BulkBookingResult[]> {
  const results: BulkBookingResult[] = [];
  const batchSize = 5;
  for (let index = 0; index < groups.length; index += batchSize) {
    const batch = groups.slice(index, index + batchSize);
    results.push(...await Promise.all(batch.map((group) => bookOneBulkGroup(shop, group, locationId))));
  }
  return results;
}
