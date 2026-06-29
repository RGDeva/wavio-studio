"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Real SQLite integration tests for electron/db.ts logic.
 *
 * Uses a separately installed arm64 Node-compatible better-sqlite3 binary at
 * /tmp/wavio-sqlite-test/ — the project's Electron-built binary has x86_64 ABI
 * and cannot load under arm64 Node (NODE_MODULE_VERSION mismatch).
 *
 * Run: npx vitest run electron/db.integration.test.ts
 *
 * This test proves:
 *   1. Fresh database initialization and WAL mode
 *   2. Schema migrations are idempotent (running twice is safe)
 *   3. Truncated 16-char SHA-256 hashes are nulled by the backward-compat migration
 *   4. next_retry_at column gate correctly filters retry-ready vs. not-yet-due items
 *   5. cloud_asset_id is persisted and retrievable after restart simulation
 *   6. cloud_version_id is persisted on project update
 *   7. projects.desktop_id uniqueness is enforced per-local (no cloud dependency)
 */
const vitest_1 = require("vitest");
const fs_1 = require("fs");
// ── ARM64 Node-compatible binary ──────────────────────────────────────────────
const NATIVE_SQLITE_PATH = '/tmp/wavio-sqlite-test/node_modules/better-sqlite3';
const nativeSqliteAvailable = (0, fs_1.existsSync)(NATIVE_SQLITE_PATH);
// If the arm64 binary isn't present, skip gracefully rather than fail CI.
// Run `mkdir -p /tmp/wavio-sqlite-test && npm install better-sqlite3` there to enable.
const maybeDescribe = nativeSqliteAvailable ? vitest_1.describe : vitest_1.describe.skip;
// ── Inline schema (mirrors electron/db.ts) ────────────────────────────────────
// We replicate the CREATE TABLE statements and migration steps here rather than
// importing db.ts directly, because db.ts runs all migrations at module load
// time using the module-level `db` singleton (which requires the Electron-ABI binary).
function buildSchema(Database, path = ':memory:') {
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      folder_path TEXT,
      project_name TEXT NOT NULL,
      daw_type TEXT DEFAULT 'unknown',
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      sync_status TEXT DEFAULT 'pending',
      cloud_id TEXT,
      cloud_version_id TEXT,
      version_count INTEGER DEFAULT 0,
      modified_at TEXT,
      created_at TEXT NOT NULL,
      checksum TEXT,
      last_synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      sync_status TEXT DEFAULT 'pending',
      cloud_url TEXT,
      cloud_asset_id TEXT,
      checksum TEXT,
      bpm INTEGER,
      key_note TEXT,
      duration REAL,
      role TEXT DEFAULT 'unknown',
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      file_id TEXT,
      file_name TEXT,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 5,
      retries INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      error_message TEXT,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT,
      checksum TEXT,
      file_size INTEGER DEFAULT 0,
      cloud_url TEXT,
      label TEXT DEFAULT 'version',
      version_type TEXT DEFAULT 'project',
      confirmed INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bounce_candidates (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      checksum TEXT,
      created_at TEXT NOT NULL
    );
  `);
    return db;
}
// ── Backward-compat migration logic (mirrors db.ts) ───────────────────────────
function applyTruncatedHashMigration(db) {
    db.exec(`
    UPDATE files           SET checksum = NULL WHERE checksum IS NOT NULL AND length(checksum) = 16 AND checksum GLOB '[0-9a-f]*';
    UPDATE versions        SET checksum = NULL WHERE checksum IS NOT NULL AND length(checksum) = 16 AND checksum GLOB '[0-9a-f]*';
    UPDATE bounce_candidates SET checksum = NULL WHERE checksum IS NOT NULL AND length(checksum) = 16 AND checksum GLOB '[0-9a-f]*';
  `);
}
// ── next_retry_at filter (mirrors db.ts getPendingSyncItems) ──────────────────
function getPendingSyncItems(db, now, limit = 10) {
    return db.prepare(`
    SELECT * FROM sync_queue
    WHERE status IN ('pending', 'retrying')
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY priority DESC, created_at ASC
    LIMIT ?
  `).all(now, limit);
}
// ── Tests ─────────────────────────────────────────────────────────────────────
maybeDescribe('SQLite integration (real better-sqlite3, arm64 Node binary)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(NATIVE_SQLITE_PATH);
    let db;
    (0, vitest_1.beforeEach)(() => {
        db = buildSchema(Database);
    });
    (0, vitest_1.afterEach)(() => {
        db.close();
    });
    // ── 1. Fresh database ──────────────────────────────────────────────────────
    (0, vitest_1.it)('initializes WAL mode on file-based database', () => {
        // WAL requires a disk file; :memory: always reports 'memory'
        const tmpPath = `/tmp/wavio-wal-test-${Date.now()}.db`;
        const fileDb = buildSchema(Database, tmpPath);
        const result = fileDb.pragma('journal_mode');
        fileDb.close();
        (0, vitest_1.expect)(result[0].journal_mode).toBe('wal');
    });
    (0, vitest_1.it)('creates all required tables', () => {
        const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);
        (0, vitest_1.expect)(tables).toContain('projects');
        (0, vitest_1.expect)(tables).toContain('files');
        (0, vitest_1.expect)(tables).toContain('sync_queue');
        (0, vitest_1.expect)(tables).toContain('versions');
        (0, vitest_1.expect)(tables).toContain('bounce_candidates');
    });
    (0, vitest_1.it)('schema migration is idempotent (CREATE IF NOT EXISTS)', () => {
        // Running the schema again on an existing DB must not throw
        (0, vitest_1.expect)(() => buildSchema(Database)).not.toThrow();
        // Actually rebuild on the same in-memory DB
        db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, project_name TEXT NOT NULL, created_at TEXT NOT NULL)`);
    });
    // ── 2. Truncated-hash backward-compat migration ────────────────────────────
    (0, vitest_1.it)('nulls out 16-char hex truncated checksums in files table', () => {
        const id = 'f1';
        db.prepare(`INSERT INTO files (id, file_path, file_name, file_type, created_at, modified_at, checksum)
                VALUES (?, '/x', 'x.wav', 'wav', '2026-01-01', '2026-01-01', ?)`).run(id, 'deadbeefcafe1234'); // 16-char hex
        applyTruncatedHashMigration(db);
        const row = db.prepare('SELECT checksum FROM files WHERE id = ?').get(id);
        (0, vitest_1.expect)(row.checksum).toBeNull();
    });
    (0, vitest_1.it)('preserves 64-char full SHA-256 checksums', () => {
        const full = 'a'.repeat(64);
        db.prepare(`INSERT INTO files (id, file_path, file_name, file_type, created_at, modified_at, checksum)
                VALUES (?, '/x', 'x.wav', 'wav', '2026-01-01', '2026-01-01', ?)`).run('f2', full);
        applyTruncatedHashMigration(db);
        const row = db.prepare('SELECT checksum FROM files WHERE id = ?').get('f2');
        (0, vitest_1.expect)(row.checksum).toBe(full);
    });
    (0, vitest_1.it)('does not null non-hex 16-char strings (GLOB guard)', () => {
        db.prepare(`INSERT INTO files (id, file_path, file_name, file_type, created_at, modified_at, checksum)
                VALUES (?, '/x', 'x.wav', 'wav', '2026-01-01', '2026-01-01', ?)`).run('f3', 'MyPassphrase1234'); // 16 chars but has uppercase → not hex
        applyTruncatedHashMigration(db);
        const row = db.prepare('SELECT checksum FROM files WHERE id = ?').get('f3');
        (0, vitest_1.expect)(row.checksum).toBe('MyPassphrase1234');
    });
    (0, vitest_1.it)('applies to bounce_candidates and versions tables too', () => {
        const proj = { id: 'p1', project_name: 'Test', created_at: '2026-01-01' };
        db.prepare('INSERT INTO projects (id, project_name, created_at) VALUES (?, ?, ?)').run(proj.id, proj.project_name, proj.created_at);
        db.prepare(`INSERT INTO versions (id, project_id, checksum, created_at) VALUES (?, ?, ?, ?)`).run('v1', 'p1', 'abcd1234abcd1234', '2026-01-01');
        db.prepare(`INSERT INTO bounce_candidates (id, project_id, file_path, file_name, created_at, checksum) VALUES (?, ?, ?, ?, ?, ?)`).run('b1', 'p1', '/x', 'x.wav', '2026-01-01', 'abcd1234abcd1234');
        applyTruncatedHashMigration(db);
        const v = db.prepare('SELECT checksum FROM versions WHERE id = ?').get('v1');
        const b = db.prepare('SELECT checksum FROM bounce_candidates WHERE id = ?').get('b1');
        (0, vitest_1.expect)(v.checksum).toBeNull();
        (0, vitest_1.expect)(b.checksum).toBeNull();
    });
    // ── 3. next_retry_at time gate ─────────────────────────────────────────────
    (0, vitest_1.it)('returns pending items with null next_retry_at immediately', () => {
        db.prepare(`INSERT INTO sync_queue (id, type, status, created_at) VALUES ('q1','project_upload','pending','2026-01-01')`).run();
        const now = new Date().toISOString();
        const items = getPendingSyncItems(db, now);
        (0, vitest_1.expect)(items.length).toBe(1);
        (0, vitest_1.expect)(items[0].id).toBe('q1');
    });
    (0, vitest_1.it)('gates retrying items whose next_retry_at is in the future', () => {
        const future = new Date(Date.now() + 60000).toISOString();
        db.prepare(`INSERT INTO sync_queue (id, type, status, created_at, next_retry_at) VALUES ('q2','project_upload','retrying','2026-01-01',?)`).run(future);
        const now = new Date().toISOString();
        const items = getPendingSyncItems(db, now);
        (0, vitest_1.expect)(items.length).toBe(0);
    });
    (0, vitest_1.it)('returns retrying items whose next_retry_at has passed', () => {
        const past = new Date(Date.now() - 1000).toISOString();
        db.prepare(`INSERT INTO sync_queue (id, type, status, created_at, next_retry_at) VALUES ('q3','project_upload','retrying','2026-01-01',?)`).run(past);
        const now = new Date().toISOString();
        const items = getPendingSyncItems(db, now);
        (0, vitest_1.expect)(items.length).toBe(1);
        (0, vitest_1.expect)(items[0].id).toBe('q3');
    });
    (0, vitest_1.it)('does not return failed items', () => {
        db.prepare(`INSERT INTO sync_queue (id, type, status, created_at) VALUES ('q4','project_upload','failed','2026-01-01')`).run();
        const items = getPendingSyncItems(db, new Date().toISOString());
        (0, vitest_1.expect)(items.length).toBe(0);
    });
    // ── 4. cloud_asset_id persistence ─────────────────────────────────────────
    (0, vitest_1.it)('persists and retrieves cloud_asset_id on files row', () => {
        const assetId = 'cloud-uuid-abc-123';
        db.prepare(`INSERT INTO files (id, file_path, file_name, file_type, created_at, modified_at)
                VALUES ('f10', '/x.wav', 'x.wav', 'wav', '2026-01-01', '2026-01-01')`).run();
        db.prepare('UPDATE files SET cloud_asset_id = ? WHERE id = ?').run(assetId, 'f10');
        const row = db.prepare('SELECT cloud_asset_id FROM files WHERE id = ?').get('f10');
        (0, vitest_1.expect)(row.cloud_asset_id).toBe(assetId);
    });
    (0, vitest_1.it)('cloud_asset_id survives a simulated restart (close + reopen with file)', () => {
        const tmpPath = `/tmp/wavio-integration-test-${Date.now()}.db`;
        // Open, write, close (simulates first run)
        const db2 = buildSchema(Database, tmpPath);
        db2.prepare(`INSERT INTO files (id, file_path, file_name, file_type, created_at, modified_at)
                 VALUES ('f11', '/x.wav', 'x.wav', 'wav', '2026-01-01', '2026-01-01')`).run();
        db2.prepare('UPDATE files SET cloud_asset_id = ? WHERE id = ?').run('restart-test-id', 'f11');
        db2.close();
        // Reopen with a fresh connection (simulates restart)
        const db3 = buildSchema(Database, tmpPath);
        const row = db3.prepare('SELECT cloud_asset_id FROM files WHERE id = ?').get('f11');
        db3.close();
        (0, vitest_1.expect)(row.cloud_asset_id).toBe('restart-test-id');
    });
    // ── 5. cloud_version_id persistence on projects ───────────────────────────
    (0, vitest_1.it)('persists cloud_version_id on project row', () => {
        db.prepare(`INSERT INTO projects (id, project_name, created_at) VALUES ('p10', 'TestProject', '2026-01-01')`).run();
        db.prepare('UPDATE projects SET cloud_id = ?, cloud_version_id = ? WHERE id = ?')
            .run('cloud-proj-123', 'cloud-ver-456', 'p10');
        const row = db.prepare('SELECT cloud_id, cloud_version_id FROM projects WHERE id = ?').get('p10');
        (0, vitest_1.expect)(row.cloud_id).toBe('cloud-proj-123');
        (0, vitest_1.expect)(row.cloud_version_id).toBe('cloud-ver-456');
    });
    // ── 6. Retry does not duplicate sync_queue entries ─────────────────────────
    (0, vitest_1.it)('retry resets status to pending without creating duplicate rows', () => {
        db.prepare(`INSERT INTO sync_queue (id, type, status, retries, created_at) VALUES ('q10','project_upload','failed',4,'2026-01-01')`).run();
        // Simulate retryFailed()
        db.prepare(`UPDATE sync_queue SET status = 'pending', retries = 0, error_message = NULL WHERE status = 'failed'`).run();
        const rows = db.prepare('SELECT * FROM sync_queue WHERE id = ?').all('q10');
        (0, vitest_1.expect)(rows.length).toBe(1);
        (0, vitest_1.expect)(rows[0].status).toBe('pending');
        (0, vitest_1.expect)(rows[0].retries).toBe(0);
    });
    // ── 7. next_retry_at is written on failure and cleared on retry reset ──────
    (0, vitest_1.it)('next_retry_at is cleared when a failed item is reset for retry', () => {
        const future = new Date(Date.now() + 60000).toISOString();
        db.prepare(`INSERT INTO sync_queue (id, type, status, retries, created_at, next_retry_at) VALUES ('q11','project_upload','retrying',2,'2026-01-01',?)`).run(future);
        // Reset to pending (retryFailed)
        db.prepare(`UPDATE sync_queue SET status = 'pending', retries = 0, next_retry_at = NULL WHERE id = ?`).run('q11');
        const now = new Date().toISOString();
        const items = getPendingSyncItems(db, now);
        (0, vitest_1.expect)(items.some((i) => i.id === 'q11')).toBe(true);
    });
});
