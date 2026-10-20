import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNotificationPlan,
  buildStatusNotificationPlan,
  eventForInstaWorldStatus,
} from "../app/lib/whatsapp/rules.server.ts";
import {getWhatsAppAccountConfig} from "../app/lib/whatsapp/config.server.ts";
import {sendWhatsAppTemplate} from "../app/lib/whatsapp/client.server.ts";
import {verifyWhatsAppWebhookSignature} from "../app/routes/api.whatsapp-webhook.ts";

const snapshot = {
  shop: "talwar.myshopify.com",
  accountKey: "store" as const,
  orderNumber: "1143",
  recipientPhone: "03001234567",
  recipientName: "Ali Khan",
  trackingNumber: "IW123",
  city: "Lahore",
  amountDue: 5200,
  currencyCode: "PKR",
};

test("maps delivery failure to an immediate recovery notification", () => {
  assert.equal(eventForInstaWorldStatus("DELIVERY_ATTEMPT_FAILED"), "delivery_failed");
  assert.equal(eventForInstaWorldStatus("DELIVERY_FAILED"), "delivery_failed");
  const plan = buildStatusNotificationPlan({...snapshot, status: "DELIVERY_ATTEMPT_FAILED"});
  assert.equal(plan?.templateName, "delivery_attempt_failed");
  assert.deepEqual(plan?.parameters.slice(-1), ["Lahore"]);
});

test("builds a receipt notification with the receipt document", () => {
  const plan = buildNotificationPlan("receipt_ready", {...snapshot, receiptUrl: "https://example.test/receipt.pdf"});
  assert.equal(plan.templateName, "order_receipt_ready");
  assert.equal(plan.documentUrl, "https://example.test/receipt.pdf");
  assert.deepEqual(plan.parameters.slice(-2), ["5200", "PKR"]);
});

test("does not enable WhatsApp without credentials and explicit opt-in", () => {
  const previous = {...process.env};
  delete process.env.WHATSAPP_STORE_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_STORE_ACCESS_TOKEN;
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  process.env.WHATSAPP_AUTOMATION_ENABLED = "true";
  assert.equal(getWhatsAppAccountConfig("store"), null);
  process.env.WHATSAPP_ACCESS_TOKEN = "must-not-be-used-as-a-shared-fallback";
  assert.equal(getWhatsAppAccountConfig("food"), null);
  process.env = previous;
});

test("requires an authenticated Meta webhook signature", () => {
  return crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]).then(async (key) => {
    const body = JSON.stringify({object: "whatsapp_business_account"});
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    const signature = "sha256=" + Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    assert.equal(await verifyWhatsAppWebhookSignature(body, signature, "secret"), true);
    assert.equal(await verifyWhatsAppWebhookSignature(body, signature, "wrong-secret"), false);
    assert.equal(await verifyWhatsAppWebhookSignature(body, "sha256=bad", "secret"), false);
    assert.equal(await verifyWhatsAppWebhookSignature(body, null, "secret"), false);
  });
});

test("rejects invalid recipients and non-HTTPS receipt URLs before calling Meta", async () => {
  const previous = {...process.env};
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({messages: [{id: "wamid.test"}]});
  };
  process.env.WHATSAPP_AUTOMATION_ENABLED = "true";
  process.env.WHATSAPP_STORE_PHONE_NUMBER_ID = "phone-id";
  process.env.WHATSAPP_STORE_ACCESS_TOKEN = "token";
  await assert.rejects(() => sendWhatsAppTemplate({
    accountKey: "store", recipientPhone: "03001234567", templateName: "test", languageCode: "en_US", parameters: [],
  }), /invalid/);
  await assert.rejects(() => sendWhatsAppTemplate({
    accountKey: "store", recipientPhone: "+923001234567", templateName: "test", languageCode: "en_US", parameters: [], documentUrl: "http://example.test/receipt.pdf",
  }), /HTTPS/);
  assert.equal(calls, 0);
  globalThis.fetch = originalFetch;
  process.env = previous;
});
