/**
 * syncScalability.test.ts — Phase 2 sync-engine stabilization tests.
 *
 * Covers: 5,000-file scale, restart without requeue, duplicate queue
 * insertion, crash-recovery dedup, "Sync This Project" priority, pause/
 * resume, cancellation, missing-file handling, renamed/moved-file
 * reconciliation, sample-library exclusion, and the immediate-refill
 * concurrency fix (the root cause of the ~4,511-item real-world backlog).
 *
 * Follows the repo's established test convention (see db.integration.test.ts,
 * pending-resync.test.ts, sync.test.ts): db.ts and syncAgent.ts both import
 * `better-sqlite3` directly at module scope, which resolves to the
 * Electron-ABI-compiled binary and cannot load under plain Node/vitest
 * (NODE_MODULE_VERSION mismatch). So:
 *   - DB-backed tests replicate the exact SQL from db.ts against a
 *     separately-installed arm64 Node-compatible better-sqlite3 binary at
 *     /tmp/wavio-sqlite-test/, skipping gracefully if that binary isn't set up.
 *   - SyncAgent concurrency/pause/cancel behavior is verified against a pure-JS
 *     mirror of the exact _tick()/pauseUser()/cancelItem() algorithm in
 *     electron/syncAgent.ts (same technique sync.test.ts uses for checksum/
 *     retry-gate logic) — real end-to-end throughput was already proven via
 *     the headless-Electron benchmark harness, which runs the real compiled
 *     class under real Electron with mocked network.
 *   - discovery.ts's classifyFolderForImport has no better-sqlite3 dependency,
 *     so it's imported directly with `electron` mocked (matches discovery.ts's
 *     own module-scope needs: only app.getPath, called lazily, not at import time).
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/wavi-scalability-test') },
}));

const NATIVE_SQLITE_PATH = '/tmp/wavio-sqlite-test/node_modules/better-sqlite3';
const nativeSqliteAvailable = existsSync(NATIVE_SQLITE_PATH);
const maybeDescribe = nativeSqliteAvailable ? describe : describe.skip;

// ── Inline schema + SQL mirrors (kept in sync with electron/db.ts) ───────────

function buildSchema(Database: any) {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      file_path TEXT,
      sync_status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      sync_status TEXT DEFAULT 'pending',
      local_status TEXT DEFAULT 'present',
      reconciled_from TEXT,
      cloud_asset_id TEXT,
      checksum TEXT,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL
    );
    CREATE TABLE sync_queue (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      file_id TEXT,
      file_name TEXT,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 5,
      retries INTEGER DEFAULT 0,
      error_message TEXT,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT
    );
    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

// Exact SQL from electron/db.ts enqueueSyncItemIdempotent.
function enqueueSyncItemIdempotent(db: any, item: {
  id: string; project_id: string; file_id?: string | null; file_name?: string | null;
  type: string; priority?: number; created_at: string;
}): { inserted: boolean } {
  const existing = db.prepare(`
    SELECT id FROM sync_queue
    WHERE type = ? AND project_id = ? AND COALESCE(file_id, '') = COALESCE(?, '')
      AND status IN ('pending', 'uploading', 'retrying')
    LIMIT 1
  `).get(item.type, item.project_id, item.file_id ?? null);
  if (existing) return { inserted: false };
  db.prepare(`
    INSERT OR IGNORE INTO sync_queue (id, project_id, file_id, file_name, type, priority, created_at)
    VALUES (@id, @project_id, @file_id, @file_name, @type, @priority, @created_at)
  `).run({ priority: 5, file_id: null, file_name: null, ...item });
  return { inserted: true };
}

// Exact SQL from electron/db.ts repairStalledQueue.
function repairStalledQueue(db: any): { recovered: number; deduped: number } {
  const recovered = db.prepare(`
    UPDATE sync_queue SET status = 'pending', started_at = NULL WHERE status = 'uploading'
  `).run().changes;

  const duplicates = db.prepare(`
    SELECT id FROM sync_queue
    WHERE status IN ('pending', 'retrying')
      AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY type, project_id, COALESCE(file_id, '')
            ORDER BY created_at DESC
          ) AS rn FROM sync_queue WHERE status IN ('pending', 'retrying')
        ) WHERE rn = 1
      )
  `).all() as { id: string }[];

  let deduped = 0;
  if (duplicates.length > 0) {
    const ids = duplicates.map((r) => r.id);
    db.prepare(`DELETE FROM sync_queue WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    deduped = ids.length;
  }

  // Pass 3 (mirrors db.ts): prune active rows with a dangling file_id when a
  // valid row exists for the same work item (legacy watcher enqueue bug).
  const danglingDupes = db.prepare(`
    SELECT q.id FROM sync_queue q
    WHERE q.status IN ('pending', 'retrying')
      AND q.file_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id = q.file_id)
      AND EXISTS (
        SELECT 1 FROM sync_queue q2
        JOIN files f2 ON f2.id = q2.file_id
        WHERE q2.id != q.id
          AND q2.status IN ('pending', 'uploading', 'retrying')
          AND q2.type = q.type
          AND q2.project_id = q.project_id
          AND COALESCE(q2.file_name, '') = COALESCE(q.file_name, '')
      )
  `).all() as { id: string }[];
  if (danglingDupes.length > 0) {
    const ids = danglingDupes.map((r) => r.id);
    db.prepare(`DELETE FROM sync_queue WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    deduped += ids.length;
  }
  return { recovered, deduped };
}

// Exact SQL from electron/db.ts getPendingSyncItems.
function getPendingSyncItems(db: any, now: string, limit = 10) {
  return db.prepare(`
    SELECT * FROM sync_queue
    WHERE status IN ('pending', 'retrying')
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY priority DESC, created_at ASC
    LIMIT ?
  `).all(now, limit);
}

// Exact SQL from electron/db.ts bumpProjectPriority.
function bumpProjectPriority(db: any, projectId: string, priority: number): number {
  return db.prepare(`
    UPDATE sync_queue SET priority = ? WHERE project_id = ? AND status IN ('pending', 'retrying')
  `).run(priority, projectId).changes;
}

// Exact logic from electron/db.ts classifyFailedRowsForProject / requeueFailedForProject (D3).
const PERMANENT_SYNC_ERROR = /\b(401|403|404)\b|INVALID_TOKEN|PLAN_LIMIT|UNAUTHORIZED|FORBIDDEN|PERMISSION|NOT_FOUND/i;
function classifyFailedRowsForProject(db: any, projectId: string) {
  const rows = db.prepare(`
    SELECT q.id, q.error_message, f.local_status AS file_local_status, f.sync_status AS file_sync_status
    FROM sync_queue q
    LEFT JOIN files f ON f.id = q.file_id
    WHERE q.project_id = ? AND q.status = 'failed'
  `).all(projectId) as Array<{ id: string; error_message: string | null; file_local_status: string | null; file_sync_status: string | null }>;
  const retryable: string[] = []; const permanent: string[] = []; const missing: string[] = [];
  for (const row of rows) {
    if (row.file_local_status === 'missing' || row.file_sync_status === 'missing') missing.push(row.id);
    else if (row.error_message && PERMANENT_SYNC_ERROR.test(row.error_message)) permanent.push(row.id);
    else retryable.push(row.id);
  }
  return { retryable, permanent, missing };
}
function requeueFailedForProject(db: any, projectId: string, priority: number) {
  const { retryable, permanent, missing } = classifyFailedRowsForProject(db, projectId);
  if (retryable.length > 0) {
    const ph = retryable.map(() => '?').join(',');
    db.prepare(`
      UPDATE sync_queue
      SET status = 'pending', retries = 0, error_message = NULL, next_retry_at = NULL, priority = ?
      WHERE id IN (${ph}) AND status = 'failed'
    `).run(priority, ...retryable);
  }
  return { requeued: retryable.length, blockedPermanent: permanent.length, skippedMissing: missing.length };
}
// Mirrors syncAgent.prioritizeProject: requeue failed, then bump active rows.
function prioritizeProject(db: any, projectId: string, priority = 10) {
  const retry = requeueFailedForProject(db, projectId, priority);
  const bumped = bumpProjectPriority(db, projectId, priority);
  return { bumped, ...retry };
}

// Exact SQL from electron/db.ts markFileMissing / reconcileMovedFile.
function markFileMissing(db: any, filePath: string) {
  db.prepare("UPDATE files SET local_status='missing', modified_at=? WHERE file_path=?")
    .run(new Date().toISOString(), filePath);
}
function reconcileMovedFile(db: any, opts: { id: string; newPath: string; newSize: number; newMtime: string }) {
  db.prepare(`
    UPDATE files
    SET file_path=?, file_name=?, file_size=?, modified_at=?,
        local_status='present', reconciled_from=file_path,
        sync_status=CASE WHEN sync_status='missing' THEN 'synced' ELSE sync_status END
    WHERE id=?
  `).run(opts.newPath, opts.newPath.split('/').pop(), opts.newSize, opts.newMtime, opts.id);
}

function iso() { return new Date().toISOString(); }

maybeDescribe('5,000-file scale — enqueue + dedup correctness (real arm64 sqlite)', () => {
  let Database: any;
  let db: any;

  beforeEach(async () => {
    if (!Database) Database = (await import(NATIVE_SQLITE_PATH)).default;
    db = buildSchema(Database);
  });
  afterEach(() => db.close());

  it('enqueues exactly one active queue row per file across 5,000 files', () => {
    const N = 5000;
    for (let i = 0; i < N; i++) {
      enqueueSyncItemIdempotent(db, {
        id: `q-${i}`, project_id: '__standalone__', file_id: `f-${i}`,
        file_name: `f${i}.wav`, type: 'dependency_upload', priority: 3, created_at: iso(),
      });
    }
    const active = db.prepare(
      "SELECT COUNT(*) c FROM sync_queue WHERE status IN ('pending','uploading','retrying')"
    ).get().c;
    expect(active).toBe(N);
  });

  it('restart (re-running enqueue against files already queued) does not grow the queue', () => {
    const N = 500; // scaled down from 5000 for fast CI; identical code path
    for (let i = 0; i < N; i++) {
      enqueueSyncItemIdempotent(db, {
        id: `q-${i}`, project_id: '__standalone__', file_id: `f-${i}`,
        file_name: `f${i}.wav`, type: 'dependency_upload', priority: 3, created_at: iso(),
      });
    }
    const before = db.prepare('SELECT COUNT(*) c FROM sync_queue').get().c;

    // Simulate app restart: startup discovery re-attempts enqueue for every
    // already-queued file (mirrors real discovery calling enqueue idempotently
    // regardless of whether the file was already pending).
    for (let i = 0; i < N; i++) {
      enqueueSyncItemIdempotent(db, {
        id: `q-restart-${i}`, project_id: '__standalone__', file_id: `f-${i}`,
        file_name: `f${i}.wav`, type: 'dependency_upload', priority: 3, created_at: iso(),
      });
    }
    const after = db.prepare('SELECT COUNT(*) c FROM sync_queue').get().c;
    expect(after).toBe(before);
  });

  it('does not create duplicate active queue rows for the same file+type', () => {
    for (let i = 0; i < 10; i++) {
      enqueueSyncItemIdempotent(db, {
        id: `dup-${i}`, project_id: '__standalone__', file_id: 'shared-file',
        file_name: 'dup.wav', type: 'dependency_upload', priority: 3, created_at: iso(),
      });
    }
    const rows = db.prepare(`
      SELECT COUNT(*) c FROM sync_queue WHERE file_id = 'shared-file' AND status IN ('pending','uploading','retrying')
    `).get().c;
    expect(rows).toBe(1);
  });
});

maybeDescribe('Startup crash recovery + dedup (repairStalledQueue, real arm64 sqlite)', () => {
  let Database: any;
  let db: any;

  beforeEach(async () => {
    if (!Database) Database = (await import(NATIVE_SQLITE_PATH)).default;
    db = buildSchema(Database);
  });
  afterEach(() => db.close());

  it('resets zombie uploading rows to pending on startup', () => {
    db.prepare(`
      INSERT INTO sync_queue (id, project_id, file_id, type, status, priority, created_at, started_at)
      VALUES ('zombie-1', '__standalone__', 'f1', 'dependency_upload', 'uploading', 3, ?, ?)
    `).run(iso(), iso());

    const result = repairStalledQueue(db);
    expect(result.recovered).toBe(1);
    expect(db.prepare("SELECT status FROM sync_queue WHERE id='zombie-1'").get().status).toBe('pending');
  });

  it('collapses true duplicate active rows, keeping only the newest', () => {
    db.prepare(`INSERT INTO sync_queue (id, project_id, file_id, type, status, priority, created_at)
      VALUES ('older', 'p1', 'f1', 'dependency_upload', 'pending', 3, '2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO sync_queue (id, project_id, file_id, type, status, priority, created_at)
      VALUES ('newer', 'p1', 'f1', 'dependency_upload', 'pending', 3, '2026-01-02T00:00:00.000Z')`).run();

    const result = repairStalledQueue(db);
    expect(result.deduped).toBe(1);
    const remaining = db.prepare("SELECT id FROM sync_queue WHERE project_id='p1' AND file_id='f1'").all();
    expect(remaining).toEqual([{ id: 'newer' }]);
  });

  it('never touches distinct pending rows for different files', () => {
    enqueueSyncItemIdempotent(db, { id: 'a', project_id: 'p1', file_id: 'f1', type: 'dependency_upload', created_at: iso() });
    enqueueSyncItemIdempotent(db, { id: 'b', project_id: 'p1', file_id: 'f2', type: 'dependency_upload', created_at: iso() });
    const before = db.prepare('SELECT COUNT(*) c FROM sync_queue').get().c;
    repairStalledQueue(db);
    expect(db.prepare('SELECT COUNT(*) c FROM sync_queue').get().c).toBe(before);
  });

  it('prunes a dangling-file_id duplicate when a valid row exists for the same work item (legacy watcher bug)', () => {
    db.prepare(`INSERT INTO files (id, file_path, file_name, file_type, file_size, created_at, modified_at)
      VALUES ('real-fid', '/fake/a.wav', 'a.wav', 'wav', 10, ?, ?)`).run(iso(), iso());
    // Valid row from the fixed enqueue path
    db.prepare(`INSERT INTO sync_queue (id, project_id, file_id, file_name, type, status, priority, created_at)
      VALUES ('valid', '__standalone__', 'real-fid', 'a.wav', 'dependency_upload', 'pending', 3, ?)`).run(iso());
    // Dangling row the old watcher bug left behind (file_id never persisted)
    db.prepare(`INSERT INTO sync_queue (id, project_id, file_id, file_name, type, status, priority, created_at)
      VALUES ('dangling', '__standalone__', 'ghost-fid', 'a.wav', 'dependency_upload', 'pending', 3, ?)`).run(iso());

    const result = repairStalledQueue(db);
    expect(result.deduped).toBe(1);
    const remaining = db.prepare("SELECT id FROM sync_queue").all();
    expect(remaining).toEqual([{ id: 'valid' }]);
  });

  it('keeps a solitary dangling-file_id row (file_name fallback still syncs it)', () => {
    db.prepare(`INSERT INTO sync_queue (id, project_id, file_id, file_name, type, status, priority, created_at)
      VALUES ('solo', '__standalone__', 'ghost-fid', 'b.wav', 'dependency_upload', 'pending', 3, ?)`).run(iso());
    const result = repairStalledQueue(db);
    expect(result.deduped).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM sync_queue').get().c).toBe(1);
  });
});

maybeDescribe('Sync This Project — priority bump (real arm64 sqlite)', () => {
  let Database: any;
  let db: any;

  beforeEach(async () => {
    if (!Database) Database = (await import(NATIVE_SQLITE_PATH)).default;
    db = buildSchema(Database);
  });
  afterEach(() => db.close());

  it('bumps only the target project\'s active rows, leaving others untouched', () => {
    for (const proj of ['proj-a', 'proj-b']) {
      for (let i = 0; i < 3; i++) {
        enqueueSyncItemIdempotent(db, {
          id: `${proj}-${i}`, project_id: proj, file_id: `f-${proj}-${i}`,
          type: 'dependency_upload', priority: 3, created_at: iso(),
        });
      }
    }
    const changed = bumpProjectPriority(db, 'proj-a', 10);
    expect(changed).toBe(3);

    const aPriorities = db.prepare("SELECT priority FROM sync_queue WHERE project_id='proj-a'").all();
    const bPriorities = db.prepare("SELECT priority FROM sync_queue WHERE project_id='proj-b'").all();
    expect(aPriorities.every((r: any) => r.priority === 10)).toBe(true);
    expect(bPriorities.every((r: any) => r.priority === 3)).toBe(true);
  });

  it('prioritized project rows are returned first by getPendingSyncItems', () => {
    enqueueSyncItemIdempotent(db, { id: 'old', project_id: 'old-proj', file_id: 'f1', type: 'dependency_upload', priority: 3, created_at: iso() });
    enqueueSyncItemIdempotent(db, { id: 'new', project_id: 'new-proj', file_id: 'f2', type: 'dependency_upload', priority: 3, created_at: iso() });
    bumpProjectPriority(db, 'new-proj', 10);
    const items = getPendingSyncItems(db, iso(), 1) as any[];
    expect(items[0].project_id).toBe('new-proj');
  });

  it('does not reset status or duplicate rows when bumping priority', () => {
    enqueueSyncItemIdempotent(db, { id: 'r1', project_id: 'proj-a', file_id: 'f1', type: 'dependency_upload', priority: 3, created_at: iso() });
    db.prepare("UPDATE sync_queue SET status='retrying' WHERE id='r1'").run();
    bumpProjectPriority(db, 'proj-a', 10);
    const row = db.prepare("SELECT status, priority FROM sync_queue WHERE id='r1'").get();
    expect(row).toEqual({ status: 'retrying', priority: 10 });
    expect(db.prepare('SELECT COUNT(*) c FROM sync_queue').get().c).toBe(1);
  });
});

maybeDescribe('Sync This Project — failed-row recovery (D3, real arm64 sqlite)', () => {
  let Database: any;
  let db: any;

  beforeEach(async () => {
    if (!Database) Database = (await import(NATIVE_SQLITE_PATH)).default;
    db = buildSchema(Database);
  });
  afterEach(() => db.close());

  function insertFile(id: string, opts: { localStatus?: string; syncStatus?: string } = {}) {
    db.prepare(`INSERT INTO files (id, file_path, file_name, file_type, file_size, sync_status, local_status, created_at, modified_at)
      VALUES (?, ?, ?, 'wav', 100, ?, ?, ?, ?)`)
      .run(id, `/fake/${id}.wav`, `${id}.wav`, opts.syncStatus ?? 'pending', opts.localStatus ?? 'present', iso(), iso());
  }
  function insertQueueRow(id: string, projectId: string, fileId: string | null, status: string, errorMessage: string | null = null) {
    db.prepare(`INSERT INTO sync_queue (id, project_id, file_id, type, status, priority, error_message, created_at)
      VALUES (?, ?, ?, 'dependency_upload', ?, 3, ?, ?)`)
      .run(id, projectId, fileId, status, errorMessage, iso());
  }

  it('pending project: rows are bumped, nothing requeued', () => {
    insertFile('f1');
    insertQueueRow('q1', 'p1', 'f1', 'pending');
    const s = prioritizeProject(db, 'p1');
    expect(s).toEqual({ bumped: 1, requeued: 0, blockedPermanent: 0, skippedMissing: 0 });
    expect(db.prepare("SELECT priority FROM sync_queue WHERE id='q1'").get().priority).toBe(10);
  });

  it('retrying project: rows are bumped without status reset', () => {
    insertFile('f1');
    insertQueueRow('q1', 'p1', 'f1', 'retrying', 'Request timeout after 60000ms');
    const s = prioritizeProject(db, 'p1');
    expect(s.bumped).toBe(1);
    expect(db.prepare("SELECT status FROM sync_queue WHERE id='q1'").get().status).toBe('retrying');
  });

  it('transient failed upload: requeued as pending at high priority with cleared retry state', () => {
    insertFile('f1');
    insertQueueRow('q1', 'p1', 'f1', 'failed', 'fetch failed [ETIMEDOUT]');
    db.prepare("UPDATE sync_queue SET retries=4, next_retry_at='2026-01-01T00:00:00Z' WHERE id='q1'").run();
    const s = prioritizeProject(db, 'p1');
    expect(s.requeued).toBe(1);
    const row = db.prepare("SELECT status, priority, retries, error_message, next_retry_at FROM sync_queue WHERE id='q1'").get();
    expect(row).toEqual({ status: 'pending', priority: 10, retries: 0, error_message: null, next_retry_at: null });
  });

  it('permanent failure (403) stays blocked and is reported', () => {
    insertFile('f1');
    insertQueueRow('q1', 'p1', 'f1', 'failed', 'Presign failed: 403 FORBIDDEN');
    const s = prioritizeProject(db, 'p1');
    expect(s.requeued).toBe(0);
    expect(s.blockedPermanent).toBe(1);
    expect(db.prepare("SELECT status FROM sync_queue WHERE id='q1'").get().status).toBe('failed');
  });

  it('missing local file is not blindly retried', () => {
    insertFile('f1', { localStatus: 'missing' });
    insertQueueRow('q1', 'p1', 'f1', 'failed', 'fetch failed [ECONNRESET]');
    const s = prioritizeProject(db, 'p1');
    expect(s.requeued).toBe(0);
    expect(s.skippedMissing).toBe(1);
    expect(db.prepare("SELECT status FROM sync_queue WHERE id='q1'").get().status).toBe('failed');
  });

  it('mixed-status project: each row gets the right treatment', () => {
    insertFile('f-pend'); insertFile('f-retry'); insertFile('f-trans');
    insertFile('f-perm'); insertFile('f-miss', { localStatus: 'missing' });
    insertQueueRow('q-pend', 'p1', 'f-pend', 'pending');
    insertQueueRow('q-retry', 'p1', 'f-retry', 'retrying', 'timeout');
    insertQueueRow('q-trans', 'p1', 'f-trans', 'failed', '500 Internal Server Error');
    insertQueueRow('q-perm', 'p1', 'f-perm', 'failed', '404 NOT_FOUND');
    insertQueueRow('q-miss', 'p1', 'f-miss', 'failed', 'ENOENT');
    const s = prioritizeProject(db, 'p1');
    expect(s).toEqual({ bumped: 3, requeued: 1, blockedPermanent: 1, skippedMissing: 1 }); // bumped = pend + retry + newly-requeued trans
    expect(db.prepare("SELECT status FROM sync_queue WHERE id='q-trans'").get().status).toBe('pending');
    expect(db.prepare("SELECT status FROM sync_queue WHERE id='q-perm'").get().status).toBe('failed');
    expect(db.prepare("SELECT status FROM sync_queue WHERE id='q-miss'").get().status).toBe('failed');
  });

  it('unrelated projects are completely unaffected', () => {
    insertFile('f1'); insertFile('f2');
    insertQueueRow('q1', 'p1', 'f1', 'failed', 'timeout');
    insertQueueRow('q2', 'p2', 'f2', 'failed', 'timeout');
    insertQueueRow('q3', 'p2', 'f2b', 'pending');
    prioritizeProject(db, 'p1');
    expect(db.prepare("SELECT status, priority FROM sync_queue WHERE id='q2'").get()).toEqual({ status: 'failed', priority: 3 });
    expect(db.prepare("SELECT priority FROM sync_queue WHERE id='q3'").get().priority).toBe(3);
  });

  it('duplicate invocation is idempotent — no duplicate rows, stable state', () => {
    insertFile('f1');
    insertQueueRow('q1', 'p1', 'f1', 'failed', 'timeout');
    const first = prioritizeProject(db, 'p1');
    const second = prioritizeProject(db, 'p1');
    expect(first.requeued).toBe(1);
    expect(second.requeued).toBe(0);       // already pending — nothing left to requeue
    expect(second.bumped).toBe(1);          // bump is a no-op-safe UPDATE of the same row
    expect(db.prepare('SELECT COUNT(*) c FROM sync_queue').get().c).toBe(1);
    expect(db.prepare("SELECT status, priority FROM sync_queue WHERE id='q1'").get()).toEqual({ status: 'pending', priority: 10 });
  });
});

maybeDescribe('Missing local file / renamed / moved reconciliation (real arm64 sqlite)', () => {
  let Database: any;
  let db: any;

  beforeEach(async () => {
    if (!Database) Database = (await import(NATIVE_SQLITE_PATH)).default;
    db = buildSchema(Database);
  });
  afterEach(() => db.close());

  it('markFileMissing flips local_status without touching sync_status', () => {
    db.prepare(`INSERT INTO files (id, file_path, file_name, file_type, file_size, sync_status, created_at, modified_at)
      VALUES ('f1', '/old/song.wav', 'song.wav', 'wav', 100, 'synced', ?, ?)`).run(iso(), iso());
    markFileMissing(db, '/old/song.wav');
    const row = db.prepare("SELECT local_status, sync_status FROM files WHERE id='f1'").get();
    expect(row.local_status).toBe('missing');
    expect(row.sync_status).toBe('synced');
  });

  it('reconcileMovedFile repoints file_path and clears missing status without re-triggering upload', () => {
    db.prepare(`INSERT INTO files (id, file_path, file_name, file_type, file_size, sync_status, local_status, created_at, modified_at)
      VALUES ('f1', '/old/song.wav', 'song.wav', 'wav', 100, 'missing', 'missing', ?, ?)`).run(iso(), iso());

    reconcileMovedFile(db, { id: 'f1', newPath: '/new/path/song.wav', newSize: 100, newMtime: iso() });

    const row = db.prepare("SELECT file_path, local_status, sync_status, reconciled_from FROM files WHERE id='f1'").get();
    expect(row.file_path).toBe('/new/path/song.wav');
    expect(row.local_status).toBe('present');
    expect(row.sync_status).toBe('synced'); // was 'missing' → flips back, no re-upload needed
    expect(row.reconciled_from).toBe('/old/song.wav');

    const queueCount = db.prepare("SELECT COUNT(*) c FROM sync_queue WHERE file_id='f1'").get().c;
    expect(queueCount).toBe(0); // no new upload enqueued — cloud already has this content
  });

  it('reconcileMovedFile does not clobber an already-synced status', () => {
    db.prepare(`INSERT INTO files (id, file_path, file_name, file_type, file_size, sync_status, local_status, created_at, modified_at)
      VALUES ('f2', '/old/b.wav', 'b.wav', 'wav', 50, 'synced', 'present', ?, ?)`).run(iso(), iso());
    reconcileMovedFile(db, { id: 'f2', newPath: '/new/b.wav', newSize: 50, newMtime: iso() });
    expect(db.prepare("SELECT sync_status FROM files WHERE id='f2'").get().sync_status).toBe('synced');
  });
});

// ── SyncAgent algorithm mirrors ───────────────────────────────────────────────
//
// syncAgent.ts imports `better-sqlite3` directly at module scope (same ABI
// constraint as db.ts), so the real class can't be instantiated under plain
// Node/vitest here. These tests exercise a line-for-line mirror of the
// concurrency/pause/cancel algorithm from electron/syncAgent.ts's _tick(),
// pauseUser()/resumeUser(), and cancelItem() — the actual end-to-end
// throughput fix (0.53 items/sec before → 885 items/sec after with mocked-
// instant network) was already proven via the headless-Electron benchmark
// harness, which runs the real compiled class under real Electron.

const DEFAULT_MAX_CONCURRENT = 2;
const MIN_CONCURRENT = 1;
const MAX_ALLOWED_CONCURRENT = 8;

/** Mirrors SyncAgent's slot-refill scheduler: immediate-on-completion, not poll-gated. */
class MirrorScheduler {
  maxConcurrent = DEFAULT_MAX_CONCURRENT;
  pausedReason: 'auth' | 'limit' | 'user' | null = null;
  running = true; // mirrors SyncAgent.running (tests construct it "started")
  activeUploads = new Set<string>();
  activeControllers = new Map<string, AbortController>();
  completedOrder: string[] = [];
  queue: { id: string; run: () => Promise<void> }[] = [];

