-- CreateTable
CREATE TABLE "CallJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderNumber" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "productSummary" TEXT NOT NULL,
    "normalizedAddress" TEXT NOT NULL,
    "orderStatus" TEXT NOT NULL DEFAULT 'pending',
    "addressStatus" TEXT NOT NULL DEFAULT 'pending',
    "callStatus" TEXT NOT NULL DEFAULT 'queued',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "activeLeaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastCallAttemptId" TEXT,
    "bookingAttemptId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallAttempt" (
    "id" TEXT NOT NULL,
    "callJobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "asteriskCallId" TEXT,
    "sipProviderCallId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "orderChoice" TEXT,
    "addressChoice" TEXT,
    "callResult" TEXT,
    "spokenNameText" TEXT,
    "spokenProductText" TEXT,
    "spokenAddressText" TEXT,
    "audioFileKeys" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallJob_shop_shopifyOrderId_key" ON "CallJob"("shop", "shopifyOrderId");
CREATE INDEX "CallJob_shop_callStatus_nextAttemptAt_idx" ON "CallJob"("shop", "callStatus", "nextAttemptAt");
CREATE INDEX "CallJob_shop_phone_idx" ON "CallJob"("shop", "phone");
CREATE UNIQUE INDEX "CallAttempt_callJobId_attemptNumber_key" ON "CallAttempt"("callJobId", "attemptNumber");
CREATE UNIQUE INDEX "CallAttempt_asteriskCallId_key" ON "CallAttempt"("asteriskCallId");
CREATE INDEX "CallAttempt_callJobId_status_idx" ON "CallAttempt"("callJobId", "status");
CREATE INDEX "CallAttempt_sipProviderCallId_idx" ON "CallAttempt"("sipProviderCallId");

-- AddForeignKey
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_callJobId_fkey" FOREIGN KEY ("callJobId") REFERENCES "CallJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
