import type {WhatsAppAccountKey} from "./types.server.ts";

export type WhatsAppAccountConfig = {
  accountKey: WhatsAppAccountKey;
  phoneNumberId: string;
  accessToken: string;
  enabled: boolean;
};

function bool(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function getWhatsAppAccountConfig(accountKey: WhatsAppAccountKey): WhatsAppAccountConfig | null {
  const prefix = accountKey === "food" ? "WHATSAPP_FOOD" : "WHATSAPP_STORE";
  const phoneNumberId = process.env[`${prefix}_PHONE_NUMBER_ID`] || "";
  const accessToken = process.env[`${prefix}_ACCESS_TOKEN`] || "";
  if (!phoneNumberId || !accessToken) return null;
  return {
    accountKey,
    phoneNumberId,
    accessToken,
    enabled: bool(process.env.WHATSAPP_AUTOMATION_ENABLED),
  };
}

export function isWhatsAppAutomationEnabled(): boolean {
  return bool(process.env.WHATSAPP_AUTOMATION_ENABLED);
}
