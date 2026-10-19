import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const APP_CONFIGS = [
  "shopify.app.toml",
  "shopify.app.private.toml",
  "shopify.app.partner.toml",
  "shopify.app.talwar-organics-instaworld.toml",
];

test("all Shopify app configurations request scopes required by fulfillment sync", () => {
  for (const configPath of APP_CONFIGS) {
    const config = readFileSync(configPath, "utf8");
    const scopes = config.match(/^scopes\s*=\s*"([^"]+)"/m)?.[1].split(",") ?? [];

    assert.ok(scopes.includes("write_fulfillments"), `${configPath} must request write_fulfillments`);
    assert.ok(
      scopes.includes("write_merchant_managed_fulfillment_orders"),
      `${configPath} must request write_merchant_managed_fulfillment_orders`,
    );
  }
});

test("runtime required scopes include fulfillment event access", () => {
  const serverSource = readFileSync("app/shopify.server.ts", "utf8");
  assert.match(serverSource, /requiredScopes\s*=\s*\[[\s\S]*"write_fulfillments"/);
});
