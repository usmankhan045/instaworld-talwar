import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

test("overdue screen refreshes inexpensive cached app data while visible", () => {
  const screen = readFileSync("app/routes/app.overdue-orders.tsx", "utf8");

  assert.match(screen, /useRevalidator/);
  assert.match(screen, /setInterval\(refresh, 5 \* 60_000\)/);
  assert.match(screen, /document\.visibilityState === "visible"/);
  assert.match(screen, /visibilitychange/);
  assert.match(screen, /revalidator\.revalidate\(\)/);
  assert.doesNotMatch(screen, /listAllInstaWorldShipments/);
});
