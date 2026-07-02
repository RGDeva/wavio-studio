// 5,000-file benchmark. Runs under the real Electron binary
// (`npx electron scripts/validate-sync-scalability/benchmark-main.js`) but
// never creates a BrowserWindow — pure headless main-process measurement of
// the ACTUAL compiled dist-electron modules (db.js, discovery.js) against a
// disposable fixture library + disposable SQLite file.
//
// Measures: db-open, discovery walk, serial import (hash+upsert+enqueue),
// queue size after first scan, rescan-of-unchanged duration, unchanged-file
// requeue count, duplicate active-queue groups, memory RSS.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRATCH = process.env.WAVI_VALIDATE_DIR || path.join(os.tmpdir(), 'wavi-validate');
const FIXTURES_DIR = process.env.WAVI_BENCH_FIXTURES || path.join(SCRATCH, 'fixtures');
const DB_PATH = process.env.WAVI_BENCH_DB || path.join(SCRATCH, 'userdata', 'bench.db');
const LABEL = process.env.WAVI_BENCH_LABEL || 'run';

async function main() {
  await app.whenReady();

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch { /* fresh run */ }
  }

  const dbMod = require(path.join(REPO_ROOT, 'dist-electron/db.js'));
  const discoveryMod = require(path.join(REPO_ROOT, 'dist-electron/discovery.js'));
  const crypto = require('crypto');

  const results = { label: LABEL, rssStartMB: +(process.memoryUsage().rss / 1e6).toFixed(1) };

  const t0 = process.hrtime.bigint();
  dbMod.initDatabaseForTesting(DB_PATH);
  const t1 = process.hrtime.bigint();
  results.dbOpenMs = Number(t1 - t0) / 1e6;

  const t2 = process.hrtime.bigint();
  const { paths } = await discoveryMod.discoverAudioFiles({
    roots: [FIXTURES_DIR],
    maxFiles: 50_000,
    maxDurationMs: 120_000,
  });
  const t3 = process.hrtime.bigint();
  results.discoveryWalkMs = Number(t3 - t2) / 1e6;
  results.filesFound = paths.length;

  async function fileChecksum(filePath) {
    return new Promise((resolve) => {
      try {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', () => resolve(crypto.randomUUID()));
      } catch { resolve(crypto.randomUUID()); }
    });
  }

  // Serial import — matches the current files:discoverAll IPC handler behavior.
  async function importAudioFileSerial(filePath) {
    const stats = fs.statSync(filePath);
    const checksum = await fileChecksum(filePath);
    const id = dbMod.upsertStandaloneFile({
      id: crypto.randomUUID(),
      file_path: filePath,
      file_name: path.basename(filePath),
      file_type: path.extname(filePath).slice(1),
      file_size: stats.size,
      checksum,
      role: 'unknown',
      created_at: new Date().toISOString(),
      modified_at: stats.mtime.toISOString(),
    });
    dbMod.enqueueSyncItem({
      id: crypto.randomUUID(),
      project_id: '__standalone__',
      file_id: id,
      file_name: path.basename(filePath),
      type: 'dependency_upload',
      priority: 3,
      created_at: new Date().toISOString(),
    });
    return id;
  }

  const t4 = process.hrtime.bigint();
  for (const p of paths) await importAudioFileSerial(p);
  const t5 = process.hrtime.bigint();
  results.importSerialMs = Number(t5 - t4) / 1e6;
  results.queueCountsAfterFirstScan = dbMod.getSyncQueueCounts();

  // Simulate app restart: rescan the SAME unchanged files — queue must not grow.
  const beforeRescanQueue = dbMod.getDb().prepare('SELECT COUNT(*) c FROM sync_queue').get().c;
  const t6 = process.hrtime.bigint();
  for (const p of paths) await importAudioFileSerial(p);
  const t7 = process.hrtime.bigint();
  results.rescanUnchangedMs = Number(t7 - t6) / 1e6;
  const afterRescanQueue = dbMod.getDb().prepare('SELECT COUNT(*) c FROM sync_queue').get().c;
  results.queueGrowthAfterRescan = afterRescanQueue - beforeRescanQueue;

  results.duplicateActiveGroups = dbMod.getDb().prepare(`
    SELECT COUNT(*) c FROM (
      SELECT type, project_id, COALESCE(file_id,'') fid, COUNT(*) n
      FROM sync_queue
      WHERE status IN ('pending','uploading','retrying')
      GROUP BY type, project_id, fid
      HAVING n > 1
    )
  `).get().c;
  results.totalActiveQueueRows = dbMod.getDb().prepare(
    "SELECT COUNT(*) c FROM sync_queue WHERE status IN ('pending','uploading','retrying')"
  ).get().c;
  results.totalFileRows = dbMod.getDb().prepare('SELECT COUNT(*) c FROM files').get().c;
  results.rssEndMB = +(process.memoryUsage().rss / 1e6).toFixed(1);

  console.log('BENCH_RESULT_JSON:' + JSON.stringify(results));
  app.exit(results.queueGrowthAfterRescan === 0 && results.duplicateActiveGroups === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('BENCH_ERROR:', err);
  app.exit(1);
});
