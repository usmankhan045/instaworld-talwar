CREATE TABLE "WhatsAppAccount" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "accountKey" TEXT NOT NULL,
  "phoneNumberId" TEXT NOT NULL,
  "businessAccountId" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WhatsAppTemplate" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "accountKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "templateName" TEXT NOT NULL,
  "languageCode" TEXT NOT NULL DEFAULT 'en_US',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WhatsAppNotification" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "accountKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "shipmentId" TEXT,
  "shopifyOrderId" TEXT,
  "recipientPhone" TEXT NOT NULL,
  "templateName" TEXT NOT NULL,
  "languageCode" TEXT NOT NULL DEFAULT 'en_US',
  "parametersJson" TEXT NOT NULL,
  "documentUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "leaseUntil" TIMESTAMP(3),
  "providerMessageId" TEXT,
  "lastError" TEXT,
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsAppNotification_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WhatsAppWebhookEvent" (
  "id" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "eventType" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "WhatsAppWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "whatsappAccount_shop_accountKey_key" ON "WhatsAppAccount"("shop", "accountKey");
CREATE UNIQUE INDEX "whatsappAccount_shop_phoneNumberId_key" ON "WhatsAppAccount"("shop", "phoneNumberId");
CREATE INDEX "WhatsAppAccount_shop_enabled_idx" ON "WhatsAppAccount"("shop", "enabled");
CREATE UNIQUE INDEX "whatsappTemplate_shop_account_event_key" ON "WhatsAppTemplate"("shop", "accountKey", "eventType");
CREATE INDEX "WhatsAppTemplate_shop_enabled_idx" ON "WhatsAppTemplate"("shop", "enabled");
CREATE UNIQUE INDEX "whatsappNotification_shop_idempotencyKey_key" ON "WhatsAppNotification"("shop", "idempotencyKey");
CREATE INDEX "WhatsAppNotification_shop_status_nextAttemptAt_leaseUntil_idx" ON "WhatsAppNotification"("shop", "status", "nextAttemptAt", "leaseUntil");
CREATE INDEX "WhatsAppNotification_shop_shipmentId_idx" ON "WhatsAppNotification"("shop", "shipmentId");
CREATE INDEX "WhatsAppNotification_shop_providerMessageId_idx" ON "WhatsAppNotification"("shop", "providerMessageId");
CREATE UNIQUE INDEX "whatsappWebhook_providerMessage_event_key" ON "WhatsAppWebhookEvent"("providerMessageId", "eventType");
CREATE INDEX "WhatsAppWebhookEvent_receivedAt_idx" ON "WhatsAppWebhookEvent"("receivedAt");
ALTER TABLE "WhatsAppNotification" ADD CONSTRAINT "WhatsAppNotification_account_fkey" FOREIGN KEY ("shop", "accountKey") REFERENCES "WhatsAppAccount"("shop", "accountKey") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppNotification" ADD CONSTRAINT "WhatsAppNotification_shipment_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
