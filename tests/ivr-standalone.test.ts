import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {buildCallAudioManifest} from "../app/lib/calling-audio.server.ts";
import {AsteriskTestProvider, handleAmiEvent, type AmiClient} from "../ivr-standalone/ami.ts";
import {renderDynamicAudio} from "../ivr-standalone/audio.ts";
import {IvrStore, validateTestJob} from "../ivr-standalone/store.ts";
import {isWithinPakistanCallingHours, processNextTestCall, SimulatedProvider} from "../ivr-standalone/worker.ts";

const allowed = new Set(["03001234567"]);
const input = {
  reference: "TEST-001",
  customerName: "Ali Khan",
  productSummary: "Hamtaa Handmade x 2",
  address: "House 12, Lahore, Punjab, Pakistan",
  phone: "03001234567",
};
const base = new Date("2026-10-16T10:00:00.000Z");

test("standalone calling respects Pakistan business hours", () => {
  assert.equal(isWithinPakistanCallingHours(new Date("2026-10-16T04:59:00Z")), false);
  assert.equal(isWithinPakistanCallingHours(new Date("2026-10-16T05:00:00Z")), true);
  assert.equal(isWithinPakistanCallingHours(new Date("2026-10-16T15:00:00Z")), false);
});

function event(attemptId: string, kind: Parameters<IvrStore["recordEvent"]>[0]["kind"], suffix = kind) {
  return {id: `${attemptId}:${suffix}`, attemptId, providerCallId: attemptId, kind};
}

test("standalone jobs accept only allowlisted test numbers and are idempotent", () => {
  const store = new IvrStore(":memory:");
  try {
    assert.throws(() => validateTestJob({...input, phone: "03009999999"}, allowed), /not in IVR_TEST_NUMBERS/);
    const first = store.createJob(validateTestJob(input, allowed), base);
    const again = store.createJob(validateTestJob(input, allowed), base);
    assert.equal(again.id, first.id);
    assert.equal(store.listJobs().length, 1);
    assert.throws(() => store.createJob({...input, customerName: "Someone Else"}, base), /different test job/);
  } finally { store.close(); }
});

