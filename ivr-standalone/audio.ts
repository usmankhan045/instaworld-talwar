import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {chmod, mkdir, readdir, rename, stat, unlink} from "node:fs/promises";
import {join, resolve} from "node:path";

import type {CallAudioManifest} from "../app/lib/calling-audio.server.ts";

export type AudioConfig = {
  piperExecutable: string;
  modelPath: string;
  ffmpegExecutable: string;
  privateSoundDir: string;
};

function run(command: string, args: string[], input?: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {stdio: ["pipe", "ignore", "pipe"]});
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => { errorText = (errorText + chunk.toString()).slice(-2000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}: ${errorText}`)));
    child.stdin.end(input);
  });
}

async function nonempty(path: string): Promise<boolean> {
  try { return (await stat(path)).size > 44; } catch { return false; }
}

/**
 * Render only per-order text. Files are private mono 8 kHz PCM WAV for
 * Asterisk, cached by model identity and exact spoken text.
 */
export async function renderDynamicAudio(manifest: CallAudioManifest, config: AudioConfig): Promise<{greeting: string; address: string}> {
  const directory = resolve(config.privateSoundDir);
  const model = await stat(config.modelPath);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const output: Record<string, string> = {};
  for (const segment of manifest.dynamicSegments) {
    const hash = createHash("sha256").update(`${config.modelPath}:${model.size}:${model.mtimeMs}:${segment.text}`).digest("hex");
    const target = join(directory, `${hash}.wav`);
    if (!await nonempty(target)) {
      const temporary = join(directory, `${hash}-${process.pid}-${Date.now()}.wav`);
      const converted = `${temporary}.converted.wav`;
      try {
        await run(config.piperExecutable, ["--model", config.modelPath, "--output_file", temporary], segment.text);
        await run(config.ffmpegExecutable, ["-nostdin", "-loglevel", "error", "-y", "-i", temporary, "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le", converted]);
        if (!await nonempty(converted)) throw new Error("generated audio is empty");
        await chmod(converted, 0o600);
        await rename(converted, target);
      } finally {
        await unlink(temporary).catch(() => {});
        await unlink(converted).catch(() => {});
      }
    }
    output[segment.key] = target;
  }
  if (!output.greeting || !output.address) throw new Error("greeting and address audio are required");
  return {greeting: output.greeting, address: output.address};
}

export async function pruneGeneratedAudio(directory: string, now = new Date(), maxAgeMs = 7 * 86_400_000): Promise<number> {
  let removed = 0;
  for (const name of await readdir(directory).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.wav$/.test(name)) continue;
    const path = join(directory, name);
    if (now.getTime() - (await stat(path)).mtimeMs > maxAgeMs) {
      await unlink(path);
      removed++;
    }
  }
  return removed;
}