  stop() { this.running = false; }

  setMaxConcurrent(n: number) {
    const floored = Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_CONCURRENT;
    this.maxConcurrent = Math.max(MIN_CONCURRENT, Math.min(MAX_ALLOWED_CONCURRENT, floored));
    this.tick();
  }

  pauseUser() { if (this.pausedReason === null) this.pausedReason = 'user'; }
  resumeUser() { if (this.pausedReason === 'user') { this.pausedReason = null; this.tick(); } }
  isPausedByUser() { return this.pausedReason === 'user'; }

  cancelItem(id: string): boolean {
    const c = this.activeControllers.get(id);
    if (!c) return false;
    c.abort();
    return true;
  }

  tick() {
    if (!this.running) return; // hardening: no work starts on a stopped agent
    if (this.pausedReason !== null) return;
    if (this.activeUploads.size >= this.maxConcurrent) return;
    const slots = this.maxConcurrent - this.activeUploads.size;
    const items = this.queue.splice(0, slots);
    for (const item of items) {
      this.activeUploads.add(item.id);
      const controller = new AbortController();
      this.activeControllers.set(item.id, controller);
      item.run().finally(() => {
        this.activeUploads.delete(item.id);
        this.activeControllers.delete(item.id);
        this.completedOrder.push(item.id);
        this.tick(); // immediate refill — the core fix
      });
    }
  }
}

