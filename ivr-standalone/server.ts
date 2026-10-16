import {timingSafeEqual} from "node:crypto";
import {statSync} from "node:fs";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {join} from "node:path";

import {FIXED_IVR_RECORDINGS} from "../app/lib/calling-audio.server.ts";
import {AmiClient, AsteriskTestProvider, handleAmiEvent} from "./ami.ts";
import {pruneGeneratedAudio, type AudioConfig} from "./audio.ts";
import {IvrStore, validateTestJob, type CallEventKind} from "./store.ts";
import {processNextTestCall, SimulatedProvider, type CallProvider} from "./worker.ts";

const token = process.env.IVR_ADMIN_TOKEN;
const numbers = new Set((process.env.IVR_TEST_NUMBERS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
if (!token || token.length < 24) throw new Error("IVR_ADMIN_TOKEN must contain at least 24 characters");
if (numbers.size === 0) throw new Error("IVR_TEST_NUMBERS must list approved test numbers");

const store = new IvrStore(process.env.IVR_DB_PATH || "./var/ivr-test.sqlite");
const host = process.env.IVR_HOST || "127.0.0.1";
const port = Number(process.env.IVR_PORT || 8787);
if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("standalone IVR HTTP API must bind to loopback");
const providerMode = process.env.IVR_PROVIDER || "simulated";
let provider: CallProvider;
let audioConfig: AudioConfig | undefined;
let ami: AmiClient | undefined;
if (providerMode === "simulated") {
  provider = new SimulatedProvider();
} else if (providerMode === "asterisk" && process.env.IVR_LIVE_TEST_CALLS === "yes") {
  const required = ["AMI_USERNAME", "AMI_SECRET", "IVR_TRUNK", "IVR_CALLER_ID", "PIPER_MODEL", "IVR_SOUND_DIR"] as const;
  for (const key of required) if (!process.env[key]) throw new Error(`${key} is required for test PBX mode`);
  const fixedDir = process.env.IVR_FIXED_SOUND_DIR || "/var/lib/asterisk/sounds/talwar";
  for (const recording of Object.values(FIXED_IVR_RECORDINGS)) {
    if (statSync(join(fixedDir, recording.fileKey)).size <= 44) throw new Error(`fixed recording is empty: ${recording.fileKey}`);
  }
  audioConfig = {
    piperExecutable: process.env.PIPER_EXECUTABLE || "piper",
    modelPath: process.env.PIPER_MODEL!,
    ffmpegExecutable: process.env.FFMPEG_EXECUTABLE || "ffmpeg",
    privateSoundDir: process.env.IVR_SOUND_DIR!,
  };
  ami = new AmiClient({
    host: process.env.AMI_HOST || "127.0.0.1",
    port: Number(process.env.AMI_PORT || 5038),
    username: process.env.AMI_USERNAME!,
    secret: process.env.AMI_SECRET!,
  }, (frame) => {
    try { handleAmiEvent(store, frame); } catch { process.stderr.write("AMI event needs review\n"); }
  });
  await ami.open();
  provider = new AsteriskTestProvider(ami, {trunk: process.env.IVR_TRUNK!, callerId: process.env.IVR_CALLER_ID!, allowedNumbers: numbers});
} else {
  throw new Error("IVR_PROVIDER must be simulated, or asterisk with IVR_LIVE_TEST_CALLS=yes");
}

function authorized(request: IncomingMessage): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer /i, "") || "";
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token!);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 32_768) throw new Error("request is too large");
  }
  const parsed: unknown = JSON.parse(body || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required");
  return parsed as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"});
  response.end(JSON.stringify(value));
}

const validEvents = new Set<CallEventKind>([
  "answered", "order_1", "order_2", "address_1", "address_2", "no_answer", "busy", "hangup", "failed", "no_input", "invalid_input",
]);

const server = createServer(async (request, response) => {
  if (!authorized(request)) return send(response, 401, {error: "Unauthorized"});
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  try {
    if (request.method === "POST" && url.pathname === "/jobs") {
      const input = validateTestJob(await jsonBody(request), numbers);
      return send(response, 201, store.createJob(input));
    }
    if (request.method === "GET" && url.pathname === "/jobs") return send(response, 200, store.listJobs());
    if (request.method === "GET" && /^\/jobs\/[^/]+$/.test(url.pathname)) {
      const job = store.getJob(url.pathname.slice(6));
      return job ? send(response, 200, {job, attempts: store.attemptsFor(job.id)}) : send(response, 404, {error: "Job not found"});
    }
    if (request.method === "POST" && url.pathname === "/tick") {
      const result = await processNextTestCall(store, provider, new Date(), audioConfig, numbers);
      return send(response, 200, {result});
    }
    if (request.method === "POST" && url.pathname === "/events") {
      const body = await jsonBody(request);
      if (typeof body.id !== "string" || typeof body.attemptId !== "string" || typeof body.providerCallId !== "string" || !validEvents.has(body.kind as CallEventKind)) {
        throw new Error("id, attemptId, providerCallId and valid kind are required");
      }
      return send(response, 200, store.recordEvent({id: body.id, attemptId: body.attemptId, providerCallId: body.providerCallId, kind: body.kind as CallEventKind}));
    }
    return send(response, 404, {error: "Not found"});
  } catch (error) {
    return send(response, 400, {error: error instanceof Error ? error.message : "Invalid request"});
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Standalone IVR (${providerMode}) listening on ${host}:${port}\n`);
});

store.holdStaleCallsForReview();
if (audioConfig) void pruneGeneratedAudio(audioConfig.privateSoundDir).catch(() => {});
const tick = setInterval(() => {
  store.holdStaleCallsForReview();
  void processNextTestCall(store, provider, new Date(), audioConfig, numbers).catch(() => {
    process.stderr.write("Standalone IVR tick failed; inspect job state\n");
  });
}, 30_000);
const audioCleanup = setInterval(() => {
  if (audioConfig) void pruneGeneratedAudio(audioConfig.privateSoundDir).catch(() => {});
}, 86_400_000);

function shutdown() {
  clearInterval(tick);
  clearInterval(audioCleanup);
  ami?.close();
  server.close(() => store.close());
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
