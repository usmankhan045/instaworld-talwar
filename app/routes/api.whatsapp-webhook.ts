import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";
import prisma from "../db.server.ts";

export async function verifyWhatsAppWebhookSignature(body: string, signature: string | null, appSecret: string | undefined): Promise<boolean> {
  if (!signature || !appSecret || !signature.startsWith("sha256=")) return false;
  const provided = signature.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let different = expected.length === provided.length ? 0 : 1;
  for (let index = 0; index < Math.max(expected.length, provided.length); index++) {
    different |= (expected.charCodeAt(index) || 0) ^ (provided.toLowerCase().charCodeAt(index) || 0);
  }
  return different === 0;
}

export async function loader({request}: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return new Response(challenge || "", {status: 200});
  }
  return new Response("Forbidden", {status: 403});
}

export async function action({request}: ActionFunctionArgs) {
  const body = await request.text();
  if (body.length > 1_000_000 || !(await verifyWhatsAppWebhookSignature(body, request.headers.get("X-Hub-Signature-256"), process.env.WHATSAPP_APP_SECRET))) {
    return new Response("Unauthorized", {status: 401});
  }
  let payload: {object?: unknown; entry?: unknown[]};
  try {
    payload = JSON.parse(body) as {object?: unknown; entry?: unknown[]};
  } catch {
    return new Response("Bad Request", {status: 400});
  }
  if (!payload || payload.object !== "whatsapp_business_account") return Response.json({ok: true});
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const changes = entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as {changes?: unknown[]};
    return Array.isArray(candidate.changes) ? candidate.changes : [];
  });
  for (const change of changes) {
    const value = (change && typeof change === "object" && "value" in change && change.value && typeof change.value === "object")
      ? change.value as {statuses?: unknown[]; metadata?: {phone_number_id?: unknown}}
      : {};
    const phoneNumberId = value.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : null;
    for (const status of value.statuses || []) {
      if (!status || typeof status !== "object") continue;
      const rawStatus = status as {status?: unknown; id?: unknown; errors?: unknown[]};
      const eventType = String(rawStatus.status || "unknown");
      const providerMessageId = rawStatus.id ? String(rawStatus.id) : null;
      if (!providerMessageId || !["sent", "delivered", "read", "failed"].includes(eventType)) continue;
      await prisma.whatsAppWebhookEvent.createMany({
        data: [{providerMessageId, eventType, payloadJson: JSON.stringify(status)}],
        skipDuplicates: true,
      });
      if (providerMessageId) {
        await prisma.whatsAppNotification.updateMany({
          where: {
            providerMessageId,
            ...(phoneNumberId ? {account: {phoneNumberId}} : {}),
            status: eventType === "read" ? {in: ["sent", "delivered", "read"]} : eventType === "delivered" ? {in: ["sent", "delivered"]} : {in: ["sent", "processing"]},
          },
          data: {
            ...(eventType === "delivered" ? {status: "delivered", deliveredAt: new Date()} : {}),
            ...(eventType === "read" ? {status: "read", readAt: new Date()} : {}),
            ...(eventType === "failed" ? {status: "failed", lastError: JSON.stringify(rawStatus.errors || [])} : {}),
          },
        });
      }
    }
  }
  return Response.json({ok: true});
}