describe('SyncAgent scheduler mirror — immediate refill (core throughput fix)', () => {
  it('refills a freed slot the instant an item completes, not after a poll interval', async () => {
    const sched = new MirrorScheduler();
    const N = 20;
    let started = 0;
    for (let i = 0; i < N; i++) {
      sched.queue.push({
        id: `item-${i}`,
        run: () => { started++; return Promise.resolve(); }, // instant "network"
      });
    }
    sched.maxConcurrent = 2;
    sched.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(N);
    expect(sched.completedOrder.length).toBe(N);
  });

  it('stop() mid-drain: completion refills start no further work (shutdown hardening)', async () => {
    const sched = new MirrorScheduler();
    sched.maxConcurrent = 1;
    let started = 0;
    for (let i = 0; i < 5; i++) {
      sched.queue.push({
        id: `item-${i}`,
        run: async () => { started++; await new Promise((r) => setTimeout(r, 10)); },
      });
    }
    sched.tick();          // starts item-0
    sched.stop();          // stop while item-0 is in flight
    await new Promise((r) => setTimeout(r, 80));
    expect(started).toBe(1);              // the in-flight item finished, nothing else started
    expect(sched.queue.length).toBe(4);   // rest of the queue untouched for next launch
  });

  it('tick() after stop() is a no-op (IPC/retry-timer path)', () => {
    const sched = new MirrorScheduler();
    let started = false;
    sched.queue.push({ id: 'x', run: () => { started = true; return Promise.resolve(); } });
    sched.stop();
    sched.tick(); // e.g. a stale retry timer or sync:now arriving post-shutdown
    expect(started).toBe(false);
  });

  it('never runs more than maxConcurrent items at once', async () => {
    const sched = new MirrorScheduler();
    let concurrent = 0;
    let maxSeen = 0;
    sched.maxConcurrent = 2;
    for (let i = 0; i < 10; i++) {
      sched.queue.push({
        id: `item-${i}`,
        run: async () => {
          concurrent++;
          maxSeen = Math.max(maxSeen, concurrent);
          await new Promise((r) => setTimeout(r, 5));
          concurrent--;
        },
      });
    }
    sched.tick();
    await new Promise((r) => setTimeout(r, 200));
    expect(maxSeen).toBeLessThanOrEqual(2);
  });
});

