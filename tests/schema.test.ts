/**
 * Offline schema validation tests.
 *
 * These tests do NOT connect to any database. They validate:
 *   1. The Prisma schema itself is syntactically valid (`prisma validate`).
 *   2. The schema file declares the correct provider, all six models, every
 *      unique constraint, and every @@index that the application relies on.
 *   3. The PostgreSQL migration file exists and covers all six tables.
 *
 * Running `npm test` does not require DATABASE_URL or any live connection.
 */

import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import test from "node:test";

const SCHEMA_PATH = "prisma/schema.prisma";
const MIGRATION_PATH =
  "prisma/migrations/20261014100000_init_postgres/migration.sql";

/** Read a file relative to the project root. */
function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// 1. Prisma schema validation (no DB connection required)
// ---------------------------------------------------------------------------

test("prisma validate passes without errors", () => {
  // prisma validate reads the schema and checks syntax / referential integrity.
  // Dummy env vars satisfy the env("...") refs in the datasource block so
  // validation proceeds without a live connection.
  const result = execFileSync(
    "npx",
    ["prisma", "validate", "--schema", SCHEMA_PATH],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://x:x@localhost/x",
        DIRECT_DATABASE_URL: "postgresql://x:x@localhost/x",
      },
    },
  );
  // Any non-zero exit code throws; if we reach here, validation passed.
  assert.ok(result !== undefined);
});

// ---------------------------------------------------------------------------
// 2. Schema structural assertions (offline text parsing)
// ---------------------------------------------------------------------------

test("schema uses postgresql provider", () => {
  const schema = readFile(SCHEMA_PATH);
  assert.ok(
    schema.includes('provider  = "postgresql"') ||
      schema.includes('provider = "postgresql"'),
    "schema.prisma must declare provider = \"postgresql\"",
  );
});

test("schema declares DATABASE_URL and DIRECT_DATABASE_URL", () => {
  const schema = readFile(SCHEMA_PATH);
  assert.ok(
    schema.includes('url       = env("DATABASE_URL")') ||
      schema.includes('url = env("DATABASE_URL")'),
    "schema.prisma must use DATABASE_URL",
  );
  assert.ok(
    schema.includes('directUrl = env("DIRECT_DATABASE_URL")') ||
      schema.includes('directUrl= env("DIRECT_DATABASE_URL")'),
    "schema.prisma must use DIRECT_DATABASE_URL for Neon direct connections",
  );
});

test("all six models are declared in schema", () => {
  const schema = readFile(SCHEMA_PATH);
  const expectedModels = [
    "Session",
    "OrderBooking",
    "Shipment",
    "ShipmentOrder",
    "BookingAttempt",
    "OrderReservation",
  ];
  for (const model of expectedModels) {
    assert.ok(
      schema.includes(`model ${model} {`),
      `schema.prisma must declare model ${model}`,
    );
  }
});

test("shop-scoped unique constraints are declared in schema", () => {
  const schema = readFile(SCHEMA_PATH);
  // Each of these is a @@unique or @@index block present in the schema.
  const expectedConstraints = [
    // OrderBooking
    'name: "orderBooking_unique"',
    // Shipment
    'name: "shipment_shop_refNo_key"',
    // ShipmentOrder
    'name: "shipmentOrder_shop_shopifyOrderId_key"',
    'name: "shipmentOrder_shipment_order_key"',
    // BookingAttempt
    'name: "bookingAttempt_shop_idempotencyKey_key"',
    'name: "bookingAttempt_shop_shipmentId_key"',
    // OrderReservation
    'name: "orderReservation_shop_shopifyOrderId_key"',
    'name: "orderReservation_attempt_order_key"',
  ];
  for (const constraint of expectedConstraints) {
    assert.ok(
      schema.includes(constraint),
      `schema.prisma must include constraint ${constraint}`,
    );
  }
});

