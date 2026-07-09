/**
 * Regression tests for the pending-resync bug: app startup re-discovery used
 * to unconditionally reset sync_status to 'pending' on every upsert, flipping
 * all previously-synced projects/files back to Pending on every launch.
 *
 * Fix: ON CONFLICT clauses now only reset sync_status when file_size or
 * modified_at actually differ from the stored row (electron/db.ts
 * upsertProject / upsertFile / upsertStandaloneFile).
 *
 * These tests replicate the exact SQL from db.ts against a real arm64 Node
 * better-sqlite3 binary (db.ts itself can't be imported directly — it uses
 * the Electron-ABI native module at module load time).
 *
 * Run: npx vitest run electron/pending-resync.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'fs';

import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from './test-helpers/native-sqlite';
const maybeDescribe = nativeSqliteAvailable ? describe : describe.skip;

function buildSchema(Database: any) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      daw_type TEXT DEFAULT 'unknown',
      file_size INTEGER DEFAULT 0,
      sync_status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL,
      modified_at TEXT
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      sync_status TEXT DEFAULT 'pending',
      checksum TEXT,
      bpm INTEGER,
      key_note TEXT,
      duration REAL,
      role TEXT DEFAULT 'unknown',
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
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

// Exact SQL from electron/db.ts upsertProject — kept in sync with the source.
function upsertProject(db: any, project: {
  id: string; project_name: string; file_path: string; daw_type: string;
  file_size: number; created_at: string; modified_at: string;
}) {
  db.prepare(`
    INSERT INTO projects (id, project_name, file_path, daw_type, file_size, created_at, modified_at)
    VALUES (@id, @project_name, @file_path, @daw_type, @file_size, @created_at, @modified_at)
    ON CONFLICT(file_path) DO UPDATE SET
      project_name = excluded.project_name,
      file_size = excluded.file_size,
      modified_at = excluded.modified_at,
      sync_status = CASE
        WHEN excluded.file_size != projects.file_size OR excluded.modified_at != projects.modified_at
        THEN 'pending'
        ELSE projects.sync_status
      END
  `).run(project);
}

// Exact SQL from electron/db.ts upsertFile.
function upsertFile(db: any, file: {
  id: string; project_id: string; file_path: string; file_name: string; file_type: string;
  file_size: number; checksum?: string; bpm?: number | null; key_note?: string | null;
  duration?: number | null; role?: string | null; created_at: string; modified_at: string;
}) {
  db.prepare(`
    INSERT INTO files (id, project_id, file_path, file_name, file_type, file_size, checksum, bpm, key_note, duration, role, created_at, modified_at)
    VALUES (@id, @project_id, @file_path, @file_name, @file_type, @file_size, @checksum, @bpm, @key_note, @duration, @role, @created_at, @modified_at)
    ON CONFLICT(file_path) DO UPDATE SET
      project_id = COALESCE(files.project_id, excluded.project_id),
      file_size = excluded.file_size,
      checksum = excluded.checksum,
      bpm = COALESCE(excluded.bpm, files.bpm),
      key_note = COALESCE(excluded.key_note, files.key_note),
      duration = COALESCE(excluded.duration, files.duration),
      role = COALESCE(excluded.role, files.role),
      modified_at = excluded.modified_at,
      sync_status = CASE
        WHEN excluded.file_size != files.file_size OR excluded.modified_at != files.modified_at
        THEN 'pending'
        ELSE files.sync_status
      END
  `).run({
    id: file.id, project_id: file.project_id, file_path: file.file_path, file_name: file.file_name,
    file_type: file.file_type, file_size: file.file_size, checksum: file.checksum ?? null,
    bpm: file.bpm ?? null, key_note: file.key_note ?? null, duration: file.duration ?? null,
    role: file.role ?? 'unknown', created_at: file.created_at, modified_at: file.modified_at,
  });
}

// Exact SQL from electron/db.ts upsertStandaloneFile's UPDATE branch.
function upsertStandaloneFileUpdate(db: any, existingId: string, file: {
  file_size: number; checksum?: string; bpm?: number | null; key_note?: string | null;
  duration?: number | null; role?: string | null; modified_at: string;
}) {
  db.prepare(`
    UPDATE files SET
      file_size = ?, checksum = ?,
      bpm = COALESCE(?, bpm), key_note = COALESCE(?, key_note),
      duration = COALESCE(?, duration), role = COALESCE(?, role),
      modified_at = ?,
      sync_status = CASE
        WHEN ? != file_size OR ? != modified_at THEN 'pending'
        ELSE sync_status
      END
    WHERE id = ?
  `).run(
    file.file_size, file.checksum ?? null,
    file.bpm ?? null, file.key_note ?? null,
    file.duration ?? null, file.role ?? 'unknown',
    file.modified_at,
    file.file_size, file.modified_at,
    existingId,
  );
}

maybeDescribe('pending-resync regression', () => {
  let Database: any;
  let db: any;

  beforeEach(async () => {
    if (!Database) {
      Database = (await import(NATIVE_SQLITE_PATH)).default;
    }
    db = buildSchema(Database);
  });

  it('a synced unchanged project remains synced after upsertProject is called again', () => {
    const base = { id: 'p1', project_name: 'Track A', file_path: '/a.als', daw_type: 'ableton', file_size: 1000, created_at: '2026-01-01', modified_at: '2026-01-01T00:00:00Z' };
    upsertProject(db, base);
    db.prepare("UPDATE projects SET sync_status = 'synced' WHERE id = 'p1'").run();

    // Re-discovery: same file_size, same modified_at — simulates startup scan finding no real change.
    upsertProject(db, { ...base });

    const row = db.prepare('SELECT sync_status FROM projects WHERE id = ?').get('p1') as any;
    expect(row.sync_status).toBe('synced');
  });

  it('a synced unchanged file remains synced after upsertFile is called again', () => {
    const base = { id: 'f1', project_id: 'p1', file_path: '/a.wav', file_name: 'a.wav', file_type: 'wav', file_size: 500, created_at: '2026-01-01', modified_at: '2026-01-01T00:00:00Z' };
    upsertFile(db, base);
    db.prepare("UPDATE files SET sync_status = 'synced' WHERE id = 'f1'").run();

    upsertFile(db, { ...base });

    const row = db.prepare('SELECT sync_status FROM files WHERE id = ?').get('f1') as any;
    expect(row.sync_status).toBe('synced');
  });

  it('changed modified_at resets project status to Pending', () => {
    const base = { id: 'p2', project_name: 'Track B', file_path: '/b.als', daw_type: 'ableton', file_size: 1000, created_at: '2026-01-01', modified_at: '2026-01-01T00:00:00Z' };
    upsertProject(db, base);
    db.prepare("UPDATE projects SET sync_status = 'synced' WHERE id = 'p2'").run();

    upsertProject(db, { ...base, modified_at: '2026-01-02T00:00:00Z' });

    const row = db.prepare('SELECT sync_status FROM projects WHERE id = ?').get('p2') as any;
    expect(row.sync_status).toBe('pending');
  });

  it('changed file_size resets file status to Pending', () => {
    const base = { id: 'f2', project_id: 'p1', file_path: '/b.wav', file_name: 'b.wav', file_type: 'wav', file_size: 500, created_at: '2026-01-01', modified_at: '2026-01-01T00:00:00Z' };
    upsertFile(db, base);
    db.prepare("UPDATE files SET sync_status = 'synced' WHERE id = 'f2'").run();

    upsertFile(db, { ...base, file_size: 999 });

    const row = db.prepare('SELECT sync_status FROM files WHERE id = ?').get('f2') as any;
    expect(row.sync_status).toBe('pending');
  });

  it('changed file_size resets standalone-file status to Pending (UPDATE-branch path)', () => {
    db.prepare(`INSERT INTO files (id, project_id, file_path, file_name, file_type, file_size, sync_status, created_at, modified_at)
      VALUES ('f3', NULL, '/c.wav', 'c.wav', 'wav', 500, 'synced', '2026-01-01', '2026-01-01T00:00:00Z')`).run();

    upsertStandaloneFileUpdate(db, 'f3', { file_size: 700, modified_at: '2026-01-01T00:00:00Z' });

    const row = db.prepare('SELECT sync_status FROM files WHERE id = ?').get('f3') as any;
    expect(row.sync_status).toBe('pending');
  });

  it('repeated startup discovery creates no sync_queue entries for unchanged files', () => {
    const base = { id: 'f4', project_id: 'p1', file_path: '/d.wav', file_name: 'd.wav', file_type: 'wav', file_size: 500, created_at: '2026-01-01', modified_at: '2026-01-01T00:00:00Z' };
    upsertFile(db, base);
    db.prepare("UPDATE files SET sync_status = 'synced' WHERE id = 'f4'").run();

    // Simulate 3 consecutive "startup discovery" passes finding the same unchanged file.
    for (let i = 0; i < 3; i++) {
      upsertFile(db, { ...base });
      const row = db.prepare('SELECT sync_status FROM files WHERE id = ?').get('f4') as any;
      // A real sync agent only enqueues files whose sync_status flipped to 'pending'.
      // Since it never flips here, no queue entries should ever be created.
      if (row.sync_status === 'pending') {
        db.prepare(`INSERT INTO sync_queue (id, file_id, file_name, type, created_at) VALUES (?, ?, ?, 'upload', ?)`)
          .run(`q-${i}`, 'f4', 'd.wav', '2026-01-01');
      }
    }

    const queueCount = db.prepare('SELECT COUNT(*) as c FROM sync_queue WHERE file_id = ?').get('f4') as any;
    expect(queueCount.c).toBe(0);
  });

  it('failed/retry state is not overwritten by unchanged discovery', () => {
    const base = { id: 'f5', project_id: 'p1', file_path: '/e.wav', file_name: 'e.wav', file_type: 'wav', file_size: 500, created_at: '2026-01-01', modified_at: '2026-01-01T00:00:00Z' };
    upsertFile(db, base);
    db.prepare("UPDATE files SET sync_status = 'failed' WHERE id = 'f5'").run();

    // Re-discovery finds the same unchanged file — must not clobber 'failed' with 'pending'.
    upsertFile(db, { ...base });

    const row = db.prepare('SELECT sync_status FROM files WHERE id = ?').get('f5') as any;
    expect(row.sync_status).toBe('failed');
  });
});
