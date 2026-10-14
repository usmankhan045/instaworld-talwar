import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import test from "node:test";

const database = "prisma/dev.sqlite";

function sqlite(query: string) {
  return execFileSync("sqlite3", ["-json", database, query], {encoding: "utf8"});
}

test("shipment schema exists without removing legacy OrderBooking", () => {
  const rows = JSON.parse(
    sqlite(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('OrderBooking','Shipment','ShipmentOrder','BookingAttempt','OrderReservation') ORDER BY name;",
    ),
  ) as Array<{name: string}>;
  assert.deepEqual(
    rows.map((row) => row.name),
    ["BookingAttempt", "OrderBooking", "OrderReservation", "Shipment", "ShipmentOrder"],
  );
});

test("shop-scoped uniqueness indexes exist", () => {
  const rows = JSON.parse(
    sqlite(
      "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('shipment_shop_refNo_key','shipmentOrder_shop_shopifyOrderId_key','shipmentOrder_shipment_order_key','orderReservation_shop_shopifyOrderId_key') ORDER BY name;",
    ),
  ) as Array<{name: string}>;
  assert.equal(rows.length, 4);
});
