// LIMITED REAL-NETWORK test — real fetch, real API endpoints, real SyncAgent.
//
// Uploads a SMALL set (default 10) of tiny disposable fixture files to
// measure ACTUAL upload behavior: concurrency, slot-refill gap, retries,
// server throttling, realistic items/sec. Never run this with thousands of
// files — the point is realistic per-item latency, not volume.
//
// Requires WAVI_AUTH_TOKEN (wv_ desktop token). Optional:
//   WAVI_API_BASE_URL   — target a preview/staging deployment instead of prod
//   WAVI_NET_COUNT      — number of files (hard-capped at 25)
//
// Without a token the script exits 0 with SKIPPED so CI can include it
// unconditionally. Uploaded files are tiny valid WAVs named
// wavi-validation-*.wav so they're easy to identify and delete server-side.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRATCH = process.env.WAVI_VALIDATE_DIR || path.join(os.tmpdir(), 'wavi-validate');
const DB_PATH = path.join(SCRATCH, 'userdata', 'real-network.db');
const COUNT = Math.min(parseInt(process.env.WAVI_NET_COUNT || '10', 10), 25);
const TOKEN = process.env.WAVI_AUTH_TOKEN || null;

function wav(seed) {
  const bytes = 2000 + seed * 7; // ~2KB, unique content per file
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(88200, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < bytes; i++) buf[44 + i] = (seed * 131 + i * 7) % 256;
  return buf;
}

async function main() {
  await app.whenReady();

  if (!TOKEN) {
    console.log('REAL_NETWORK_RESULT_JSON:' + JSON.stringify({
      skipped: true,
      reason: 'WAVI_AUTH_TOKEN not set. Provide a wv_ desktop token (Settings → account, or a QA session) to run the limited real-network test.',
    }));
    app.exit(0);
    return;
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + s); } catch {} }

  const dbMod = require(path.join(REPO_ROOT, 'dist-electron/db.js'));
  const db = dbMod.initDatabaseForTesting(DB_PATH);
  const { SyncAgent } = require(path.join(REPO_ROOT, 'dist-electron/syncAgent.js'));
  const config = require(path.join(REPO_ROOT, 'dist-electron/config.js'));
  const crypto = require('crypto');

  const fileDir = path.join(SCRATCH, 'real-network-files');
  fs.mkdirSync(fileDir, { recursive: true });
  for (let i = 0; i < COUNT; i++) {
    const filePath = path.join(fileDir, `wavi-validation-${Date.now()}-${i}.wav`);
    fs.writeFileSync(filePath, wav(i));
    const fid = crypto.randomUUID();
    const stats = fs.statSync(filePath);
    dbMod.upsertStandaloneFile({
      id: fid, file_path: filePath, file_name: path.basename(filePath),
      file_type: 'wav', file_size: stats.size, checksum: null,
      created_at: new Date().toISOString(), modified_at: stats.mtime.toISOString(),
    });
    dbMod.enqueueSyncItem({
      id: crypto.randomUUID(), project_id: '__standalone__', file_id: fid,
      file_name: path.basename(filePath), type: 'dependency_upload', priority: 3,
      created_at: new Date().toISOString(),
    });
  }

  // Instrument real fetch to sample in-flight concurrency and refill gaps.
  const realFetch = global.fetch;
  let inFlight = 0, maxInFlight = 0;
  let lastCompletionAt = null;
  const refillGapsMs = [];
  global.fetch = async (...args) => {
    if (lastCompletionAt !== null && inFlight === 0) {
      refillGapsMs.push(Date.now() - lastCompletionAt); // idle gap before a slot refilled
      lastCompletionAt = null;
    }
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await realFetch(...args);
    } finally {
      inFlight--;
      if (inFlight === 0) lastCompletionAt = Date.now();
    }
  };

  let completed = 0, retriesSeen = 0, failures = 0, throttled = 0;
  const agent = new SyncAgent(db, (p) => {
    if (p.status === 'completed') completed++;
    if (p.status === 'retrying') retriesSeen++;
    if (p.status === 'failed') failures++;
    if ((p.error || '').includes('429')) throttled++;
  });
  agent.setAuthToken(TOKEN);

  const startMs = Date.now();
  agent.start();

  await new Promise((resolve) => {
    const check = setInterval(() => {
      const remaining = db.prepare(
        "SELECT COUNT(*) c FROM sync_queue WHERE status IN ('pending','uploading','retrying')"
      ).get().c;
      if (remaining === 0 || Date.now() - startMs > 180_000) { clearInterval(check); resolve(); }
    }, 250);
  });
  const elapsedMs = Date.now() - startMs;
  agent.stop();

  const maxRefillGap = refillGapsMs.length ? Math.max(...refillGapsMs) : 0;
  console.log('REAL_NETWORK_RESULT_JSON:' + JSON.stringify({
    apiBase: config.API_BASE,
    fileCount: COUNT,
    elapsedMs,
    completed,
    failures,
    retriesSeen,
    throttled429: throttled,
    maxObservedConcurrency: maxInFlight,
    maxIdleRefillGapMs: maxRefillGap,   // must be far below the old 5000ms poll gap
    realItemsPerSecond: +(completed / (elapsedMs / 1000)).toFixed(2),
    note: 'REAL network throughput — compare against scheduler-test.js mocked numbers only for refill-gap behavior, never as the same metric',
  }));
  app.exit(completed === COUNT ? 0 : 1);
}

main().catch((e) => { console.error('REAL_NETWORK_ERROR:', e); app.exit(1); });
