import {resolve} from "node:path";

import {buildCallAudioManifest} from "../app/lib/calling-audio.server.ts";
import {renderDynamicAudio} from "./audio.ts";

const modelPath = process.env.PIPER_MODEL;
if (!modelPath) throw new Error("PIPER_MODEL is required for local audio preview");

const manifest = buildCallAudioManifest({
  id: "fictional-preview",
  shopifyOrderNumber: "TEST-ONLY",
  customerName: "Ali Khan",
  productSummary: "Hamtaa Handmade x 2",
  normalizedAddress: "House 12, Lahore, Punjab, Pakistan",
});

const files = await renderDynamicAudio(manifest, {
  piperExecutable: process.env.PIPER_EXECUTABLE || "piper",
  modelPath: resolve(modelPath),
  ffmpegExecutable: process.env.FFMPEG_EXECUTABLE || "ffmpeg",
  privateSoundDir: resolve(process.env.IVR_PREVIEW_DIR || "./var/ivr-preview"),
});

process.stdout.write(`LOCAL AUDIO PREVIEW ONLY — fictional data, no calls\nGreeting: ${manifest.dynamicSegments[0].text}\nWAV: ${files.greeting}\nAddress: ${manifest.dynamicSegments[1].text}\nWAV: ${files.address}\n`);
