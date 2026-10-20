/**
 * GET /api/instaworld-sync
 *
 * Called every 15 minutes by the GitHub Actions workflow.
 * Also callable manually for testing.
 *
 * Security: requires Authorization: Bearer <CRON_SECRET> header.
 *
 * Flow:
 *  1. For each shop with a stored session:
 *  2. Fetch every paginated shipment from every connected InstaWorld account
 *  3. Find the matching app Shipment by tracking_number
 *  4. Save the authoritative InstaWorld status in the app database
 *  5. Update SyncState.lastSyncedAt
 *
 * This worker deliberately never changes Shopify fulfillment state. Shopify is
 * marked fulfilled once, during the merchant-confirmed booking flow.
 */

import type {LoaderFunctionArgs} from "react-router";
import prisma from "../db.server";
import {
  instaWorldStatusCode,
  instaWorldTrackingNumber,
  listAllInstaWorldShipments,
} from "../lib/instaworld-shipments.server";

function jsonResp(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {"Content-Type": "application/json"},
  });
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("Authorization") === `Bearer ${secret}`);
}

export async function loader({request}: LoaderFunctionArgs) {
  if (!isAuthorized(request)) {
    return jsonResp({error: "Unauthorized"}, 401);
  }

  const startTime = Date.now();
  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  const warnings: string[] = [];
  const criticalErrors: string[] = [];

  try {
    // Get all distinct shops with active sessions
    const sessions = await prisma.session.findMany({
      where: {isOnline: false},  // Offline sessions have the persistent access token
      select: {shop: true, accessToken: true},
      distinct: ["shop"],
    });

    for (const session of sessions) {
      const {shop} = session;

      try {
        await prisma.syncState.upsert({
          where: {shop},
          create: {shop},
          update: {},
        });
        const syncStart = new Date();

        // A full read makes the worker self-healing even when a previous cursor,
        // deployment, or webhook window was missed.
        const result = await listAllInstaWorldShipments(shop);
        const iwShipments = result.shipments;
        warnings.push(...result.warnings.map((warning) => `Shop ${shop}: ${warning}`));
        if (iwShipments.length === 0) {
          await prisma.syncState.update({where: {shop}, data: {lastSyncedAt: syncStart}});
          continue;
        }

        for (const iwShipment of iwShipments) {
          const trackingNumber = instaWorldTrackingNumber(iwShipment);
          if (!trackingNumber) {
            totalSkipped++;
            continue;
          }

          const newStatus = instaWorldStatusCode(iwShipment);
          if (!newStatus) {
            totalSkipped++;
            continue;
          }

          totalProcessed++;

          // Find our shipment record by tracking number
          const dbShipment = await prisma.shipment.findFirst({
            where: {shop, trackingNumber, instaworldAccountId: iwShipment.accountId},
            select: {id: true, instaworldStatus: true},
          });

          if (!dbShipment) {
            totalSkipped++;
            continue; // A valid InstaWorld shipment that was not booked by this app.
          }

          // Skip if status hasn't changed
          if (dbShipment.instaworldStatus === newStatus) {
            totalSkipped++;
            continue;
          }

          try {
            await prisma.shipment.update({
              where: {id: dbShipment.id},
              data: {
                instaworldStatus: newStatus,
                lastSyncedAt: new Date(),
              },
            });

            totalUpdated++;
          } catch (shipmentError) {
            const msg = `Shipment ${trackingNumber}: ${shipmentError instanceof Error ? shipmentError.message : String(shipmentError)}`;
            criticalErrors.push(msg);
            console.error("[sync]", msg);
          }
        }

        await prisma.syncState.update({where: {shop}, data: {lastSyncedAt: syncStart}});
      } catch (shopError) {
        const msg = `Shop ${shop}: ${shopError instanceof Error ? shopError.message : String(shopError)}`;
        criticalErrors.push(msg);
        console.error("[sync]", msg);
      }
    }
  } catch (fatal) {
    console.error("[sync] Fatal:", fatal);
    return jsonResp({error: "Sync failed", details: String(fatal)}, 500);
  }

  return jsonResp({
    ok: criticalErrors.length === 0,
    durationMs: Date.now() - startTime,
    processed: totalProcessed,
    updated: totalUpdated,
    skipped: totalSkipped,
    warnings,
    errors: criticalErrors,
  }, criticalErrors.length === 0 ? 200 : 500);
}
