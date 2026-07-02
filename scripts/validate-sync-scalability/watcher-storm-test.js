// Watcher-storm test: drives the REAL compiled WatcherManager with real
// filesystem events in a disposable directory and asserts queue integrity.
//
// Events generated: create ×20, modify ×5, rapid save burst (10 writes to one
// file), DAW-style temp-file-then-atomic-rename, rename, move to subfolder,
// delete, plus a Backup/ folder that must be ignored entirely.
//
// Asserts: stable files queued exactly once (no duplicate active groups),
// temp artifacts not indexed, Backup/ excluded, rename/move reconciled
// without re-upload, deletes marked missing, and a full rescan pass requeues
// zero unchanged files.
//
// NOTE on timing: chokidar awaitWriteFinish (3s) + the watcher's own audio
// stabilization (1.5s + rechecks) means every audio event needs ~5s to
// settle. The waits below are deliberately generous; total runtime ~60s.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRATCH = process.env.WAVI_VALIDATE_DIR || path.join(os.tmpdir(), 'wavi-validate');
const STORM_DIR = path.join(SCRATCH, 'watcher-storm');
const DB_PATH = path.join(SCRATCH, 'userdata', 'watcher-storm.db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wav(seed, bytes = 400) {
  // Valid-enough RIFF header + seed-unique payload (watcher only stats/hashes).
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(88200, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < bytes; i++) buf[44 + i] = (seed * 31 + i) % 256;
  return buf;
}

