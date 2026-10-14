-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "instaworldStatus" TEXT,
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "shopifyFulfillmentId" TEXT;

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_shop_key" ON "SyncState"("shop");

-- CreateIndex
CREATE INDEX "Shipment_shop_trackingNumber_idx" ON "Shipment"("shop", "trackingNumber");
