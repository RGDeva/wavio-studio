#!/usr/bin/env node
// Generates N disposable, valid-but-tiny WAV files (real RIFF headers, seed-
// derived unique content) to simulate a realistic large producer library for
// sync-engine load testing. Never touches the user's real music files.
import fs from 'fs';
import path from 'path';
import os from 'os';

const COUNT = parseInt(process.argv[2] || '5000', 10);
const SCRATCH = process.env.WAVI_VALIDATE_DIR || path.join(os.tmpdir(), 'wavi-validate');
const OUT_DIR = process.argv[3] || path.join(SCRATCH, 'fixtures');

function makeWavBuffer(seed) {
  // Minimal valid 44-byte WAV header + a few samples; content varies by seed
  // so each file has a distinct SHA-256 (avoids server-side dedup skewing results).
  const sampleCount = 100 + (seed % 50);
  const dataSize = sampleCount * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(44100, 24);
  buf.writeUInt32LE(88200, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < sampleCount; i++) {
    buf.writeInt16LE(((seed * 2654435761 + i) % 32767) - 16000, 44 + i * 2);
  }
  return buf;
}

const projectDirs = Math.ceil(COUNT / 8); // ~8 files per "project" folder, realistic grouping
fs.mkdirSync(OUT_DIR, { recursive: true });

let written = 0;
for (let p = 0; p < projectDirs && written < COUNT; p++) {
  const projDir = path.join(OUT_DIR, `Track_${String(p).padStart(5, '0')}`);
  fs.mkdirSync(projDir, { recursive: true });
  const filesInProj = Math.min(8, COUNT - written);
  for (let f = 0; f < filesInProj; f++) {
    const seed = p * 8 + f;
    fs.writeFileSync(path.join(projDir, `sample_${String(f).padStart(2, '0')}.wav`), makeWavBuffer(seed));
    written++;
  }
}

console.log(`Generated ${written} fixture WAV files across ${projectDirs} folders in ${OUT_DIR}`);
