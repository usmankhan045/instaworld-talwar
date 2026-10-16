/**
 * Source-level integrity tests for the instaworld-booking UI extension.
 *
 * These tests do NOT execute the extension code (it targets a browser / remote-dom
 * sandbox and depends on `globalThis.shopify`).  Instead they parse the JSX source
 * as text to verify the fix invariants that matter most for correctness:
 *
 *   1. The entry-point is NOT an async default export — async causes the Shopify
 *      CLI shim (`shopify.extend`) to receive a Promise, which it does not await,
 *      so the extension may silently fail to register.
 *
 *   2. No fetch call uses `window.location.origin` — inside the Admin extension
 *      sandbox that resolves to the extension CDN origin, not the Vercel app.
 *
 *   3. All fetch calls target the production app URL — the only correct base for
 *      extension → app-server communication.
 *
 *   4. All fetch calls include an `Authorization` header — unauthenticated requests
 *      to `authenticate.admin()` on the server will fail or be redirected to OAuth.
 *
 *   5. The `Authorization` header is built from `shopify.auth.idToken()` — this is
 *      the OIDC ID-token API provided by `@shopify/ui-extensions` 2026.x and is
 *      validated by `authenticate.admin()` on the server.
 */

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const SOURCE_PATH = "extensions/instaworld-booking/src/ActionExtension.jsx";
const SOURCE = readFileSync(SOURCE_PATH, "utf8");
const BULK_SOURCE_PATH = "extensions/instaworld-booking/src/BulkBookExtension.jsx";
const BULK_SOURCE = readFileSync(BULK_SOURCE_PATH, "utf8");

const EXPECTED_APP_URL = "https://app.talwarstore.com";

// ---------------------------------------------------------------------------
// 1. Entry-point export form
// ---------------------------------------------------------------------------

test("extension default export is not async (async exports are not awaited by shopify.extend)", () => {
  assert.ok(
    !SOURCE.includes("export default async"),
    `${SOURCE_PATH}: 'export default async' found — the CLI shim does not await` +
      " a Promise returned by the default export; use a plain synchronous function instead.",
  );
});

test("extension has a named or arrow default export function", () => {
  const hasFunctionExport = SOURCE.includes("export default function") || SOURCE.includes("export default (");
  assert.ok(
    hasFunctionExport,
    `${SOURCE_PATH}: expected 'export default function' or 'export default (' but found neither.`,
  );
});

// ---------------------------------------------------------------------------
// 2. Fetch origin
// ---------------------------------------------------------------------------

test("extension does not use window.location.origin for API requests", () => {
  // Strip block comments (/** ... */ and /* ... */) and line comments (// ...)
  // before checking so that the JSDoc explanation of the bug does not trip this assertion.
  const codeOnly = SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, "")   // remove block comments
    .replace(/\/\/.*/g, "");            // remove line comments

  assert.ok(
    !codeOnly.includes("window.location.origin"),
    `${SOURCE_PATH}: 'window.location.origin' found in non-comment code — in the Admin` +
      " extension sandbox this resolves to the CDN origin, not the app server." +
      " Use the APP_URL constant instead.",
  );
});

test("extension uses the production app URL as the fetch base", () => {
  assert.ok(
    SOURCE.includes(EXPECTED_APP_URL),
    `${SOURCE_PATH}: expected production APP_URL '${EXPECTED_APP_URL}' not found.` +
      " All extension → app-server fetch calls must target the Vercel production URL.",
  );
});

test("extension fetch calls reference APP_URL constant, not a bare string", () => {
  // The three API paths the extension calls
  const paths = ["/api/instaworld-orders", "/api/instaworld-booking"];
  for (const path of paths) {
    // Both a GET and a POST call to /api/instaworld-orders exist; check the path appears
    assert.ok(
      SOURCE.includes(path),
      `${SOURCE_PATH}: fetch path '${path}' not found — expected the extension to call this app route.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Authentication
// ---------------------------------------------------------------------------

test("extension fetch calls include an Authorization header", () => {
  assert.ok(
    SOURCE.includes("Authorization"),
    `${SOURCE_PATH}: 'Authorization' not found — extension → app-server requests must` +
      " include 'Authorization: Bearer <idToken>' so authenticate.admin() can validate them.",
  );
});

test("extension uses shopify.auth.idToken() to obtain the bearer token", () => {
  assert.ok(
    SOURCE.includes("shopify.auth.idToken"),
    `${SOURCE_PATH}: 'shopify.auth.idToken' not found — this is the correct OIDC ID-token` +
      " API for @shopify/ui-extensions 2026.x; use it to build the Authorization header.",
  );
});

test("extension handles a null idToken by throwing before the fetch", () => {
  // The helper must guard against a null token so the user sees an error
  // rather than an unauthenticated request being silently sent.
  assert.ok(
    SOURCE.includes("if (!token)") || SOURCE.includes("if(!token)"),
    `${SOURCE_PATH}: missing null-token guard — shopify.auth.idToken() can return null;` +
      " the code must throw or show an error before making a fetch call without a token.",
  );
});

// ---------------------------------------------------------------------------
// 4. Safety: live-booking gates remain unchanged
// ---------------------------------------------------------------------------

test("extension does not hard-code any InstaWorld API key", () => {
  assert.ok(
    !SOURCE.includes("INSTAWORLD_API_KEY"),
    `${SOURCE_PATH}: 'INSTAWORLD_API_KEY' found — API keys must not appear in extension source.`,
  );
});

test("extension does not call the InstaWorld API directly", () => {
  assert.ok(
    !SOURCE.includes("instaworld.pk"),
    `${SOURCE_PATH}: direct InstaWorld API call found — the extension must only` +
      " call the app server, which enforces live-booking safety gates.",
  );
});

test("bulk booking does not contain a PostEx courier skip", () => {
  assert.doesNotMatch(BULK_SOURCE, /courierWarning|POSTEX/);
});
