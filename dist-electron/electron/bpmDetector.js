"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectBpm = detectBpm;
/**
 * Lightweight BPM detector for WAV/AIFF files.
 * Reads raw PCM samples from the file header, downsamples to ~4kHz,
 * computes an onset envelope, then finds the dominant inter-onset interval
 * via autocorrelation. Works without any native binaries.
 */
const fs_1 = __importDefault(require("fs"));
function parseWavHeader(buf) {
    try {
        if (buf.toString('ascii', 0, 4) !== 'RIFF')
            return null;
        if (buf.toString('ascii', 8, 12) !== 'WAVE')
            return null;
        let offset = 12;
        let audioFormat = 0;
        let channels = 0;
        let sampleRate = 0;
        let bitsPerSample = 0;
        let dataOffset = 0;
        let dataLength = 0;
        while (offset + 8 <= buf.length) {
            const id = buf.toString('ascii', offset, offset + 4);
            const size = buf.readUInt32LE(offset + 4);
            offset += 8;
            if (id === 'fmt ') {
                audioFormat = buf.readUInt16LE(offset);
                channels = buf.readUInt16LE(offset + 2);
                sampleRate = buf.readUInt32LE(offset + 4);
                bitsPerSample = buf.readUInt16LE(offset + 14);
            }
            else if (id === 'data') {
                dataOffset = offset;
                dataLength = size;
                break;
            }
            offset += size + (size % 2); // word-align
        }
        if (audioFormat !== 1 || !sampleRate || !channels || !dataOffset)
            return null;
        return { sampleRate, channels, bitsPerSample, dataOffset, dataLength };
    }
    catch {
        return null;
    }
}
// ─── AIFF parser (PCM / AIFF, not AIFF-C) ───────────────────────────────────
function parseAiffHeader(buf) {
    try {
        if (buf.toString('ascii', 0, 4) !== 'FORM')
            return null;
        const formType = buf.toString('ascii', 8, 12);
        if (formType !== 'AIFF')
            return null; // skip AIFF-C
        let offset = 12;
        let sampleRate = 0;
        let channels = 0;
        let bitsPerSample = 0;
        let dataOffset = 0;
        let dataLength = 0;
        while (offset + 8 <= buf.length) {
            const id = buf.toString('ascii', offset, offset + 4);
            const size = buf.readInt32BE(offset + 4);
            offset += 8;
            if (id === 'COMM') {
                channels = buf.readInt16BE(offset);
                bitsPerSample = buf.readInt16BE(offset + 6);
                // 80-bit extended float for sample rate
                const exp = buf.readInt16BE(offset + 8) & 0x7fff;
                const mantHi = buf.readUInt32BE(offset + 10);
                sampleRate = Math.round(mantHi * Math.pow(2, exp - 16414));
            }
            else if (id === 'SSND') {
                dataOffset = offset + 8; // skip offset+blockSize fields
                dataLength = size - 8;
                break;
            }
            offset += size + (size % 2);
        }
        if (!sampleRate || !channels || !dataOffset)
            return null;
        return { sampleRate, channels, bitsPerSample: bitsPerSample || 16, dataOffset, dataLength };
    }
    catch {
        return null;
    }
}
// ─── PCM sample extraction ───────────────────────────────────────────────────
/** Read up to `maxSamples` mono float32 samples from raw PCM buffer. */
function extractSamples(buf, info, maxSamples = 44100 * 30) {
    const { bitsPerSample, channels, dataOffset, dataLength } = info;
    const bytesPerSample = bitsPerSample / 8;
    const bytesPerFrame = bytesPerSample * channels;
    const totalFrames = Math.min(Math.floor(dataLength / bytesPerFrame), maxSamples);
    const out = new Float32Array(totalFrames);
    const end = dataOffset + totalFrames * bytesPerFrame;
    let i = 0;
    for (let pos = dataOffset; pos < end && pos + bytesPerFrame <= buf.length; pos += bytesPerFrame) {
        let sample = 0;
        if (bitsPerSample === 16) {
            sample = buf.readInt16LE(pos) / 32768;
        }
        else if (bitsPerSample === 24) {
            const lo = buf.readUInt16LE(pos);
            const hi = buf.readInt8(pos + 2);
            sample = ((hi << 16) | lo) / 8388608;
        }
        else if (bitsPerSample === 32) {
            sample = buf.readInt32LE(pos) / 2147483648;
        }
        else if (bitsPerSample === 8) {
            sample = (buf.readUInt8(pos) - 128) / 128;
        }
        out[i++] = sample;
    }
    return out.subarray(0, i);
}
// ─── BPM estimation ──────────────────────────────────────────────────────────
const TARGET_RATE = 4000; // downsample to 4kHz for speed
const WINDOW_MS = 10; // onset envelope window
function estimateBpm(samples, originalRate) {
    // 1. Downsample
    const step = Math.max(1, Math.round(originalRate / TARGET_RATE));
    const ds = [];
    for (let i = 0; i < samples.length; i += step) {
        ds.push(Math.abs(samples[i]));
    }
    const dsRate = originalRate / step;
    // 2. Onset envelope: HWR of first-order difference
    const winSize = Math.max(1, Math.round(dsRate * WINDOW_MS / 1000));
    const env = new Array(ds.length).fill(0);
    for (let i = 1; i < ds.length; i++) {
        const diff = ds[i] - ds[i - 1];
        env[i] = diff > 0 ? diff : 0;
    }
    // 3. Mean-normalize envelope
    let mean = 0;
    for (const v of env)
        mean += v;
    mean /= env.length || 1;
    for (let i = 0; i < env.length; i++)
        env[i] -= mean;
    // 4. Autocorrelation over BPM range 60–200
    const minLag = Math.round(dsRate * 60 / 200); // 200 BPM
    const maxLag = Math.round(dsRate * 60 / 60); // 60 BPM
    const useLen = Math.min(env.length, Math.round(dsRate * 15)); // use 15s max
    let bestLag = -1;
    let bestCorr = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
        let corr = 0;
        for (let i = 0; i < useLen - lag; i++) {
            corr += env[i] * env[i + lag];
        }
        if (corr > bestCorr) {
            bestCorr = corr;
            bestLag = lag;
        }
    }
    if (bestLag < 1)
        return null;
    const bpm = Math.round(dsRate * 60 / bestLag);
    // Fold into 60–180 range
    let b = bpm;
    while (b > 180)
        b = Math.round(b / 2);
    while (b < 60)
        b = Math.round(b * 2);
    return b;
}
// ─── Public API ──────────────────────────────────────────────────────────────
/**
 * Detect BPM from a WAV or AIFF file.
 * Reads only the first ~30 seconds of audio to keep it fast.
 * Returns null if the file can't be parsed or BPM can't be determined.
 */
async function detectBpm(filePath) {
    return new Promise((resolve) => {
        try {
            // Read first 10MB max (enough for header + 30s @44.1kHz/16bit/stereo)
            const fd = fs_1.default.openSync(filePath, 'r');
            const size = Math.min(fs_1.default.fstatSync(fd).size, 10 * 1024 * 1024);
            const buf = Buffer.allocUnsafe(size);
            fs_1.default.readSync(fd, buf, 0, size, 0);
            fs_1.default.closeSync(fd);
            const ext = filePath.toLowerCase();
            const info = ext.endsWith('.aif') || ext.endsWith('.aiff')
                ? parseAiffHeader(buf)
                : parseWavHeader(buf);
            if (!info)
                return resolve(null);
            const samples = extractSamples(buf, info);
            if (samples.length < info.sampleRate * 2)
                return resolve(null); // need ≥2s
            const bpm = estimateBpm(samples, info.sampleRate);
            resolve(bpm);
        }
        catch {
            resolve(null);
        }
    });
}
