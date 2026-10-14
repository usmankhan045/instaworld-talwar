/**
 * GET /api/instaworld-sync
 *
 * Called every 15 minutes by Vercel Cron (vercel.json).
 * Also callable manually for testing.
 *
 * Security: requires Authorization: Bearer <CRON_SECRET> header,
 * OR Vercel sends x-vercel-signature which we verify.
 * For simplicity we use a shared secret checked against CRON_SECRET env var.
 *
 * Flow:
 *  1. For each shop with a stored session:
 *  2. Load SyncState.lastSyncedAt (default: 24 hours ago)
 *  3. Call InstaWorld GET /shipments?updated_since=<lastSyncedAt>
 *  4. For each updated shipment: find our DB Shipment by tracking_number
 *  5. Update Shopify fulfillment via GraphQL
 *  6. Update Shipment.instaworldStatus in DB
 *  7. Update SyncState.lastSyncedAt
 */

import type {LoaderFunctionArgs} from "react-router";
import prisma from "../db.server";
import {unauthenticated} from "../shopify.server";
import {
  createShopifyFulfillment,
  updateShopifyFulfillmentTracking,
  completeShopifyFulfillment,
  cancelShopifyFulfillment,
  instaworldStatusToShopify,
} from "../lib/shopify-fulfillment.server";

const INSTAWORLD_BASE_URL =
  process.env.INSTAWORLD_BASE_URL || "https://one-be.instaworld.pk/merchant-api/v2";

function jsonResp(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {"Content-Type": "application/json"},
  });
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // No secret configured — allow (dev mode)
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${secret}`;
}

async function fetchInstaWorldShipments(updatedSince: Date): Promise<any[]> {
  const apiKey = process.env.INSTAWORLD_API_KEY;
  if (!apiKey) return [];

  const allShipments: any[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({
      updated_since: updatedSince.toISOString(),
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(`${INSTAWORLD_BASE_URL}/shipments?${params}`, {
      headers: {Authorization: `Bearer ${apiKey}`, Accept: "application/json"},
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error("[sync] InstaWorld /shipments error:", res.status);
      break;
    }

    const payload = await res.json();
    const data: any[] = Array.isArray(payload?.data) ? payload.data : [];
    allShipments.push(...data);
    cursor = payload?.meta?.next_cursor ?? null;
  } while (cursor);

  return allShipments;
}

export async function loader({request}: LoaderFunctionArgs) {
  if (!isAuthorized(request)) {
    return jsonResp({error: "Unauthorized"}, 401);
  }

  const startTime = Date.now();
  let totalProcessed = 0;
  let totalUpdated = 0;
  const errors: string[] = [];

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
        // Load or create SyncState for this shop
        const syncState = await prisma.syncState.upsert({
          where: {shop},
          create: {shop, lastSyncedAt: new Date(Date.now() - 24 * 60 * 60 * 1000)},
          update: {},
        });

        const updatedSince = syncState.lastSyncedAt;
        const syncStart = new Date();

        // Fetch updated shipments from InstaWorld
        const iwShipments = await fetchInstaWorldShipments(updatedSince);
        if (iwShipments.length === 0) {
          await prisma.syncState.update({where: {shop}, data: {lastSyncedAt: syncStart}});
          continue;
        }

        // Get Shopify admin client for this shop
        const {admin} = await unauthenticated.admin(shop);

        for (const iwShipment of iwShipments) {
          const trackingNumber = iwShipment?.tracking_number;
          if (!trackingNumber) continue;

          const newStatus: string = iwShipment?.status?.code ?? "";
          if (!newStatus) continue;

          totalProcessed++;

          // Find our shipment record by tracking number
          const dbShipment = await prisma.shipment.findFirst({
            where: {shop, trackingNumber},
            include: {orders: true},
          });

          if (!dbShipment) continue; // Not our shipment

          // Skip if status hasn't changed
          if (dbShipment.instaworldStatus === newStatus) continue;

          const {shipmentStatus, shouldComplete, shouldCancel} =
            instaworldStatusToShopify(newStatus);

          try {
            const shopifyOrderIds = dbShipment.orders.map((o) => o.shopifyOrderId);

            if (!dbShipment.shopifyFulfillmentId) {
              // No fulfillment yet — create one now (booking may have happened before this feature)
              if (shopifyOrderIds.length > 0 && dbShipment.trackingNumber) {
                const fulfillmentId = await createShopifyFulfillment(
                  admin,
                  shopifyOrderIds,
                  dbShipment.trackingNumber,
                );
                if (fulfillmentId) {
                  await prisma.shipment.update({
                    where: {id: dbShipment.id},
                    data: {shopifyFulfillmentId: fulfillmentId, instaworldStatus: newStatus, lastSyncedAt: new Date()},
                  });
                  totalUpdated++;
                }
              }
              continue;
            }

            const fulfillmentId = dbShipment.shopifyFulfillmentId;

            if (shouldCancel) {
              await cancelShopifyFulfillment(admin, fulfillmentId);
            } else if (shouldComplete) {
              await completeShopifyFulfillment(admin, fulfillmentId);
            } else if (shipmentStatus) {
              await updateShopifyFulfillmentTracking(
                admin,
                fulfillmentId,
                trackingNumber,
                shipmentStatus,
              );
            }

            await prisma.shipment.update({
              where: {id: dbShipment.id},
              data: {
                instaworldStatus: newStatus,
                lastSyncedAt: new Date(),
                ...(shouldComplete ? {status: "delivered"} : {}),
                ...(shouldCancel ? {status: "cancelled"} : {}),
              },
            });

            totalUpdated++;
          } catch (shipmentError) {
            const msg = `Shipment ${trackingNumber}: ${shipmentError instanceof Error ? shipmentError.message : String(shipmentError)}`;
            errors.push(msg);
            console.error("[sync]", msg);
          }
        }

        // Update last sync time for this shop
        await prisma.syncState.update({where: {shop}, data: {lastSyncedAt: syncStart}});
      } catch (shopError) {
        const msg = `Shop ${shop}: ${shopError instanceof Error ? shopError.message : String(shopError)}`;
        errors.push(msg);
        console.error("[sync]", msg);
      }
    }
  } catch (fatal) {
    console.error("[sync] Fatal:", fatal);
    return jsonResp({error: "Sync failed", details: String(fatal)}, 500);
  }

  return jsonResp({
    ok: true,
    durationMs: Date.now() - startTime,
    processed: totalProcessed,
    updated: totalUpdated,
    errors,
  });
}
