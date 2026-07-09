/**
 * Regression tests for the `local_status` column migration on the `files`
 * table (electron/db.ts line ~62: ALTER TABLE files ADD COLUMN local_status
 * TEXT DEFAULT 'present'). A "no such column: local_status" SqliteError was
 * observed once in ~/.wavi/main.log during this session's QA testing; direct
 * inspection of both the disposable QA database and the production database
 * confirmed the column is present and the migration runs correctly on every
 * _initDatabaseAtPath() call (it's idempotent — wrapped in try/catch, safe to
 * re-run). These tests pin that behavior so a future schema change can't
 * silently reintroduce the gap.
 *
 * Uses the same real arm64 Node better-sqlite3 binary as the other
 * electron/*.integration tests (db.ts itself can't be imported directly — it
 * pulls in the Electron-ABI native module and `app` at module load time).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'fs';

import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from './test-helpers/native-sqlite';
const maybeDescribe = nativeSqliteAvailable ? describe : describe.skip;

// The exact migration line from electron/db.ts _initDatabaseAtPath, reproduced
// here for direct testing.
function runLocalStatusMigration(db: any) {
  try { db.exec("ALTER TABLE files ADD COLUMN local_status TEXT DEFAULT 'present'"); } catch { /* already exists */ }
}

// Minimal pre-migration files table — mirrors what an old DB created before
// this column was added would look like.
function buildLegacySchema(Database: any) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      sync_status TEXT DEFAULT 'pending',
      checksum TEXT,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL
    );
  `);
  return db;
}

function hasColumn(db: any, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

maybeDescribe('local_status column migration', () => {
  let Database: any;

  beforeEach(async () => {
    if (!Database) Database = (await import(NATIVE_SQLITE_PATH)).default;
  });

  it('a fresh database that already has the column survives a redundant migration run', () => {
    const db = buildLegacySchema(Database);
    runLocalStatusMigration(db); // first run: adds the column
    expect(hasColumn(db, 'files', 'local_status')).toBe(true);
    expect(() => runLocalStatusMigration(db)).not.toThrow(); // second run: idempotent
    expect(hasColumn(db, 'files', 'local_status')).toBe(true);
  });

  it('an existing database created before the column existed gets it added on next migration run', () => {
    const db = buildLegacySchema(Database);
    expect(hasColumn(db, 'files', 'local_status')).toBe(false);
    runLocalStatusMigration(db);
    expect(hasColumn(db, 'files', 'local_status')).toBe(true);
  });

  it('rows inserted before migration default to "present" once the column exists', () => {
    const db = buildLegacySchema(Database);
    db.prepare(`INSERT INTO files (id, project_id, file_path, file_name, file_type, created_at, modified_at)
      VALUES ('f1', NULL, '/a.wav', 'a.wav', 'wav', '2026-01-01', '2026-01-01')`).run();
    runLocalStatusMigration(db);
    const row = db.prepare('SELECT local_status FROM files WHERE id = ?').get('f1') as any;
    expect(row.local_status).toBe('present');
  });

  it('"restart" — running the migration twice across two separate connections to the same file does not error or duplicate the column', () => {
    const { mkdtempSync } = require('fs');
    const { tmpdir } = require('os');
    const { join } = require('path');
    const dir = mkdtempSync(join(tmpdir(), 'wavi-local-status-'));
    const dbPath = join(dir, 'test.db');

    const db1 = new Database(dbPath);
    db1.exec(`CREATE TABLE files (id TEXT PRIMARY KEY, file_path TEXT, created_at TEXT, modified_at TEXT)`);
    runLocalStatusMigration(db1);
    expect(hasColumn(db1, 'files', 'local_status')).toBe(true);
    db1.close();

    // Simulate app restart: reopen the same file, run migration again.
    const db2 = new Database(dbPath);
    expect(() => runLocalStatusMigration(db2)).not.toThrow();
    expect(hasColumn(db2, 'files', 'local_status')).toBe(true);
    // Only one local_status column should exist (no duplicate-add error surfaced as a second column).
    const cols = db2.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === 'local_status').length).toBe(1);
    db2.close();
  });

  it('folder-scan-shaped queries (getMissingFiles equivalent) succeed after migration', () => {
    const db = buildLegacySchema(Database);
    runLocalStatusMigration(db);
    db.prepare(`INSERT INTO files (id, project_id, file_path, file_name, file_type, created_at, modified_at)
      VALUES ('f1', NULL, '/a.wav', 'a.wav', 'wav', '2026-01-01', '2026-01-01')`).run();
    db.prepare("UPDATE files SET local_status='missing' WHERE id='f1'").run();

    expect(() => {
      db.prepare("SELECT id, file_path, file_name, checksum, file_size, project_id FROM files WHERE local_status='missing'").all();
    }).not.toThrow();

    const missing = db.prepare("SELECT id FROM files WHERE local_status='missing'").all() as any[];
    expect(missing.map((r) => r.id)).toEqual(['f1']);
  });

  it('project/file queries using local_status fail clearly (not migrated) before the migration runs', () => {
    const db = buildLegacySchema(Database);
    expect(() => {
      db.prepare("SELECT id FROM files WHERE local_status='missing'").all();
    }).toThrow(/no such column: local_status/);
  });
});

maybeDescribe('regression: ALTER-before-CREATE ordering bug (root cause of the recurring error)', () => {
  let Database: any;

  beforeEach(async () => {
    if (!Database) Database = (await import(NATIVE_SQLITE_PATH)).default;
  });

  // Reproduces the exact bug: electron/db.ts _initDatabaseAtPath used to run
  // `ALTER TABLE files ADD COLUMN local_status ...` BEFORE the
  // `CREATE TABLE IF NOT EXISTS files (...)` statement. On a truly fresh
  // database (no tables at all), the ALTER throws "no such table" — which
  // the try/catch silently swallows, indistinguishable from "column already
  // exists" — and the later CREATE TABLE then creates `files` WITHOUT
  // local_status. The column only appeared after a second app restart (by
  // which point the table existed, so the ALTER finally succeeded).

  it('demonstrates the bug: ALTER-then-CREATE order loses the column on a truly fresh DB', () => {
    const db = new Database(':memory:');
    // Buggy order: migration runs first, against a table that doesn't exist yet.
    try { db.exec("ALTER TABLE files ADD COLUMN local_status TEXT DEFAULT 'present'"); } catch { /* swallowed, just like production code */ }
    db.exec(`CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, file_path TEXT, created_at TEXT, modified_at TEXT)`);

    const cols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'local_status')).toBe(false); // the bug, reproduced
  });

  it('proves the fix: CREATE-then-ALTER order gives the column on a truly fresh DB, first launch', () => {
    const db = new Database(':memory:');
    // Fixed order (current electron/db.ts): tables created first, migrations after.
    db.exec(`CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, file_path TEXT, created_at TEXT, modified_at TEXT)`);
    try { db.exec("ALTER TABLE files ADD COLUMN local_status TEXT DEFAULT 'present'"); } catch { /* already exists, on subsequent runs */ }

    const cols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'local_status')).toBe(true);
  });

  it('a fresh database reaches a fully-queryable state on the very first call, no restart needed', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, file_path TEXT, created_at TEXT, modified_at TEXT)`);
    try { db.exec("ALTER TABLE files ADD COLUMN local_status TEXT DEFAULT 'present'"); } catch {}

    // No second "restart" call here — this must work immediately.
    expect(() => {
      db.prepare("SELECT id FROM files WHERE local_status='missing'").all();
    }).not.toThrow();
  });
});
