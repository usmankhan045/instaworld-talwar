CREATE TABLE IF NOT EXISTS "Shipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "refNo" TEXT NOT NULL,
    "trackingNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "declaredWeight" REAL,
    "paymentType" TEXT,
    "amountDue" REAL,
    "currencyCode" TEXT,
    "bookedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "shipment_shop_refNo_key" ON "Shipment"("shop", "refNo");

CREATE TABLE IF NOT EXISTS "ShipmentOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderNumber" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShipmentOrder_shipmentId_fkey"
      FOREIGN KEY ("shipmentId") REFERENCES "Shipment" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "shipmentOrder_shop_shopifyOrderId_key"
  ON "ShipmentOrder"("shop", "shopifyOrderId");
CREATE UNIQUE INDEX IF NOT EXISTS "shipmentOrder_shipment_order_key"
  ON "ShipmentOrder"("shipmentId", "shopifyOrderId");
CREATE INDEX IF NOT EXISTS "ShipmentOrder_shop_shipmentId_idx"
  ON "ShipmentOrder"("shop", "shipmentId");

CREATE TABLE IF NOT EXISTS "BookingAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "requestFingerprint" TEXT NOT NULL,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "lastHttpStatus" INTEGER,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "leaseExpiresAt" DATETIME,
    "leaseToken" TEXT,
    "recoveryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookingAttempt_shipmentId_fkey"
      FOREIGN KEY ("shipmentId") REFERENCES "Shipment" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "bookingAttempt_shop_idempotencyKey_key"
  ON "BookingAttempt"("shop", "idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "bookingAttempt_shop_shipmentId_key"
  ON "BookingAttempt"("shop", "shipmentId");

CREATE TABLE IF NOT EXISTS "OrderReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "leaseExpiresAt" DATETIME NOT NULL,
    "releasedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "orderReservation_shop_shopifyOrderId_key"
  ON "OrderReservation"("shop", "shopifyOrderId");
CREATE UNIQUE INDEX IF NOT EXISTS "orderReservation_attempt_order_key"
  ON "OrderReservation"("attemptId", "shopifyOrderId");
CREATE INDEX IF NOT EXISTS "OrderReservation_shop_attemptId_idx"
  ON "OrderReservation"("shop", "attemptId");

INSERT OR IGNORE INTO "Shipment" (
  "id",
  "shop",
  "refNo",
  "trackingNumber",
  "status",
  "declaredWeight",
  "paymentType",
  "amountDue",
  "bookedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'legacy-' || "id",
  "shop",
  'legacy-' || "id",
  "trackingNumber",
  "status",
  "declaredWeight",
  "paymentType",
  "amountDue",
  "bookedAt",
  "createdAt",
  "updatedAt"
FROM "OrderBooking"
WHERE "status" = 'booked'
  AND "trackingNumber" IS NOT NULL;

INSERT OR IGNORE INTO "ShipmentOrder" (
  "id",
  "shipmentId",
  "shop",
  "shopifyOrderId",
  "shopifyOrderNumber",
  "createdAt"
)
SELECT
  'legacy-order-' || "id",
  'legacy-' || "id",
  "shop",
  "orderId",
  "orderNumber",
  "createdAt"
FROM "OrderBooking"
WHERE "status" = 'booked'
  AND "trackingNumber" IS NOT NULL;
