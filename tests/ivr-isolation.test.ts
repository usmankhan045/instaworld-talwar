import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

test("Shopify order creation cannot enqueue standalone IVR calls", () => {
  const config = readFileSync(new URL("../shopify.app.toml", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/routes/webhooks.orders.create.tsx", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../app/lib/calling-worker.server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(config, /topics\s*=\s*\[[^\]]*orders\/create/);
  assert.doesNotMatch(route, /callJob\.(create|upsert|update)|buildCallJobInput/);
  assert.doesNotMatch(worker, /prisma\.callJob|tx\.callJob|db\.callJob/);
});
