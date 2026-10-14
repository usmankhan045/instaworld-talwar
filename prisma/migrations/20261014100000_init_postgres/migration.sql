-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderBooking" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "trackingNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "declaredWeight" DOUBLE PRECISION,
    "paymentType" TEXT,
    "amountDue" DOUBLE PRECISION,
    "bookedAt" TIMESTAMP(3),
    "apiError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "refNo" TEXT NOT NULL,
    "trackingNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "declaredWeight" DOUBLE PRECISION,
    "paymentType" TEXT,
    "amountDue" DOUBLE PRECISION,
    "currencyCode" TEXT,
    "bookedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentOrder" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingAttempt" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "requestFingerprint" TEXT NOT NULL,
    "requestPayload" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "lastHttpStatus" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "recoveryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderReservation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderBooking_shop_orderNumber_idx" ON "OrderBooking"("shop", "orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OrderBooking_shop_orderId_key" ON "OrderBooking"("shop", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_shop_refNo_key" ON "Shipment"("shop", "refNo");

-- CreateIndex
CREATE INDEX "ShipmentOrder_shop_shipmentId_idx" ON "ShipmentOrder"("shop", "shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentOrder_shop_shopifyOrderId_key" ON "ShipmentOrder"("shop", "shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentOrder_shipmentId_shopifyOrderId_key" ON "ShipmentOrder"("shipmentId", "shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingAttempt_shop_idempotencyKey_key" ON "BookingAttempt"("shop", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "BookingAttempt_shop_shipmentId_key" ON "BookingAttempt"("shop", "shipmentId");

-- CreateIndex
CREATE INDEX "OrderReservation_shop_attemptId_idx" ON "OrderReservation"("shop", "attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderReservation_shop_shopifyOrderId_key" ON "OrderReservation"("shop", "shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderReservation_attemptId_shopifyOrderId_key" ON "OrderReservation"("attemptId", "shopifyOrderId");

-- AddForeignKey
ALTER TABLE "ShipmentOrder" ADD CONSTRAINT "ShipmentOrder_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAttempt" ADD CONSTRAINT "BookingAttempt_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

