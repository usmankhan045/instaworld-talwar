import prisma from "../../db.server.ts";
import {sendWhatsAppTemplate} from "./client.server.ts";
import {isWhatsAppAutomationEnabled} from "./config.server.ts";
import type {WhatsAppNotificationPlan, WhatsAppShipmentSnapshot} from "./types.server.ts";

export async function enqueueWhatsAppNotification(
  snapshot: WhatsAppShipmentSnapshot,
  plan: WhatsAppNotificationPlan,
): Promise<{id: string; created: boolean}> {
  const idempotencyKey = [snapshot.shop, snapshot.shipmentId || snapshot.orderNumber, plan.eventType].join(":");
  const existing = await prisma.whatsAppNotification.findUnique({
    where: {whatsappNotification_shop_idempotencyKey_key: {shop: snapshot.shop, idempotencyKey}},
    select: {id: true},
  });
  if (existing) return {id: existing.id, created: false};

  const row = await prisma.whatsAppNotification.create({
    data: {
      shop: snapshot.shop,
      accountKey: snapshot.accountKey,
      eventType: plan.eventType,
      idempotencyKey,
      shipmentId: snapshot.shipmentId,
      shopifyOrderId: snapshot.shopifyOrderId,
      recipientPhone: snapshot.recipientPhone,
      templateName: plan.templateName,
      parametersJson: JSON.stringify(plan.parameters),
      documentUrl: plan.documentUrl,
      status: isWhatsAppAutomationEnabled() ? "pending" : "disabled",
    },
    select: {id: true},
  });
  return {id: row.id, created: true};
}

export async function processWhatsAppOutbox(limit = 25): Promise<{processed: number; failed: number}> {
  if (!isWhatsAppAutomationEnabled()) return {processed: 0, failed: 0};
  const now = new Date();
  const rows = await prisma.whatsAppNotification.findMany({
    where: {status: "pending", OR: [{nextAttemptAt: null}, {nextAttemptAt: {lte: now}}], AND: [{OR: [{leaseUntil: null}, {leaseUntil: {lte: now}}]}]},
    orderBy: {createdAt: "asc"},
    take: limit,
  });
  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    const leaseUntil = new Date(Date.now() + 30_000);
    const claimed = await prisma.whatsAppNotification.updateMany({
      where: {id: row.id, status: "pending", OR: [{leaseUntil: null}, {leaseUntil: {lte: new Date()}}]},
      data: {status: "processing", leaseUntil},
    });
    if (claimed.count !== 1) continue;
    try {
      const result = await sendWhatsAppTemplate({
        accountKey: row.accountKey as "store" | "food",
        recipientPhone: row.recipientPhone,
        templateName: row.templateName,
        languageCode: row.languageCode,
        parameters: JSON.parse(row.parametersJson) as string[],
        documentUrl: row.documentUrl || undefined,
      });
      await prisma.whatsAppNotification.update({
        where: {id: row.id},
        data: {status: "sent", providerMessageId: result.providerMessageId, sentAt: new Date(), leaseUntil: null, attempts: {increment: 1}},
      });
      processed++;
    } catch (error) {
      const attempts = row.attempts + 1;
      await prisma.whatsAppNotification.update({
        where: {id: row.id},
        data: {
          status: attempts >= 5 ? "failed" : "pending",
          attempts,
          leaseUntil: null,
          lastError: error instanceof Error ? error.message : String(error),
          nextAttemptAt: attempts >= 5 ? null : new Date(Date.now() + Math.min(60 * 60 * 1000, 2 ** attempts * 60 * 1000)),
        },
      });
      failed++;
    }
  }
  return {processed, failed};
}
