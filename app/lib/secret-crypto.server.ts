import {createCipheriv, createDecipheriv, randomBytes} from "node:crypto";

function key(): Buffer {
  const raw = process.env.INSTAWORLD_CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) throw new Error("INSTAWORLD_CREDENTIALS_ENCRYPTION_KEY is required to store courier credentials.");
  const value = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (value.length !== 32) throw new Error("INSTAWORLD_CREDENTIALS_ENCRYPTION_KEY must be a 32-byte base64 or 64-character hex key.");
  return value;
}

export function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(value: string): string {
  const [ivText, tagText, encryptedText] = value.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("Stored courier credential is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}