test("test jobs and attempt history survive a standalone service restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "talwar-ivr-db-"));
  const path = join(directory, "ivr.sqlite");
  try {
    const first = new IvrStore(path);
    const job = first.createJob(validateTestJob(input, allowed), base);
    const attemptId = (await processNextTestCall(first, new SimulatedProvider(), base))!.attemptId;
    first.recordEvent(event(attemptId, "no_answer"), base);
    first.close();
    const reopened = new IvrStore(path);
    try {
      assert.equal(reopened.getJob(job.id)?.status, "queued");
      assert.equal(reopened.attemptsFor(job.id)[0].result, "no_answer");
    } finally { reopened.close(); }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test("simulated call confirms both choices in one attempt without booking", async () => {
  const store = new IvrStore(":memory:");
  const provider = new SimulatedProvider();
  try {
    const job = store.createJob(validateTestJob(input, allowed), base);
    const result = await processNextTestCall(store, provider, base);
    assert.equal(result?.job.id, job.id);
    assert.equal(provider.calls.length, 1);
    assert.match(provider.calls[0].greetingText, /Ali Khan/);
    assert.match(provider.calls[0].greetingText, /حماتا ہینڈ میڈ/);
    assert.match(provider.calls[0].addressText, /Lahore/);
    const attemptId = result!.attemptId;
    store.recordEvent(event(attemptId, "answered"), base);
    store.recordEvent(event(attemptId, "order_1"), base);
    const confirmation = store.recordEvent(event(attemptId, "address_1"), base);
    assert.equal(confirmation.job.status, "confirmed");
    assert.equal(store.attemptsFor(job.id)[0].result, "order_and_address_confirmed");
    assert.equal(store.attemptsFor(job.id)[0].addressText?.includes("Lahore"), true);
    assert.equal(store.recordEvent(event(attemptId, "address_1"), base).duplicate, true);
    assert.equal(store.recordEvent(event(attemptId, "hangup"), base).job.status, "confirmed");
    assert.equal(await processNextTestCall(store, provider, base), null);
  } finally { store.close(); }
});

test("missed call and a mid-call drop retry the same job, requiring both answers again", async () => {
  const store = new IvrStore(":memory:");
  const provider = new SimulatedProvider();
  try {
    const job = store.createJob(validateTestJob(input, allowed), base);
    const first = (await processNextTestCall(store, provider, base))!;
    const missed = store.recordEvent(event(first.attemptId, "no_answer"), base);
    assert.equal(missed.job.status, "queued");
    assert.equal(await processNextTestCall(store, provider, new Date(base.getTime() + 44 * 60_000)), null);
    const secondAt = new Date(base.getTime() + 45 * 60_000);
    const second = (await processNextTestCall(store, provider, secondAt))!;
    store.recordEvent(event(second.attemptId, "answered"), secondAt);
    store.recordEvent(event(second.attemptId, "order_1"), secondAt);
    const dropped = store.recordEvent(event(second.attemptId, "hangup"), secondAt);
    assert.equal(dropped.job.status, "queued");
    const thirdAt = new Date(secondAt.getTime() + 15 * 60_000);
    const third = (await processNextTestCall(store, provider, thirdAt))!;
    assert.equal(third.job.id, job.id);
    assert.equal(third.job.attemptCount, 3);
    store.recordEvent(event(third.attemptId, "answered"), thirdAt);
    assert.throws(() => store.recordEvent(event(third.attemptId, "address_1"), thirdAt), /out of order/);
    store.recordEvent(event(third.attemptId, "order_1"), thirdAt);
    assert.equal(store.recordEvent(event(third.attemptId, "address_1"), thirdAt).job.status, "confirmed");
    assert.equal(store.attemptsFor(job.id).length, 3);
  } finally { store.close(); }
});

test("third unanswered attempt stops in manual review", async () => {
  const store = new IvrStore(":memory:");
  const provider = new SimulatedProvider();
  try {
    const job = store.createJob(validateTestJob(input, allowed), base);
    for (let number = 0; number < 3; number++) {
      const now = new Date(base.getTime() + number * 45 * 60_000);
      const call = (await processNextTestCall(store, provider, now))!;
      store.recordEvent(event(call.attemptId, "no_answer"), now);
    }
    assert.equal(store.getJob(job.id)?.status, "manual_review");
    assert.equal(await processNextTestCall(store, provider, new Date(base.getTime() + 4 * 45 * 60_000)), null);
  } finally { store.close(); }
});

test("cancellation and address-change responses are final and never call again", async () => {
  for (const choice of ["order_2", "address_2"] as const) {
    const store = new IvrStore(":memory:");
    const provider = new SimulatedProvider();
    try {
      const job = store.createJob(validateTestJob(input, allowed), base);
      const call = (await processNextTestCall(store, provider, base))!;
      store.recordEvent(event(call.attemptId, "answered"), base);
      if (choice === "address_2") store.recordEvent(event(call.attemptId, "order_1"), base);
      store.recordEvent(event(call.attemptId, choice), base);
      assert.equal(store.getJob(job.id)?.status, choice === "order_2" ? "cancelled" : "address_change_required");
      assert.equal(await processNextTestCall(store, provider, new Date(base.getTime() + 86_400_000)), null);
    } finally { store.close(); }
  }
});

test("AMI keypad events confirm a test job once and ignore hangup after completion", async () => {
  const store = new IvrStore(":memory:");
  const provider = new SimulatedProvider();
  try {
    const job = store.createJob(validateTestJob(input, allowed), base);
    const attemptId = (await processNextTestCall(store, provider, base))!.attemptId;
    for (const kind of ["answered", "order_1", "address_1", "hangup", "hangup"]) {
      handleAmiEvent(store, {Event: "UserEvent", UserEvent: "TalwarIvr", AttemptId: attemptId, Kind: kind});
    }
    assert.equal(store.getJob(job.id)?.status, "confirmed");
    assert.equal(store.attemptsFor(job.id).length, 1);
  } finally { store.close(); }
});

test("AMI originate failure schedules retry on the same test job", async () => {
  const store = new IvrStore(":memory:");
  const provider = new SimulatedProvider();
  try {
    const job = store.createJob(validateTestJob(input, allowed), base);
    const attemptId = (await processNextTestCall(store, provider, base))!.attemptId;
    handleAmiEvent(store, {Event: "OriginateResponse", Response: "Failure", ActionID: attemptId});
    assert.equal(store.getJob(job.id)?.status, "queued");
    assert.equal(store.attemptsFor(job.id)[0].result, "no_answer");
  } finally { store.close(); }
});

test("an Asterisk result arriving during originate is not overwritten by its later failure", async () => {
  const store = new IvrStore(":memory:");
  try {
    const job = store.createJob(validateTestJob(input, allowed), base);
    const provider = {
      async originate(request: {attemptId: string}) {
        store.recordEvent(event(request.attemptId, "no_answer"), base);
        throw new Error("originate failed after event delivery");
      },
    };
    await processNextTestCall(store, provider, base);
    assert.equal(store.getJob(job.id)?.status, "queued");
    assert.equal(store.attemptsFor(job.id)[0].result, "no_answer");
  } finally { store.close(); }
});

test("Asterisk adapter sends only rendered test audio and a configured caller ID", async () => {
  let fields: Array<[string, string]> = [];
  const fakeAmi = {action: async (value: Array<[string, string]>) => { fields = value; return {Response: "Success"}; }} as unknown as AmiClient;
  const provider = new AsteriskTestProvider(fakeAmi, {trunk: "test-trunk", callerId: "03001234567", allowedNumbers: allowed});
  await provider.originate({
    callId: "attempt-1", attemptId: "attempt-1", destination: "03001234567",
    greetingText: "Greeting", addressText: "Address",
    audioFiles: {greeting: "/var/lib/asterisk/sounds/talwar/generated/abc.wav", address: "/var/lib/asterisk/sounds/talwar/generated/def.wav"},
  });
  assert.ok(fields.some(([key, value]) => key === "Channel" && value === "PJSIP/03001234567@test-trunk"));
  assert.ok(fields.some(([key, value]) => key === "CallerID" && value === "03001234567"));
  assert.ok(fields.some(([key, value]) => key === "Context" && value === "talwar-ivr-test"));
  assert.ok(fields.some(([key, value]) => key === "Variable" && value.includes("IVR_GREETING=")));
  await assert.rejects(() => provider.originate({callId: "2", attemptId: "2", destination: "03001234567", greetingText: "x", addressText: "y"}), /rendered audio is required/);
  await assert.rejects(() => provider.originate({callId: "3", attemptId: "3", destination: "03009999999", greetingText: "x", addressText: "y"}), /approved test number/);
});

test("removing a number from the current allowlist blocks queued test calls", async () => {
  const store = new IvrStore(":memory:");
  const provider = new SimulatedProvider();
  try {
    const job = store.createJob(validateTestJob(input, allowed), base);
    const result = await processNextTestCall(store, provider, base, undefined, new Set());
    assert.equal(result?.job.status, "manual_review");
    assert.equal(store.attemptsFor(job.id)[0].result, "number_not_allowlisted");
    assert.equal(provider.calls.length, 0);
  } finally { store.close(); }
});

test("lost PBX events hold an unresolved call for review without redialing", async () => {
  const store = new IvrStore(":memory:");
  const provider = new SimulatedProvider();
  try {
    const job = store.createJob(validateTestJob(input, allowed), base);
    await processNextTestCall(store, provider, base);
    assert.equal(store.holdStaleCallsForReview(new Date(base.getTime() + 61 * 60_000)), 1);
    assert.equal(store.getJob(job.id)?.status, "manual_review");
    assert.equal(store.attemptsFor(job.id)[0].result, "event_timeout");
    assert.equal(await processNextTestCall(store, provider, new Date(base.getTime() + 62 * 60_000)), null);
  } finally { store.close(); }
});

test("audio renderer converts and caches private 8 kHz mono WAV", {skip: spawnSync("ffmpeg", ["-version"]).status !== 0}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "talwar-ivr-audio-"));
  try {
    const model = join(directory, "voice.onnx");
    writeFileSync(model, "fixture model");
    const manifest = buildCallAudioManifest({id: "job-fixture", shopifyOrderNumber: "TEST", customerName: "Ali", productSummary: "Shawl", normalizedAddress: "House 1 Lahore"});
    const config = {piperExecutable: new URL("./fixtures/fake-piper.mjs", import.meta.url).pathname, modelPath: model, ffmpegExecutable: "ffmpeg", privateSoundDir: join(directory, "sounds")};
    const first = await renderDynamicAudio(manifest, config);
    const second = await renderDynamicAudio(manifest, config);
    assert.deepEqual(second, first);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate,channels", "-of", "default=noprint_wrappers=1", first.greeting], {encoding: "utf8"});
    assert.equal(probe.status, 0);
    assert.match(probe.stdout, /sample_rate=8000/);
    assert.match(probe.stdout, /channels=1/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test("missing TTS model fails closed before a call is originated", async () => {
  const store = new IvrStore(":memory:");
  const provider = new SimulatedProvider();
  try {
    const job = store.createJob(validateTestJob(input, allowed), base);
    const result = await processNextTestCall(store, provider, base, {
      piperExecutable: "piper",
      modelPath: "/nonexistent/talwar-test-voice.onnx",
      ffmpegExecutable: "ffmpeg",
      privateSoundDir: "/tmp/talwar-test-audio",
    });
    assert.equal(result?.job.status, "queued");
    assert.equal(provider.calls.length, 0);
    assert.equal(store.attemptsFor(job.id)[0].result, "audio_failed");
  } finally { store.close(); }
});
