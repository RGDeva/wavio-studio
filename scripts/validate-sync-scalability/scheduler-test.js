// MOCKED-NETWORK scheduler test against the REAL compiled SyncAgent.
//
// global.fetch resolves instantly, so every number here measures scheduler
// overhead only (slot refill, prioritization, pause). These are NOT real
// upload performance figures — see real-network-test.js for those.
//
// Phases:
//   1. drain     — bulk queue drains; items/sec regression-guards the old
//                  poll-gated refill cap (~0.4/sec at concurrency 2 / 5s poll)
//   2. priority  — "Sync This Project" on a project enqueued LAST behind a
//                  bulk backlog; measures selected-project completion latency
//                  and asserts its items complete before the backlog finishes
//   3. pause     — pauseUser() mid-drain halts new starts; resumeUser()
//                  completes the drain
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRATCH = process.env.WAVI_VALIDATE_DIR || path.join(os.tmpdir(), 'wavi-validate');
const DB_PATH = process.env.WAVI_BENCH_DB || path.join(SCRATCH, 'userdata', 'scheduler.db');
const BULK = parseInt(process.env.WAVI_BENCH_QUEUE_SIZE || '500', 10);
const SELECTED = 10;

function iso() { return new Date().toISOString(); }

async function main() {
  await app.whenReady();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + s); } catch {} }

  const dbMod = require(path.join(REPO_ROOT, 'dist-electron/db.js'));
  const db = dbMod.initDatabaseForTesting(DB_PATH);
  const crypto = require('crypto');

  // Disposable on-disk files so fs.existsSync/statSync succeed in syncFile().
  const copyDir = path.join(SCRATCH, 'scheduler-files');
  fs.mkdirSync(copyDir, { recursive: true });
  function seedFile(projectId, name, priority) {
    const fid = crypto.randomUUID();
    const filePath = path.join(copyDir, `${projectId}-${name}`);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, `x-${projectId}-${name}`);
    dbMod.upsertStandaloneFile({
      id: fid, file_path: filePath, file_name: name, file_type: 'wav',
      file_size: 16, checksum: `c-${fid}`, created_at: iso(), modified_at: iso(),
    });
    dbMod.enqueueSyncItem({
      id: crypto.randomUUID(), project_id: projectId, file_id: fid,
      file_name: name, type: 'dependency_upload', priority, created_at: iso(),
    });
    return fid;
  }

  // Instant-success network mock.
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/storage/presign')) return { ok: true, json: async () => ({ deduplicated: true, storageKey: 'k', uploadUrl: 'http://mock' }) };
    if (u.includes('/storage/confirm')) return { ok: true, json: async () => ({}) };
    if (u.includes('desktop/index')) return { ok: true, json: async () => ({ assetId: 'a', fileUrl: 'u' }) };
    return { ok: true, json: async () => ({}) };
  };

  const { SyncAgent } = require(path.join(REPO_ROOT, 'dist-electron/syncAgent.js'));
  const results = {};
  const activeQueueCount = () => db.prepare(
    "SELECT COUNT(*) c FROM sync_queue WHERE status IN ('pending','uploading','retrying')"
  ).get().c;

  // ── Phase 1+2 combined: bulk backlog first, selected project enqueued last ──
  for (let i = 0; i < BULK; i++) seedFile('bulk', `b${i}.wav`, 3);
  const selectedIds = new Set();
  for (let i = 0; i < SELECTED; i++) selectedIds.add(seedFile('selected-proj', `s${i}.wav`, 3));

  let selectedCompleted = 0;
  let selectedDoneAtMs = null;
  const agent = new SyncAgent(db, (p) => {
    if (p.status === 'completed' && p.projectId === 'selected-proj') {
      selectedCompleted++;
      if (selectedCompleted === SELECTED) selectedDoneAtMs = Date.now() - startMs;
    }
  });
  agent.setAuthToken('mock-token-not-real');

  const startMs = Date.now();
  agent.start();
  const prioritizeSummary = agent.prioritizeProject('selected-proj'); // Sync This Project

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (activeQueueCount() === 0 || Date.now() - startMs > 60_000) { clearInterval(check); resolve(); }
    }, 50);
  });
  const drainMs = Date.now() - startMs;
  const completed = db.prepare("SELECT COUNT(*) c FROM sync_queue WHERE status='completed'").get().c;

  results.drain = {
    queueSize: BULK + SELECTED,
    elapsedMs: drainMs,
    completed,
    mockedItemsPerSecond: +(completed / (drainMs / 1000)).toFixed(1),
    note: 'MOCKED NETWORK — scheduler overhead only, not real upload performance',
  };
  results.priority = {
    ...prioritizeSummary,
    selectedProjectItems: SELECTED,
    selectedProjectDoneMs: selectedDoneAtMs,
    totalDrainMs: drainMs,
    selectedFinishedBeforeBacklog: selectedDoneAtMs !== null && selectedDoneAtMs < drainMs,
  };
  agent.stop();

  // ── Phase 3: pause/resume mid-drain ─────────────────────────────────────
  for (let i = 0; i < 60; i++) seedFile('pausable', `p${i}.wav`, 3);
  const agent2 = new SyncAgent(db, () => {});
  agent2.setAuthToken('mock-token-not-real');
  agent2.start();
  await new Promise((r) => setTimeout(r, 60)); // let some drain
  agent2.pauseUser();
  await new Promise((r) => setTimeout(r, 150)); // give in-flight items time to settle
  const remainingAtPause = activeQueueCount();
  await new Promise((r) => setTimeout(r, 400)); // paused window
  const remainingAfterPauseWindow = activeQueueCount();
  agent2.resumeUser();
  const resumeStart = Date.now();
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (activeQueueCount() === 0 || Date.now() - resumeStart > 30_000) { clearInterval(check); resolve(); }
    }, 50);
  });
  agent2.stop();

  results.pauseResume = {
    remainingAtPause,
    remainingAfterPauseWindow,
    haltedWhilePaused: remainingAtPause === remainingAfterPauseWindow && remainingAtPause > 0,
    drainedAfterResume: activeQueueCount() === 0,
    resumeDrainMs: Date.now() - resumeStart,
  };

  const ok =
    results.drain.completed === BULK + SELECTED &&
    results.priority.selectedFinishedBeforeBacklog &&
    results.pauseResume.haltedWhilePaused &&
    results.pauseResume.drainedAfterResume;

  console.log('SCHEDULER_RESULT_JSON:' + JSON.stringify(results));
  app.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error('SCHEDULER_ERROR:', err); app.exit(1); });
