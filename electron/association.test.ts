/**
 * Unit tests for file-to-project auto-association logic.
 *
 * Tests the three-part fix:
 *   1. upsertFile ON CONFLICT sets project_id when previously NULL
 *   2. findProjectForDirectory returns a project whose file lives in a given dir
 *   3. associateUnclaimedFilesInDirectory assigns standalone files to a project
 *
 * Uses the better-sqlite3 module resolved from the project's node_modules so tests
 * run under arm64 Node without the Electron-ABI binary.
 *
 * Run: npx vitest run electron/association.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join, dirname, sep } from 'path';
import { existsSync } from 'fs';
import crypto from 'crypto';

import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from './test-helpers/native-sqlite';
const available = nativeSqliteAvailable;
const maybeDescribe = available ? describe : describe.skip;

function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }

// ── Minimal schema matching production db.ts ──────────────────────────────────
function buildDb(Database: any) {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      daw_type TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      version_count INTEGER DEFAULT 1,
      sync_status TEXT DEFAULT 'pending',
      cloud_id TEXT,
      cloud_version_id TEXT,
      share_url TEXT,
      tracking_id TEXT,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      last_synced_at TEXT
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      file_path TEXT NOT NULL UNIQUE,
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
      modified_at TEXT NOT NULL,
      local_status TEXT DEFAULT 'present'
    );
  `);
  return db;
}

// ── Port the three functions under test ───────────────────────────────────────

function upsertProject(db: any, p: { id: string; project_name: string; file_path: string }) {
  db.prepare(`
    INSERT INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
    VALUES (?, ?, ?, 'Ableton Live', ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET modified_at = excluded.modified_at
  `).run(p.id, p.project_name, p.file_path, now(), now());
}

function upsertFile(db: any, f: {
  id: string; project_id: string; file_path: string;
  file_name: string; file_type: string; file_size: number; checksum?: string;
}) {
  db.prepare(`
    INSERT INTO files (id, project_id, file_path, file_name, file_type, file_size, checksum, created_at, modified_at)
    VALUES (@id, @project_id, @file_path, @file_name, @file_type, @file_size, @checksum, @created_at, @modified_at)
    ON CONFLICT(file_path) DO UPDATE SET
      project_id = COALESCE(files.project_id, excluded.project_id),
      file_size  = excluded.file_size,
      checksum   = excluded.checksum,
      sync_status = 'pending'
  `).run({ checksum: null, created_at: now(), modified_at: now(), ...f });
}

function upsertStandaloneFile(db: any, f: {
  id: string; file_path: string; file_name: string; file_type: string; file_size: number; checksum?: string;
}) {
  const existing = db.prepare('SELECT id FROM files WHERE file_path = ?').get(f.file_path) as { id: string } | undefined;
  if (existing) {
    db.prepare(`UPDATE files SET file_size=?, checksum=?, sync_status='pending' WHERE id=?`)
      .run(f.file_size, f.checksum ?? null, existing.id);
    return existing.id;
  }
  db.prepare(`
    INSERT INTO files (id, project_id, file_path, file_name, file_type, file_size, checksum, created_at, modified_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `).run(f.id, f.file_path, f.file_name, f.file_type, f.file_size, f.checksum ?? null, now(), now());
  return f.id;
}

function findProjectForDirectory(db: any, dir: string): { id: string; file_path: string } | undefined {
  const rows = db.prepare('SELECT id, file_path FROM projects').all() as { id: string; file_path: string }[];
  return rows.find((r: any) => dirname(r.file_path) === dir);
}

function associateUnclaimedFilesInDirectory(db: any, projectId: string, dir: string): number {
  const prefix = dir + sep;
  const rows = db.prepare(
    "SELECT id FROM files WHERE project_id IS NULL AND (file_path = ? OR file_path LIKE ?)"
  ).all(dir, prefix + '%') as { id: string }[];
  if (rows.length === 0) return 0;
  const stmt = db.prepare("UPDATE files SET project_id=? WHERE id=? AND project_id IS NULL");
  const tx = db.transaction(() => {
    let count = 0;
    for (const row of rows) count += stmt.run(projectId, row.id).changes;
    return count;
  });
  return tx();
}

function getFileProjectId(db: any, filePath: string): string | null {
  const row = db.prepare('SELECT project_id FROM files WHERE file_path=?').get(filePath) as { project_id: string | null } | undefined;
  return row?.project_id ?? null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

maybeDescribe('File-to-project auto-association', () => {
  let Database: any;
  let db: any;

  beforeEach(async () => {
    Database = (await import(NATIVE_SQLITE_PATH)).default;
    db = buildDb(Database);
  });

  // ── Test 1: WAV first, ALS second ────────────────────────────────────────────
  it('1. WAV arrives first, ALS arrives later — WAV gets associated', () => {
    const dir = '/Users/test/MyProject';
    const wavPath = join(dir, 'beat.wav');
    const alsPath = join(dir, 'MyProject.als');
    const wavId = uuid();
    const projectId = uuid();

    // WAV arrives first — stored as standalone (no project yet)
    upsertStandaloneFile(db, { id: wavId, file_path: wavPath, file_name: 'beat.wav', file_type: 'wav', file_size: 44100 });
    expect(getFileProjectId(db, wavPath)).toBeNull();

    // ALS arrives — project created
    upsertProject(db, { id: projectId, project_name: 'MyProject', file_path: alsPath });

    // Retroactive association
    const claimed = associateUnclaimedFilesInDirectory(db, projectId, dir);
    expect(claimed).toBe(1);
    expect(getFileProjectId(db, wavPath)).toBe(projectId);
  });

  // ── Test 2: ALS first, WAV second ────────────────────────────────────────────
  it('2. ALS arrives first, WAV arrives later — WAV gets project_id via upsertFile ON CONFLICT', () => {
    const dir = '/Users/test/MyProject2';
    const wavPath = join(dir, 'lead.wav');
    const alsPath = join(dir, 'MyProject2.als');
    const projectId = uuid();

    // ALS arrives first
    upsertProject(db, { id: projectId, project_name: 'MyProject2', file_path: alsPath });

    // scanDependencies finds WAV and calls upsertFile with the project
    upsertFile(db, { id: uuid(), project_id: projectId, file_path: wavPath, file_name: 'lead.wav', file_type: 'wav', file_size: 8820 });
    expect(getFileProjectId(db, wavPath)).toBe(projectId);
  });

  // ── Test 3: Two projects in sibling folders — no cross-contamination ──────────
  it('3. Sibling project folders — files stay in their own project', () => {
    const dirA = '/Users/test/ProjectA';
    const dirB = '/Users/test/ProjectB';
    const wavA = join(dirA, 'bassline.wav');
    const wavB = join(dirB, 'synth.wav');
    const alsA = join(dirA, 'ProjectA.als');
    const alsB = join(dirB, 'ProjectB.als');
    const pidA = uuid();
    const pidB = uuid();

    // Both WAVs arrive as standalone first
    upsertStandaloneFile(db, { id: uuid(), file_path: wavA, file_name: 'bassline.wav', file_type: 'wav', file_size: 100 });
    upsertStandaloneFile(db, { id: uuid(), file_path: wavB, file_name: 'synth.wav', file_type: 'wav', file_size: 200 });

    // Both projects detected
    upsertProject(db, { id: pidA, project_name: 'ProjectA', file_path: alsA });
    upsertProject(db, { id: pidB, project_name: 'ProjectB', file_path: alsB });

    // Associate each project's directory
    associateUnclaimedFilesInDirectory(db, pidA, dirA);
    associateUnclaimedFilesInDirectory(db, pidB, dirB);

    expect(getFileProjectId(db, wavA)).toBe(pidA);
    expect(getFileProjectId(db, wavB)).toBe(pidB);
  });

  // ── Test 4: Identical filenames in different project folders ──────────────────
  it('4. Files with identical names in different folders stay in their own projects', () => {
    const dirA = '/Users/test/BeatA';
    const dirB = '/Users/test/BeatB';
    const wavA = join(dirA, 'drums.wav');
    const wavB = join(dirB, 'drums.wav'); // same basename, different dir
    const pidA = uuid();
    const pidB = uuid();

    upsertStandaloneFile(db, { id: uuid(), file_path: wavA, file_name: 'drums.wav', file_type: 'wav', file_size: 512 });
    upsertStandaloneFile(db, { id: uuid(), file_path: wavB, file_name: 'drums.wav', file_type: 'wav', file_size: 512 });

    upsertProject(db, { id: pidA, project_name: 'BeatA', file_path: join(dirA, 'BeatA.als') });
    upsertProject(db, { id: pidB, project_name: 'BeatB', file_path: join(dirB, 'BeatB.als') });

    associateUnclaimedFilesInDirectory(db, pidA, dirA);
    associateUnclaimedFilesInDirectory(db, pidB, dirB);

    expect(getFileProjectId(db, wavA)).toBe(pidA);
    expect(getFileProjectId(db, wavB)).toBe(pidB);
  });

  // ── Test 5: Repeated rescans are idempotent ───────────────────────────────────
  it('5. Repeated associateUnclaimedFiles calls are idempotent', () => {
    const dir = '/Users/test/IdempotentProject';
    const wavPath = join(dir, 'melody.wav');
    const alsPath = join(dir, 'IdempotentProject.als');
    const projectId = uuid();

    upsertStandaloneFile(db, { id: uuid(), file_path: wavPath, file_name: 'melody.wav', file_type: 'wav', file_size: 1024 });
    upsertProject(db, { id: projectId, project_name: 'IdempotentProject', file_path: alsPath });

    const first = associateUnclaimedFilesInDirectory(db, projectId, dir);
    expect(first).toBe(1);

    // Second and third calls must not re-associate (file already has project_id)
    const second = associateUnclaimedFilesInDirectory(db, projectId, dir);
    const third = associateUnclaimedFilesInDirectory(db, projectId, dir);
    expect(second).toBe(0);
    expect(third).toBe(0);

    // upsertFile called again with same project also stays idempotent
    upsertFile(db, { id: uuid(), project_id: projectId, file_path: wavPath, file_name: 'melody.wav', file_type: 'wav', file_size: 1024 });
    expect(getFileProjectId(db, wavPath)).toBe(projectId);
  });

  // ── Test 6: Renamed audio file — project_id is preserved ─────────────────────
  it('6. Renamed file: new path gets project_id via upsertFile, old row stays as-is', () => {
    const dir = '/Users/test/RenameProject';
    const oldPath = join(dir, 'original.wav');
    const newPath = join(dir, 'renamed.wav');
    const projectId = uuid();

    upsertProject(db, { id: projectId, project_name: 'RenameProject', file_path: join(dir, 'RenameProject.als') });

    // File indexed under original name
    upsertFile(db, { id: uuid(), project_id: projectId, file_path: oldPath, file_name: 'original.wav', file_type: 'wav', file_size: 200 });
    expect(getFileProjectId(db, oldPath)).toBe(projectId);

    // File renamed — watcher fires add for new path via upsertFile
    upsertFile(db, { id: uuid(), project_id: projectId, file_path: newPath, file_name: 'renamed.wav', file_type: 'wav', file_size: 200 });
    expect(getFileProjectId(db, newPath)).toBe(projectId);

    // Old row still exists (reconcile would update it in production, but here both coexist)
    expect(getFileProjectId(db, oldPath)).toBe(projectId);
  });

  // ── Test 7: File already associated with another project is not stolen ─────────
  it('7. File already claimed by another project is not stolen', () => {
    const dirA = '/Users/test/OwnerProject';
    const dirB = '/Users/test/ThiefProject';
    const sharedFile = join(dirA, 'shared.wav'); // belongs to A
    const pidA = uuid();
    const pidB = uuid();

    upsertProject(db, { id: pidA, project_name: 'OwnerProject', file_path: join(dirA, 'OwnerProject.als') });
    upsertProject(db, { id: pidB, project_name: 'ThiefProject', file_path: join(dirB, 'ThiefProject.als') });

    // WAV is legitimately associated with project A
    upsertFile(db, { id: uuid(), project_id: pidA, file_path: sharedFile, file_name: 'shared.wav', file_type: 'wav', file_size: 300 });
    expect(getFileProjectId(db, sharedFile)).toBe(pidA);

    // Project B tries to steal via upsertFile — COALESCE must keep pidA
    upsertFile(db, { id: uuid(), project_id: pidB, file_path: sharedFile, file_name: 'shared.wav', file_type: 'wav', file_size: 300 });
    expect(getFileProjectId(db, sharedFile)).toBe(pidA); // unchanged

    // associateUnclaimedFiles also must not steal (only updates WHERE project_id IS NULL)
    associateUnclaimedFilesInDirectory(db, pidB, dirA);
    expect(getFileProjectId(db, sharedFile)).toBe(pidA); // still unchanged
  });

  // ── Bonus: findProjectForDirectory ───────────────────────────────────────────
  it('findProjectForDirectory returns project in exact directory, not parent', () => {
    const dir = '/Users/test/FindMe';
    const alsPath = join(dir, 'FindMe.als');
    const pid = uuid();

    upsertProject(db, { id: pid, project_name: 'FindMe', file_path: alsPath });

    const found = findProjectForDirectory(db, dir);
    expect(found?.id).toBe(pid);

    // Parent directory must NOT match
    const notFound = findProjectForDirectory(db, dirname(dir));
    expect(notFound).toBeUndefined();
  });
});
