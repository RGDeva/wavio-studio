#!/usr/bin/env node
/**
 * Generate the macOS app icon from the Wavi waveform mark.
 *
 * Why generate rather than crop: `public/icon.png` is the full Wavi WORDMARK —
 * a wide logo sitting in the middle of a 1024×1024 transparent square with
 * roughly 70% of the canvas empty. Squeezed into the Dock it renders as a
 * sliver of unreadable text. An app icon is not a logo: it needs a shape that
 * fills its tile and a mark that survives at 32px.
 *
 * So this draws the waveform glyph alone — the part of the logo that is
 * actually distinctive — on the brand gradient, in a rounded tile the way
 * every other macOS icon is built.
 *
 * Pure Node: zlib is the only dependency, so there is no ImageMagick, no
 * canvas, no network, and the result is byte-identical on every run. That
 * matters because an icon that regenerates differently each build would churn
 * the repository.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SIZE = 1024;

// ── Brand colours, sampled from the Wavi logo ──────────────────────────────
const CYAN = [0x7d, 0xe8, 0xf0];
const VIOLET = [0xb9, 0x8c, 0xf5];
const DEEP = [0x14, 0x12, 0x2b];

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Squircle coverage, antialiased.
 *
 * macOS tiles are a superellipse rather than a rounded rectangle; n=5 is the
 * usual approximation. Coverage is sampled rather than thresholded so the edge
 * does not stair-step at small sizes, which is exactly where a hand-rolled
 * icon normally gives itself away.
 */
function squircleAlpha(x, y, cx, cy, r) {
  const n = 5;
  const dx = Math.abs(x - cx) / r;
  const dy = Math.abs(y - cy) / r;
  const d = Math.pow(Math.pow(dx, n) + Math.pow(dy, n), 1 / n);
  return clamp01((1.0 - d) * r * 0.5 + 0.5);
}

/**
 * The Wavi mark: a travelling wave whose amplitude swells through the middle
 * and settles at both ends — the shape in the logo's "W".
 */
function wavePoints(x0, x1, yMid, amp) {
  const pts = [];
  const STEPS = 2400;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const x = lerp(x0, x1, t);
    // Envelope: quiet at the edges, loudest just left of centre.
    const env = Math.pow(Math.sin(Math.PI * t), 1.35) * (0.72 + 0.46 * Math.exp(-Math.pow((t - 0.42) / 0.26, 2)));
    const phase = t * Math.PI * 2 * 2.15;
    pts.push([x, yMid - Math.sin(phase) * amp * env]);
  }
  return pts;
}

/**
 * Bucket polyline vertices by x column.
 *
 * The naive version measured every pixel against all 2400 samples — a million
 * pixels times 2400 segments, which took 20 seconds and made the icon test the
 * slowest thing in the suite. The wave is a function of x, so only the samples
 * near a pixel's own column can be nearest to it.
 */
function buildIndex(pts, size, reach) {
  const buckets = Array.from({ length: size }, () => []);
  for (let i = 1; i < pts.length; i++) {
    const lo = Math.max(0, Math.floor(Math.min(pts[i - 1][0], pts[i][0]) - reach));
    const hi = Math.min(size - 1, Math.ceil(Math.max(pts[i - 1][0], pts[i][0]) + reach));
    for (let c = lo; c <= hi; c++) buckets[c].push(i);
  }
  return buckets;
}

/** Shortest distance from a point to the segments in its column bucket. */
function distToSegments(px, py, pts, idx) {
  let best = Infinity;
  for (const i of idx) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const vx = bx - ax, vy = by - ay;
    const wx = px - ax, wy = py - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < best) best = d;
  }
  return best;
}

/** Vertical extent of the mark, so most pixels skip the distance test entirely. */
function waveBand(pts, reach) {
  let lo = Infinity, hi = -Infinity;
  for (const [, y] of pts) { if (y < lo) lo = y; if (y > hi) hi = y; }
  return [lo - reach, hi + reach];
}

export function renderIcon(size = SIZE) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 1024;

  // Tile inset ~8%: macOS expects breathing room inside the canvas, and the
  // Dock adds none of its own.
  const inset = 80 * s;
  const cx = size / 2, cy = size / 2;
  const r = (size - inset * 2) / 2;

  const pts = wavePoints(inset + 118 * s, size - inset - 118 * s, cy, 172 * s);
  const stroke = 56 * s;
  const reach = stroke / 2 + 2 * s;
  const index = buildIndex(pts, size, reach);
  const [bandTop, bandBottom] = waveBand(pts, reach);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const tileA = squircleAlpha(x + 0.5, y + 0.5, cx, cy, r);
      if (tileA <= 0) continue;

      // Diagonal gradient, deepened toward the lower-right so the mark keeps
      // contrast against the brighter top-left.
      const g = clamp01(((x / size) * 0.62 + (y / size) * 0.38));
      let col = mix(mix(CYAN, VIOLET, clamp01(g * 1.45)), DEEP, clamp01((g - 0.42) * 1.5));

      // The mark, antialiased over one pixel of the stroke edge. Skipped
      // outright for the ~70% of pixels that are nowhere near it.
      const markA = (y >= bandTop && y <= bandBottom)
        ? clamp01((stroke / 2 - distToSegments(x + 0.5, y + 0.5, pts, index[x])) / (1.6 * s) + 0.5)
        : 0;
      if (markA > 0) {
        // Near-white, very slightly warm, so it reads as light rather than
        // as a hole punched in the gradient.
        col = mix(col, [255, 253, 255], markA);
      }

      px[i] = Math.round(col[0]);
      px[i + 1] = Math.round(col[1]);
      px[i + 2] = Math.round(col[2]);
      px[i + 3] = Math.round(tileA * 255);
    }
  }
  return px;
}

// ── Minimal PNG encoder ────────────────────────────────────────────────────
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

export function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 6;     // RGBA
  // Each scanline is prefixed with filter byte 0 (None): simple, and the
  // image is dominated by smooth gradients that deflate well regardless.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? 'public/icon.png';
  const png = encodePng(renderIcon(SIZE), SIZE);
  writeFileSync(out, png);
  console.log(`${out}  ${SIZE}×${SIZE}  ${(png.length / 1024).toFixed(0)} KB  sha256=${createHash('sha256').update(png).digest('hex').slice(0, 16)}`);
}
