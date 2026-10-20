import {getWhatsAppAccountConfig} from "./config.server.ts";
import type {WhatsAppAccountKey} from "./types.server.ts";

export type WhatsAppSendResult = {providerMessageId: string};

function normalizePhone(phone: string): string {
  const normalized = phone.replace(/[^\d]/g, "");
  if (!/^92\d{10}$/.test(normalized)) throw new Error("WhatsApp recipient phone number is invalid.");
  return normalized;
}

function receiptDocumentUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("WhatsApp receipt URL must use HTTPS.");
  return url.toString();
}

export async function sendWhatsAppTemplate(input: {
  accountKey: WhatsAppAccountKey;
  recipientPhone: string;
  templateName: string;
  languageCode: string;
  parameters: string[];
  documentUrl?: string;
}): Promise<WhatsAppSendResult> {
  const config = getWhatsAppAccountConfig(input.accountKey);
  if (!config?.enabled) throw new Error("WhatsApp automation is disabled or not configured.");
  const documentUrl = receiptDocumentUrl(input.documentUrl);
  const graphVersion = process.env.WHATSAPP_GRAPH_VERSION || "v23.0";

  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${config.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizePhone(input.recipientPhone),
      type: "template",
      template: {
        name: input.templateName,
        language: {code: input.languageCode},
        components: [
          ...(documentUrl
            ? [{type: "header", parameters: [{type: "document", document: {link: documentUrl}}]}]
            : []),
          ...(input.parameters.length > 0
            ? [{type: "body", parameters: input.parameters.map((text) => ({type: "text", text}))}]
            : []),
        ],
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload?.error?.message || `WhatsApp API returned HTTP ${response.status}.`));
  const providerMessageId = payload?.messages?.[0]?.id;
  if (!providerMessageId) throw new Error("WhatsApp API accepted the request without a message ID.");
  return {providerMessageId: String(providerMessageId)};
}
