CREATE TABLE "InstaWorldAccount" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "apiKey" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL DEFAULT 'https://api.instaworld.pk/v2',
  "locationId" INTEGER NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'live',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstaWorldAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "instaworldAccount_shop_name_key" ON "InstaWorldAccount"("shop", "name");
CREATE INDEX "InstaWorldAccount_shop_isDefault_idx" ON "InstaWorldAccount"("shop", "isDefault");
ALTER TABLE "Shipment" ADD COLUMN "instaworldAccountId" TEXT;
