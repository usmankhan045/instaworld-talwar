import assert from "node:assert/strict";
import test from "node:test";

import {runLocalRehearsal} from "../ivr-standalone/rehearse.ts";

test("local rehearsal covers the full call decisions without any network call", async () => {
  const output = await runLocalRehearsal();
  assert.match(output, /LOCAL SIMULATION ONLY/);
  assert.match(output, /حماتا ہینڈ میڈ/);
  assert.match(output, /House 12, Lahore, Punjab, Pakistan/);
  assert.match(output, /Scenario: cancelled[\s\S]*PASS: cancelled/);
  assert.doesNotMatch(output.split("Scenario: cancelled")[1].split("PASS: cancelled")[0], /Address:/);
  assert.match(output, /Scenario: wrong address[\s\S]*PASS: address_change_required/);
  assert.match(output, /Scenario: missed then confirmed[\s\S]*no_answer → queued[\s\S]*Attempt 2[\s\S]*PASS: confirmed/);
  assert.doesNotMatch(output.split("Scenario: missed then confirmed")[1].split("Attempt 2")[0], /Greeting:|Address:/);
  assert.match(output, /Scenario: dropped then confirmed[\s\S]*hangup → queued[\s\S]*Attempt 2[\s\S]*PASS: confirmed/);
  assert.match(output, /PASS: 6 scenarios, 8 simulated attempts, zero network calls/);
});
