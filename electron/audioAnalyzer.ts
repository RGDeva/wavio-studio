/**
 * Audio analyzer — extracts key and duration from WAV/AIFF files.
 * Pure TypeScript, no native deps. Works alongside bpmDetector.ts.
 *
 * Key detection: chromagram via DFT on downsampled mono PCM,
 * then Krumhansl-Schmuckler key-finding algorithm.
 * Duration: computed from sample count / sample rate in the file header.
 */
import fs from 'fs';

// ─── WAV header parser ────────────────────────────────────────────────────────

interface AudioInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
}

function parseWavHeader(buf: Buffer): AudioInfo | null {
  try {
    if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let offset = 12;
    let channels = 0, sampleRate = 0, bitsPerSample = 0;
    let dataOffset = 0, dataLength = 0;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === 'fmt ') {
        channels = buf.readUInt16LE(offset + 10);
        sampleRate = buf.readUInt32LE(offset + 12);
        bitsPerSample = buf.readUInt16LE(offset + 22);
      } else if (id === 'data') {
        dataOffset = offset + 8;
        dataLength = size;
        break;
      }
      offset += 8 + size;
    }
    if (!sampleRate || !dataOffset) return null;
    return { sampleRate, channels, bitsPerSample, dataOffset, dataLength };
  } catch { return null; }
}

// ─── AIFF header parser ───────────────────────────────────────────────────────

function parseAiffHeader(buf: Buffer): AudioInfo | null {
  try {
    if (buf.toString('ascii', 0, 4) !== 'FORM') return null;
    const form = buf.toString('ascii', 8, 12);
    if (form !== 'AIFF' && form !== 'AIFC') return null;
    let offset = 12;
    let channels = 0, sampleRate = 0, bitsPerSample = 0;
    let dataOffset = 0, dataLength = 0;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32BE(offset + 4);
      if (id === 'COMM') {
        channels = buf.readUInt16BE(offset + 8);
        bitsPerSample = buf.readUInt16BE(offset + 14);
        // 80-bit extended float for sampleRate
        const exp = buf.readUInt16BE(offset + 16) & 0x7fff;
        const mant = buf.readUInt32BE(offset + 18);
        sampleRate = Math.round(mant * Math.pow(2, exp - 16414));
      } else if (id === 'SSND') {
        dataOffset = offset + 16; // skip 8-byte header in SSND
        dataLength = size - 8;
        break;
      }
      offset += 8 + size + (size % 2); // AIFF chunks are word-aligned
    }
    if (!sampleRate || !dataOffset) return null;
    return { sampleRate, channels, bitsPerSample, dataOffset, dataLength };
  } catch { return null; }
}

function parseHeader(buf: Buffer): AudioInfo | null {
  return parseWavHeader(buf) ?? parseAiffHeader(buf);
}

// ─── Duration ────────────────────────────────────────────────────────────────

function computeDuration(info: AudioInfo): number {
  const bytesPerSample = Math.ceil(info.bitsPerSample / 8) || 2;
  const totalSamples = info.dataLength / (bytesPerSample * info.channels);
  return totalSamples / info.sampleRate;
}

// ─── Key detection ────────────────────────────────────────────────────────────

// Krumhansl-Schmuckler profiles
const MAJOR_PROFILE = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MINOR_PROFILE = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
const NOTE_NAMES    = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function chromagram(samples: Float32Array, sampleRate: number): Float32Array {
  const chroma = new Float32Array(12);
  const hopSize = Math.floor(sampleRate * 0.02); // 20ms hop
  const windowSize = hopSize * 4;
  const totalWindows = Math.floor(samples.length / hopSize);

  for (let w = 0; w < totalWindows; w++) {
    const start = w * hopSize;
    for (let bin = 0; bin < 512; bin++) {
      // Goertzel for each semitone frequency
      let s_prev = 0, s_prev2 = 0;
      const freq = 261.63 * Math.pow(2, bin / 512); // C4 root
      const coeff = 2 * Math.cos(2 * Math.PI * freq / sampleRate);
      const end = Math.min(start + windowSize, samples.length);
      for (let i = start; i < end; i++) {
        const s = samples[i] + coeff * s_prev - s_prev2;
        s_prev2 = s_prev;
        s_prev = s;
      }
      const power = s_prev * s_prev + s_prev2 * s_prev2 - coeff * s_prev * s_prev2;
      const noteIdx = Math.round(12 * Math.log2(freq / 16.35)) % 12;
      if (noteIdx >= 0 && noteIdx < 12) chroma[noteIdx] += power;
    }
  }

  // Normalize
  let max = 0;
  for (let i = 0; i < 12; i++) if (chroma[i] > max) max = chroma[i];
  if (max > 0) for (let i = 0; i < 12; i++) chroma[i] /= max;
  return chroma;
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db; denA += da * da; denB += db * db;
  }
  return num / (Math.sqrt(denA) * Math.sqrt(denB) + 1e-10);
}

function detectKey(chroma: Float32Array): string {
  let bestKey = 'C major';
  let bestScore = -Infinity;
  for (let root = 0; root < 12; root++) {
    const rotated = Array.from({ length: 12 }, (_, i) => chroma[(i + root) % 12]);
    const majScore = pearsonCorrelation(rotated, MAJOR_PROFILE);
    const minScore = pearsonCorrelation(rotated, MINOR_PROFILE);
    if (majScore > bestScore) { bestScore = majScore; bestKey = `${NOTE_NAMES[root]} major`; }
    if (minScore > bestScore) { bestScore = minScore; bestKey = `${NOTE_NAMES[root]} minor`; }
  }
  return bestKey;
}

// ─── PCM extraction ───────────────────────────────────────────────────────────

function extractMono(buf: Buffer, info: AudioInfo, maxSamples = 44100 * 30): Float32Array {
  const bytesPerSample = Math.ceil(info.bitsPerSample / 8);
  const frameSize = bytesPerSample * info.channels;
  const totalFrames = Math.min(
    Math.floor(info.dataLength / frameSize),
    maxSamples
  );
  const out = new Float32Array(totalFrames);
  const scale = 1 / (Math.pow(2, info.bitsPerSample - 1));

  for (let i = 0; i < totalFrames; i++) {
    const pos = info.dataOffset + i * frameSize;
    if (pos + bytesPerSample > buf.length) break;
    let sample = 0;
    if (info.bitsPerSample === 16) {
      sample = buf.readInt16LE(pos) * scale;
    } else if (info.bitsPerSample === 24) {
      const v = buf.readUIntLE(pos, 3);
      sample = (v >= 0x800000 ? v - 0x1000000 : v) * scale;
    } else if (info.bitsPerSample === 32) {
      sample = buf.readInt32LE(pos) * scale;
    }
    out[i] = sample;
  }
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface AudioAnalysis {
  duration: number;       // seconds
  key: string | null;     // e.g. "A minor"
}

export async function analyzeAudio(filePath: string): Promise<AudioAnalysis | null> {
  try {
    const HEADER_SIZE = 10 * 1024 * 1024; // 10MB — enough for header + 30s of analysis data at 44.1kHz/24bit/stereo
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, HEADER_SIZE);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);

    const info = parseHeader(buf);
    if (!info) return null;

    const duration = computeDuration(info);

    // Key detection only on audio files with enough data (>3s)
    let key: string | null = null;
    if (duration > 3 && readSize >= info.dataOffset + 4096) {
      const mono = extractMono(buf, info, info.sampleRate * 30);
      const chroma = chromagram(mono, info.sampleRate);
      key = detectKey(chroma);
    }

    return { duration, key };
  } catch {
    return null;
  }
}
