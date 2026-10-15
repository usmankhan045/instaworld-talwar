import test from "node:test";
import assert from "node:assert/strict";
import { stringifyForInstaWorld } from "../app/lib/instaworld.server.ts";

test("escapes Urdu as ASCII JSON while preserving the original value", () => {
  const original = { consignee: { address: "وفاقی دارالحکومت اسلام آباد" } };
  const wirePayload = stringifyForInstaWorld(original);

  assert.equal(/[^\x00-\x7F]/.test(wirePayload), false);
  assert.match(wirePayload, /\\u0648/);
  assert.deepEqual(JSON.parse(wirePayload), original);
});

test("leaves ordinary InstaWorld JSON unchanged", () => {
  const payload = { city: "ISLAMABAD", remarks: "allow to open", amount: 7200 };
  assert.equal(stringifyForInstaWorld(payload), JSON.stringify(payload));
});