describe('SyncAgent scheduler mirror — pause and resume', () => {
  it('pauseUser() stops new work from starting', () => {
    const sched = new MirrorScheduler();
    let started = false;
    sched.queue.push({ id: 'x', run: () => { started = true; return Promise.resolve(); } });
    sched.pauseUser();
    sched.tick();
    expect(started).toBe(false);
    expect(sched.isPausedByUser()).toBe(true);
  });

  it('resumeUser() allows queued work to proceed', async () => {
    const sched = new MirrorScheduler();
    let started = false;
    sched.queue.push({ id: 'x', run: () => { started = true; return Promise.resolve(); } });
    sched.pauseUser();
    sched.tick();
    expect(started).toBe(false);
    sched.resumeUser();
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(true);
  });

  it('resumeUser() is a no-op when there is no active user pause (mirrors auth/limit protection)', () => {
    const sched = new MirrorScheduler();
    sched.pausedReason = 'auth';
    sched.resumeUser();
    expect(sched.pausedReason).toBe('auth'); // NOT cleared — only setAuthToken()/upgrade can clear this
  });
});

describe('Persistent pause (D2) — mirrors main.ts store wiring', () => {
  // Fake electron-store scoped to one "user-data dir" (one Map per store,
  // like one store file per userData directory).
  function makeStore() {
    const m = new Map<string, unknown>();
    return {
      get: (k: string, d: unknown) => (m.has(k) ? m.get(k) : d),
      set: (k: string, v: unknown) => void m.set(k, v),
    };
  }
  // Mirrors main.ts: sync:pause / sync:resume handlers persist, startup restores.
  function pauseViaIpc(sched: MirrorScheduler, store: ReturnType<typeof makeStore>) {
    sched.pauseUser();
    store.set('syncPausedByUser', true);
  }
  function resumeViaIpc(sched: MirrorScheduler, store: ReturnType<typeof makeStore>) {
    sched.resumeUser();
    store.set('syncPausedByUser', false);
  }
  function startupRestore(store: ReturnType<typeof makeStore>): MirrorScheduler {
    const sched = new MirrorScheduler();
    if (store.get('syncPausedByUser', false)) sched.pauseUser(); // before start()
    return sched;
  }

  it('pause → restart → still paused', () => {
    const store = makeStore();
    const first = startupRestore(store);
    pauseViaIpc(first, store);
    expect(first.isPausedByUser()).toBe(true);

    const second = startupRestore(store); // app relaunch
    expect(second.isPausedByUser()).toBe(true);

    // and no work starts on the relaunched instance
    let started = false;
    second.queue.push({ id: 'x', run: () => { started = true; return Promise.resolve(); } });
    second.tick();
    expect(started).toBe(false);
  });

  it('resume → restart → still resumed', () => {
    const store = makeStore();
    const first = startupRestore(store);
    pauseViaIpc(first, store);
    resumeViaIpc(first, store);

    const second = startupRestore(store);
    expect(second.isPausedByUser()).toBe(false);
  });

  it('auth block + persisted user resume: resume clears only the user layer, auth still blocks', () => {
    const store = makeStore();
    const sched = startupRestore(store);
    pauseViaIpc(sched, store);
    sched.pausedReason = 'auth'; // token revoked while user-paused? auth wins as the live reason
    resumeViaIpc(sched, store);
    expect(sched.pausedReason).toBe('auth'); // still blocked
    expect(store.get('syncPausedByUser', true)).toBe(false); // but the persisted user intent is cleared
    // relaunch: auth state is re-derived live, user pause not restored
    const relaunched = startupRestore(store);
    expect(relaunched.isPausedByUser()).toBe(false);
  });

  it('plan-limit block + user resume: resume cannot bypass the limit pause', () => {
    const store = makeStore();
    const sched = startupRestore(store);
    sched.pausedReason = 'limit';
    resumeViaIpc(sched, store);
    expect(sched.pausedReason).toBe('limit');
    let started = false;
    sched.queue.push({ id: 'x', run: () => { started = true; return Promise.resolve(); } });
    sched.tick();
    expect(started).toBe(false);
  });

  it('system pauses are never persisted — only the user pause key exists in the store', () => {
    const store = makeStore();
    const sched = startupRestore(store);
    sched.pausedReason = 'auth'; // system pause happens; nothing writes the store
    const relaunched = startupRestore(store);
    expect(relaunched.pausedReason).toBe(null); // auth must be re-derived, not restored
  });
});

