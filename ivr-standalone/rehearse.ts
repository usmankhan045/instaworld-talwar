import assert from "node:assert/strict";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

import {FIXED_IVR_RECORDINGS} from "../app/lib/calling-audio.server.ts";
import {IvrStore, validateTestJob, type CallEventKind, type JobStatus} from "./store.ts";
import {processNextTestCall, SimulatedProvider} from "./worker.ts";

type Rehearsal = {name: string; attempts: CallEventKind[][]; expected: JobStatus};

const scenarios: Rehearsal[] = [
  {name: "confirmed", attempts: [["answered", "order_1", "address_1"]], expected: "confirmed"},
  {name: "cancelled", attempts: [["answered", "order_2"]], expected: "cancelled"},
  {name: "wrong address", attempts: [["answered", "order_1", "address_2"]], expected: "address_change_required"},
  {name: "missed then confirmed", attempts: [["no_answer"], ["answered", "order_1", "address_1"]], expected: "confirmed"},
  {name: "dropped then confirmed", attempts: [["answered", "order_1", "hangup"], ["answered", "order_1", "address_1"]], expected: "confirmed"},
  {name: "invalid keypad", attempts: [["answered", "invalid_input"]], expected: "manual_review"},
];

const dummyPhone = "03000000000";
const allowed = new Set([dummyPhone]);
const start = new Date("2026-10-16T05:00:00.000Z"); // 10:00 Pakistan time

/** No network, audio device, or persistent database is used by this rehearsal. */
export async function runLocalRehearsal(): Promise<string> {
  const store = new IvrStore(":memory:");
  const provider = new SimulatedProvider();
  const lines = ["LOCAL SIMULATION ONLY — fictional customer, no calls, no Shopify orders"];
  try {
    for (const [index, scenario] of scenarios.entries()) {
      const job = store.createJob(validateTestJob({
        reference: `REHEARSAL-${index + 1}`,
        customerName: "Ali Khan",
        productSummary: "Hamtaa Handmade x 2",
        address: "House 12, Lahore, Punjab, Pakistan",
        phone: dummyPhone,
      }, allowed), start);
      lines.push(`\nScenario: ${scenario.name}`);
      for (const [attemptIndex, steps] of scenario.attempts.entries()) {
        const at = new Date(start.getTime() + attemptIndex * 60 * 60_000);
        const call = await processNextTestCall(store, provider, at, undefined, allowed);
        assert.ok(call, `${scenario.name}: attempt ${attemptIndex + 1} was not scheduled`);
        const attempt = store.attemptsFor(job.id)[0];
        lines.push(`Attempt ${attemptIndex + 1}`);
        for (const [stepIndex, kind] of steps.entries()) {
          if (kind === "answered") {
            lines.push(`Greeting: ${attempt.greetingText}`);
            lines.push(`Order choice: ${FIXED_IVR_RECORDINGS.orderChoice.script}`);
          } else if (kind === "order_1") {
            lines.push(`Address: ${attempt.addressText}`);
            lines.push(`Address choice: ${FIXED_IVR_RECORDINGS.addressChoice.script}`);
          } else if (kind === "order_2") {
            lines.push(`Closing: ${FIXED_IVR_RECORDINGS.orderCancelled.script}`);
          } else if (kind === "address_1") {
            lines.push(`Closing: ${FIXED_IVR_RECORDINGS.orderConfirmed.script}`);
          } else if (kind === "address_2") {
            lines.push(`Closing: ${FIXED_IVR_RECORDINGS.addressNeedsReview.script}`);
          } else if (kind === "invalid_input") {
            lines.push(`Retry prompt: ${FIXED_IVR_RECORDINGS.invalidInput.script}`);
          }
          const result = store.recordEvent({
            id: `${attempt.id}:${stepIndex}:${kind}`,
            attemptId: attempt.id,
            providerCallId: attempt.id,
            kind,
          }, at);
          lines.push(`  ${kind} → ${result.job.status}`);
        }
      }
      assert.equal(store.getJob(job.id)?.status, scenario.expected, scenario.name);
      lines.push(`PASS: ${scenario.expected}`);
    }
    assert.equal(provider.calls.length, scenarios.reduce((sum, scenario) => sum + scenario.attempts.length, 0));
    lines.push(`\nPASS: ${scenarios.length} scenarios, ${provider.calls.length} simulated attempts, zero network calls`);
    return lines.join("\n");
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLocalRehearsal().then((output) => process.stdout.write(`${output}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
