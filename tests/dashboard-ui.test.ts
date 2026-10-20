import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

test("dashboard leads with account and surfaces essential delivery information", () => {
  const dashboard = readFileSync("app/routes/app._index.tsx", "utf8");
  const accountPosition = dashboard.indexOf("Connected InstaWorld account");
  const overviewPosition = dashboard.indexOf("Delivery overview");
  assert.ok(accountPosition >= 0 && accountPosition < overviewPosition);
  assert.match(dashboard, /Status synchronization/);
  assert.match(dashboard, /Pickup location/);
  assert.match(dashboard, /Courier availability/);
  assert.match(dashboard, /Recent shipments/);
  assert.match(dashboard, /Quick actions/);
  assert.match(dashboard, /isTerminalInstaWorldStatus/);
});
