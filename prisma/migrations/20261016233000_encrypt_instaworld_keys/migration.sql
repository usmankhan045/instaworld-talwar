ALTER TABLE "InstaWorldAccount" ADD COLUMN "apiKeyEncrypted" TEXT;
DELETE FROM "InstaWorldAccount";
ALTER TABLE "InstaWorldAccount" ALTER COLUMN "apiKeyEncrypted" SET NOT NULL;
ALTER TABLE "InstaWorldAccount" DROP COLUMN "apiKey";