test("shop-scoped indexes are declared in schema", () => {
  const schema = readFile(SCHEMA_PATH);
  // Spot-check the @@index declarations.
  assert.ok(
    schema.includes("@@index([shop, orderNumber])"),
    "OrderBooking must have @@index([shop, orderNumber])",
  );
  assert.ok(
    schema.includes("@@index([shop, shipmentId])"),
    "ShipmentOrder must have @@index([shop, shipmentId])",
  );
  assert.ok(
    schema.includes("@@index([shop, attemptId])"),
    "OrderReservation must have @@index([shop, attemptId])",
  );
});

test("foreign-key relations are declared in schema", () => {
  const schema = readFile(SCHEMA_PATH);
  // ShipmentOrder → Shipment
  assert.ok(
    schema.includes("onDelete: Restrict") || schema.includes("onDelete:Restrict"),
    "schema must declare onDelete: Restrict for FK relations",
  );
  // Relation fields exist
  assert.ok(schema.includes("orders         ShipmentOrder[]"), "Shipment must have orders relation");
  assert.ok(schema.includes("attempts       BookingAttempt[]"), "Shipment must have attempts relation");
});

// ---------------------------------------------------------------------------
// 3. PostgreSQL migration file assertions (no DB connection)
// ---------------------------------------------------------------------------

test("postgresql migration file exists and covers all six tables", () => {
  const sql = readFile(MIGRATION_PATH);
  const expectedTables = [
    "Session",
    "OrderBooking",
    "Shipment",
    "ShipmentOrder",
    "BookingAttempt",
    "OrderReservation",
  ];
  for (const table of expectedTables) {
    assert.ok(
      sql.includes(`CREATE TABLE "${table}"`),
      `migration.sql must CREATE TABLE "${table}"`,
    );
  }
});

test("postgresql migration uses TIMESTAMP(3) not DATETIME", () => {
  const sql = readFile(MIGRATION_PATH);
  assert.ok(sql.includes("TIMESTAMP(3)"), "migration.sql must use TIMESTAMP(3) for datetime columns");
  assert.ok(!sql.includes("DATETIME"), "migration.sql must not use SQLite DATETIME type");
});

test("postgresql migration uses DOUBLE PRECISION not REAL", () => {
  const sql = readFile(MIGRATION_PATH);
  assert.ok(
    sql.includes("DOUBLE PRECISION"),
    "migration.sql must use DOUBLE PRECISION for float columns",
  );
  assert.ok(!sql.includes(" REAL"), "migration.sql must not use SQLite REAL type");
});

test("postgresql migration declares foreign keys with RESTRICT", () => {
  const sql = readFile(MIGRATION_PATH);
  assert.ok(
    sql.includes("ON DELETE RESTRICT"),
    "migration.sql must declare FK with ON DELETE RESTRICT",
  );
  assert.ok(
    sql.includes("ShipmentOrder_shipmentId_fkey"),
    "migration.sql must include ShipmentOrder FK constraint",
  );
  assert.ok(
    sql.includes("BookingAttempt_shipmentId_fkey"),
    "migration.sql must include BookingAttempt FK constraint",
  );
});

test("postgresql migration includes all shop-scoped unique indexes", () => {
  const sql = readFile(MIGRATION_PATH);
  const expectedIndexes = [
    "OrderBooking_shop_orderId_key",
    "Shipment_shop_refNo_key",
    "ShipmentOrder_shop_shopifyOrderId_key",
    "ShipmentOrder_shipmentId_shopifyOrderId_key",
    "BookingAttempt_shop_idempotencyKey_key",
    "BookingAttempt_shop_shipmentId_key",
    "OrderReservation_shop_shopifyOrderId_key",
    "OrderReservation_attemptId_shopifyOrderId_key",
  ];
  for (const idx of expectedIndexes) {
    assert.ok(
      sql.includes(idx),
      `migration.sql must include unique index "${idx}"`,
    );
  }
});

test("migration_lock.toml locks provider to postgresql", () => {
  const lock = readFile("prisma/migrations/migration_lock.toml");
  assert.ok(
    lock.includes('provider = "postgresql"'),
    "migration_lock.toml must lock provider to postgresql",
  );
});
