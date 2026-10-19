ALTER TABLE "InstaWorldAccount"
  ADD COLUMN "cityCatalogJson" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "cityCatalogSyncedAt" TIMESTAMP(3);
