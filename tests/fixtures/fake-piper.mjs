#!/usr/bin/env node
import {writeFileSync} from "node:fs";

const target = process.argv[process.argv.indexOf("--output_file") + 1];
if (!target) process.exit(2);
const samples = 8000;
const pcm = Buffer.alloc(samples * 2);
for (let index = 0; index < samples; index++) {
  pcm.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / 16000) * 8000), index * 2);
}
const wav = Buffer.alloc(44);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + pcm.length, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(pcm.length, 40);
writeFileSync(target, Buffer.concat([wav, pcm]));