describe('SyncAgent scheduler mirror — cancellation', () => {
  it('cancelItem aborts the tracked controller for an in-flight item', async () => {
    const sched = new MirrorScheduler();
    let aborted = false;
    sched.queue.push({
      id: 'x',
      run: () => new Promise<void>(() => { /* never resolves on its own — cancelled externally */ }),
    });
    sched.tick();
    const controller = sched.activeControllers.get('x')!;
    controller.signal.addEventListener('abort', () => { aborted = true; });
    const result = sched.cancelItem('x');
    expect(result).toBe(true);
    expect(aborted).toBe(true);
  });

  it('cancelItem on an inactive item is a safe no-op', () => {
    const sched = new MirrorScheduler();
    expect(sched.cancelItem('not-active')).toBe(false);
  });
});

describe('SyncAgent scheduler mirror — setMaxConcurrent bounds', () => {
  it('clamps below the minimum up to 1', () => {
    const sched = new MirrorScheduler();
    sched.setMaxConcurrent(0);
    expect(sched.maxConcurrent).toBe(1);
    sched.setMaxConcurrent(-5);
    expect(sched.maxConcurrent).toBe(1);
  });

  it('clamps above the ceiling down to 8', () => {
    const sched = new MirrorScheduler();
    sched.setMaxConcurrent(999);
    expect(sched.maxConcurrent).toBe(8);
  });

  it('accepts values in the normal user-facing range', () => {
    const sched = new MirrorScheduler();
    sched.setMaxConcurrent(4);
    expect(sched.maxConcurrent).toBe(4);
  });
});