async function main() {
  await app.whenReady();
  fs.rmSync(STORM_DIR, { recursive: true, force: true });
  fs.mkdirSync(STORM_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + s); } catch {} }

  const dbMod = require(path.join(REPO_ROOT, 'dist-electron/db.js'));
  const db = dbMod.initDatabaseForTesting(DB_PATH);
  const { WatcherManager } = require(path.join(REPO_ROOT, 'dist-electron/watcher.js'));

  const events = [];
  const manager = new WatcherManager(db, (e) => events.push(e.type));
  manager.addFolder(STORM_DIR);
  await sleep(2000); // watcher ready + initial scanExisting of the empty dir

  const results = { label: 'watcher-storm' };
  const q = (sql) => db.prepare(sql).get();

  // ── 1. create ×20 ────────────────────────────────────────────────────────
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(STORM_DIR, `create_${i}.wav`), wav(i));
  // Backup/ content must be ignored by the watcher glob exclusions
  fs.mkdirSync(path.join(STORM_DIR, 'Backup'), { recursive: true });
  fs.writeFileSync(path.join(STORM_DIR, 'Backup', 'ignored.wav'), wav(999));
  await sleep(9000);

  results.createdIndexed = q('SELECT COUNT(*) c FROM files').c;
  results.backupIgnored = q("SELECT COUNT(*) c FROM files WHERE file_path LIKE '%/Backup/%'").c === 0;

  // ── 2. modify ×5 ─────────────────────────────────────────────────────────
  for (let i = 0; i < 5; i++) fs.appendFileSync(path.join(STORM_DIR, `create_${i}.wav`), Buffer.from([1, 2, 3, 4]));
  await sleep(9000);

  // ── 3. rapid save burst: 10 writes to one file in quick succession ──────
  const burstPath = path.join(STORM_DIR, 'burst.wav');
  for (let i = 0; i < 10; i++) { fs.writeFileSync(burstPath, wav(100 + i, 400 + i * 10)); await sleep(120); }
  await sleep(9000);
  results.burstRows = db.prepare('SELECT COUNT(*) c FROM files WHERE file_name = ?').get('burst.wav').c;

  // ── 4. DAW-style temp file then atomic rename ────────────────────────────
  const tmpPath = path.join(STORM_DIR, 'render.wav.tmp');   // .tmp — outside the watch glob
  fs.writeFileSync(tmpPath, wav(500));
  await sleep(1500);
  fs.renameSync(tmpPath, path.join(STORM_DIR, 'render.wav')); // atomic promote
  await sleep(9000);
  results.tempArtifactIndexed = db.prepare("SELECT COUNT(*) c FROM files WHERE file_path LIKE '%.tmp'").get().c;
  results.promotedIndexedOnce = db.prepare("SELECT COUNT(*) c FROM files WHERE file_name = 'render.wav'").get().c;

  // ── 5. rename (unlink + add at new path in same dir) ─────────────────────
  const renameSrc = path.join(STORM_DIR, 'create_10.wav');
  const renameDst = path.join(STORM_DIR, 'renamed_10.wav');
  const renamedRowBefore = db.prepare('SELECT id FROM files WHERE file_path = ?').get(renameSrc);
  fs.renameSync(renameSrc, renameDst);
  await sleep(9000);
  const renamedRowAfter = renamedRowBefore
    ? db.prepare('SELECT file_path, reconciled_from, local_status FROM files WHERE id = ?').get(renamedRowBefore.id)
    : null;
  results.renameReconciled = !!(renamedRowAfter && renamedRowAfter.file_path === renameDst && renamedRowAfter.local_status === 'present');

  // ── 6. move into a subfolder ─────────────────────────────────────────────
  const moveDirDst = path.join(STORM_DIR, 'Moved');
  fs.mkdirSync(moveDirDst, { recursive: true });
  const moveSrc = path.join(STORM_DIR, 'create_11.wav');
  const moveDst = path.join(moveDirDst, 'create_11.wav');
  const movedRowBefore = db.prepare('SELECT id FROM files WHERE file_path = ?').get(moveSrc);
  fs.renameSync(moveSrc, moveDst);
  await sleep(9000);
  const movedRowAfter = movedRowBefore
    ? db.prepare('SELECT file_path, local_status FROM files WHERE id = ?').get(movedRowBefore.id)
    : null;
  results.moveReconciled = !!(movedRowAfter && movedRowAfter.file_path === moveDst && movedRowAfter.local_status === 'present');

  // ── 7. delete ────────────────────────────────────────────────────────────
  const delPath = path.join(STORM_DIR, 'create_12.wav');
  fs.unlinkSync(delPath);
  await sleep(11_000); // longer than the rename-reconciliation window
  results.deleteMarkedMissing =
    db.prepare("SELECT local_status FROM files WHERE file_path = ?").get(delPath)?.local_status === 'missing';

  // ── Queue integrity ──────────────────────────────────────────────────────
  results.duplicateActiveGroups = db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT type, project_id, COALESCE(file_id,'') fid, COUNT(*) n
      FROM sync_queue WHERE status IN ('pending','uploading','retrying')
      GROUP BY type, project_id, fid HAVING n > 1
    )
  `).get().c;
  results.activeQueueRows = db.prepare(
    "SELECT COUNT(*) c FROM sync_queue WHERE status IN ('pending','uploading','retrying')"
  ).get().c;

  // ── Unchanged-file requeue check: manual rescan of the same folder ───────
  const beforeRescan = db.prepare('SELECT COUNT(*) c FROM sync_queue').get().c;
  await manager.removeFolder(STORM_DIR);
  manager.addFolder(STORM_DIR); // triggers scanExisting over the now-stable tree
  await sleep(9000);
  const afterRescan = db.prepare('SELECT COUNT(*) c FROM sync_queue').get().c;
  results.queueGrowthAfterRescan = afterRescan - beforeRescan;

  await manager.stopAll();

  const ok =
    results.createdIndexed >= 20 &&
    results.backupIgnored === true &&
    results.burstRows === 1 &&
    results.tempArtifactIndexed === 0 &&
    results.promotedIndexedOnce === 1 &&
    results.renameReconciled === true &&
    results.moveReconciled === true &&
    results.deleteMarkedMissing === true &&
    results.duplicateActiveGroups === 0 &&
    results.queueGrowthAfterRescan === 0;

  results.pass = ok;
  console.log('WATCHER_STORM_RESULT_JSON:' + JSON.stringify(results));
  app.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error('WATCHER_STORM_ERROR:', err); app.exit(1); });
