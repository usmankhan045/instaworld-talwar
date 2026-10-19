ALTER TABLE "InstaWorldAccount"
  ADD COLUMN "externalAccountId" TEXT,
  ADD COLUMN "accountDetailsJson" TEXT NOT NULL DEFAULT '{}',
  ADD COLUMN "locationsJson" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "couriersJson" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "InstaWorldAccount_shop_externalAccountId_idx"
  ON "InstaWorldAccount"("shop", "externalAccountId");