// ── Sample-library folder classification (real import — no better-sqlite3 dep) ─

describe('Sample-library folder classification (classifyFolderForImport)', () => {
  it('flags a folder with a known vendor name as a likely sample library', async () => {
    const { classifyFolderForImport } = await import('./discovery');
    const result = classifyFolderForImport('/Users/me/Music/Splice', ['a.wav', 'b.wav']);
    expect(result.likelySampleLibrary).toBe(true);
    expect(result.reason).toBe('name_match');
  });

  it('flags a folder with hundreds of audio files and no DAW project as a likely sample library', async () => {
    const { classifyFolderForImport } = await import('./discovery');
    const entries = Array.from({ length: 250 }, (_, i) => `kick_${i}.wav`);
    const result = classifyFolderForImport('/Users/me/Music/My Drum Hits', entries);
    expect(result.likelySampleLibrary).toBe(true);
    expect(result.reason).toBe('high_audio_ratio');
  });

  it('does NOT flag a real project folder with many stems plus one project file', async () => {
    const { classifyFolderForImport } = await import('./discovery');
    const entries = [...Array.from({ length: 20 }, (_, i) => `stem_${i}.wav`), 'MySong.als'];
    const result = classifyFolderForImport('/Users/me/Music/Ableton/MySong', entries);
    expect(result.likelySampleLibrary).toBe(false);
    expect(result.reason).toBe('none');
  });

  it('does NOT classify on file count alone — a project file present always wins, regardless of audio count', async () => {
    const { classifyFolderForImport } = await import('./discovery');
    const entries = [...Array.from({ length: 500 }, (_, i) => `bounce_${i}.wav`), 'BigSong.flp'];
    const result = classifyFolderForImport('/Users/me/Music/FL Studio/BigSong', entries);
    expect(result.likelySampleLibrary).toBe(false);
  });

  it('does NOT flag a small folder of audio files with no vendor-name match', async () => {
    const { classifyFolderForImport } = await import('./discovery');
    const result = classifyFolderForImport('/Users/me/Desktop/a few sounds', ['a.wav', 'b.wav', 'c.wav']);
    expect(result.likelySampleLibrary).toBe(false);
    expect(result.reason).toBe('none');
  });
});
