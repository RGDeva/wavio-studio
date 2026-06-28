import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';
import crypto from 'crypto';

let db: Database.Database;

export function getDb(): Database.Database {
  return db;
}

/** Testing entry point — takes an explicit path (use ':memory:' in tests). */
export function initDatabaseForTesting(dbPath: string): Database.Database {
  return _initDatabaseAtPath(dbPath);
}

export function initDatabase(opts: { dbName?: string } = {}): Database.Database {
  const userDataPath = app.getPath('userData');
  const dbName = opts.dbName ?? 'wavio-studio.db';
  const dbPath = path.join(userDataPath, dbName);
  return _initDatabaseAtPath(dbPath);
}

function _initDatabaseAtPath(dbPath: string): Database.Database {
  const instance = new Database(dbPath);
  db = instance;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Schema migrations — safe to run on existing DBs (better-sqlite3 is sync)
  try { db.exec('ALTER TABLE sync_queue ADD COLUMN file_name TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN bpm INTEGER'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN key_note TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN duration REAL'); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE files ADD COLUMN role TEXT DEFAULT 'unknown'"); } catch { /* column already exists */ }
  // Version enhancements
  try { db.exec("ALTER TABLE versions ADD COLUMN label TEXT DEFAULT 'version'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE versions ADD COLUMN version_type TEXT DEFAULT 'project'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE versions ADD COLUMN confirmed INTEGER DEFAULT 1"); } catch { /* already exists */ }
  // Bounce candidates — files awaiting user confirmation
  try { db.exec(`CREATE TABLE IF NOT EXISTS bounce_candidates (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    checksum TEXT,
    role TEXT DEFAULT 'unknown',
    detected_at TEXT NOT NULL,
    status TEXT DEFAULT 'pending'
  )`); } catch { /* already exists */ }
  // Migrations for bounce_candidates
  try { db.exec('ALTER TABLE bounce_candidates ADD COLUMN checksum TEXT'); } catch { /* already exists */ }
  // Retry time gate: prevents immediate re-processing of 'retrying' rows after restart
  try { db.exec('ALTER TABLE sync_queue ADD COLUMN next_retry_at TEXT'); } catch { /* already exists */ }
  // Store cloud asset ID returned by register-asset so share link creation can use it
  try { db.exec('ALTER TABLE files ADD COLUMN cloud_asset_id TEXT'); } catch { /* already exists */ }
  // Store cloud project_version ID returned by daw-sync so share links can reference versions
  try { db.exec('ALTER TABLE projects ADD COLUMN cloud_version_id TEXT'); } catch { /* already exists */ }
  // Backward-compat: null out any 16-char truncated SHA-256 hashes written by the old fileChecksum()
  // so they are treated as unknown and rehashed on next access rather than silently mismatching
  try {
    db.exec(`
      UPDATE files    SET checksum = NULL WHERE checksum IS NOT NULL AND length(checksum) = 16 AND checksum GLOB '[0-9a-f]*';
      UPDATE versions SET checksum = NULL WHERE checksum IS NOT NULL AND length(checksum) = 16 AND checksum GLOB '[0-9a-f]*';
      UPDATE bounce_candidates SET checksum = NULL WHERE checksum IS NOT NULL AND length(checksum) = 16 AND checksum GLOB '[0-9a-f]*';
    `);
  } catch { /* tables may not exist in edge-case fresh DBs */ }
  // Unique constraint on file_path so the same file can't produce duplicate candidates
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bounce_candidates_path ON bounce_candidates(file_path)'); } catch { /* already exists */ }
  // Unique constraint on versions to prevent same checksum being stored twice per project
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_project_checksum ON versions(project_id, checksum) WHERE checksum IS NOT NULL'); } catch { /* already exists */ }

  // Allow standalone files (no project) — SQLite doesn't support ALTER COLUMN so we
  // must recreate the table to drop the NOT NULL on project_id.
  // Check if project_id still has a NOT NULL constraint by inspecting table_info.
  const filesCols = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string; notnull: number }>;
  const projectIdCol = filesCols.find(c => c.name === 'project_id');
  if (projectIdCol && projectIdCol.notnull === 1) {
    // Rebuild files table without NOT NULL on project_id
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS files_new (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        sync_status TEXT DEFAULT 'pending',
        cloud_url TEXT,
        checksum TEXT,
        bpm INTEGER,
        key_note TEXT,
        duration REAL,
        role TEXT DEFAULT 'unknown',
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );
      INSERT INTO files_new SELECT id, project_id, file_path, file_name, file_type, file_size,
        sync_status, cloud_url, checksum, bpm, key_note, duration, role, created_at, modified_at
        FROM files;
      DROP TABLE files;
      ALTER TABLE files_new RENAME TO files;
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_files_path ON files(file_path)'); } catch { /* already exists */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_files_modified ON files(modified_at DESC)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_files_sync ON files(sync_status)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC)'); } catch {}

  // ── Phase 1: Project Association Engine columns ──────────────────────────
  try { db.exec("ALTER TABLE files ADD COLUMN classifier_role TEXT DEFAULT 'misc'"); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN classifier_confidence REAL DEFAULT 0.0'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN name_tokens TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN audio_fingerprint TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE files ADD COLUMN classification_version INTEGER DEFAULT 0'); } catch { /* already exists */ }

  // ── Phase 1: Association tables ─────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_associations (
      id              TEXT PRIMARY KEY,
      source_file_id  TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      target_file_id  TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      relationship    TEXT NOT NULL
                        CHECK(relationship IN (
                          'same_project','stem_of','version_of',
                          'exported_from','duplicate_of','reference_for'
                        )),
      confidence      REAL NOT NULL DEFAULT 0.0,
      confirmed_by    TEXT CHECK(confirmed_by IN ('auto','user','undo')),
      confirmed_at    INTEGER,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS association_queue (
      id                    TEXT PRIMARY KEY,
      file_ids              TEXT NOT NULL,
      suggested_project_id  TEXT,
      relationship          TEXT NOT NULL,
      confidence            REAL NOT NULL DEFAULT 0.0,
      signals               TEXT NOT NULL DEFAULT '{}',
      status                TEXT NOT NULL DEFAULT 'pending'
                              CHECK(status IN ('pending','confirmed','rejected','deferred')),
      shown_at              INTEGER,
      resolved_at           INTEGER,
      created_at            INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  try { db.exec('CREATE INDEX IF NOT EXISTS idx_asset_assoc_source ON asset_associations(source_file_id)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_asset_assoc_target ON asset_associations(target_file_id)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_assoc_queue_status ON association_queue(status)'); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      daw_type TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      version_count INTEGER DEFAULT 1,
      sync_status TEXT DEFAULT 'pending',
      cloud_id TEXT,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
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
      project_id TEXT NOT NULL,
      file_id TEXT,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 5,
      retries INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      error_message TEXT,
      upload_offset INTEGER DEFAULT 0,
      upload_url TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      project_id TEXT,
      file_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      checksum TEXT,
      cloud_url TEXT,
      created_at TEXT NOT NULL
    );
  `);

  db = instance;
  return instance;
}

// ── Projects ──────────────────────────────────────────────────────────────────

export function upsertProject(project: {
  id: string;
  project_name: string;
  file_path: string;
  daw_type: string;
  file_size: number;
  created_at: string;
  modified_at: string;
}) {
  const stmt = db.prepare(`
    INSERT INTO projects (id, project_name, file_path, daw_type, file_size, created_at, modified_at)
    VALUES (@id, @project_name, @file_path, @daw_type, @file_size, @created_at, @modified_at)
    ON CONFLICT(file_path) DO UPDATE SET
      project_name = excluded.project_name,
      file_size = excluded.file_size,
      modified_at = excluded.modified_at,
      sync_status = 'pending'
  `);
  stmt.run(project);
}

export function getProjects() {
  return db.prepare('SELECT * FROM projects ORDER BY modified_at DESC').all();
}

export function getProjectById(id: string) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function updateProjectSyncStatus(
  id: string,
  status: string,
  cloudId?: string,
  cloudVersionId?: string
) {
  db.prepare(`
    UPDATE projects SET sync_status = ?, cloud_id = ?, cloud_version_id = ?, last_synced_at = ? WHERE id = ?
  `).run(status, cloudId ?? null, cloudVersionId ?? null, new Date().toISOString(), id);
}

// ── Files ─────────────────────────────────────────────────────────────────────

export function upsertStandaloneFile(file: {
  id: string;
  file_path: string;
  file_name: string;
  file_type: string;
  file_size: number;
  checksum?: string;
  bpm?: number | null;
  key_note?: string | null;
  duration?: number | null;
  role?: string | null;
  created_at: string;
  modified_at: string;
}) {
  // Check if this exact path already exists
  const existing = db.prepare('SELECT id FROM files WHERE file_path = ?').get(file.file_path) as { id: string } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE files SET
        file_size = ?, checksum = ?,
        bpm = COALESCE(?, bpm), key_note = COALESCE(?, key_note),
        duration = COALESCE(?, duration), role = COALESCE(?, role),
        modified_at = ?, sync_status = 'pending'
      WHERE id = ?
    `).run(
      file.file_size, file.checksum ?? null,
      file.bpm ?? null, file.key_note ?? null,
      file.duration ?? null, file.role ?? 'unknown',
      file.modified_at, existing.id
    );
    return existing.id;
  }
  db.prepare(`
    INSERT INTO files (id, project_id, file_path, file_name, file_type, file_size, checksum, bpm, key_note, duration, role, created_at, modified_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    file.id, file.file_path, file.file_name, file.file_type, file.file_size,
    file.checksum ?? null, file.bpm ?? null, file.key_note ?? null,
    file.duration ?? null, file.role ?? 'unknown',
    file.created_at, file.modified_at
  );
  return file.id;
}

export function upsertFile(file: {
  id: string;
  project_id: string;
  file_path: string;
  file_name: string;
  file_type: string;
  file_size: number;
  checksum?: string;
  bpm?: number | null;
  key_note?: string | null;
  duration?: number | null;
  role?: string | null;
  created_at: string;
  modified_at: string;
}) {
  db.prepare(`
    INSERT INTO files (id, project_id, file_path, file_name, file_type, file_size, checksum, bpm, key_note, duration, role, created_at, modified_at)
    VALUES (@id, @project_id, @file_path, @file_name, @file_type, @file_size, @checksum, @bpm, @key_note, @duration, @role, @created_at, @modified_at)
    ON CONFLICT(file_path) DO UPDATE SET
      file_size = excluded.file_size,
      checksum = excluded.checksum,
      bpm = COALESCE(excluded.bpm, files.bpm),
      key_note = COALESCE(excluded.key_note, files.key_note),
      duration = COALESCE(excluded.duration, files.duration),
      role = COALESCE(excluded.role, files.role),
      modified_at = excluded.modified_at,
      sync_status = 'pending'
  `).run({ bpm: null, key_note: null, duration: null, role: 'unknown', ...file });
}

export function getFilesByProject(projectId: string) {
  return db.prepare('SELECT * FROM files WHERE project_id = ? ORDER BY file_type, file_name').all(projectId);
}

export function getFileById(id: string) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
}

export function getAllFiles(limit = 500, offset = 0) {
  return db.prepare(`
    SELECT f.*, p.project_name, p.daw_type
    FROM files f
    LEFT JOIN projects p ON f.project_id = p.id
    ORDER BY f.modified_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

export function searchFiles(query: string, limit = 100) {
  const like = `%${query}%`;
  return db.prepare(`
    SELECT f.*, p.project_name, p.daw_type
    FROM files f
    LEFT JOIN projects p ON f.project_id = p.id
    WHERE f.file_name LIKE ? OR f.role LIKE ? OR p.project_name LIKE ?
    ORDER BY f.modified_at DESC
    LIMIT ?
  `).all(like, like, like, limit);
}

export function getFileStats() {
  const total = db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
  const byType = db.prepare('SELECT file_type, COUNT(*) as count FROM files GROUP BY file_type ORDER BY count DESC').all();
  const byRole = db.prepare('SELECT role, COUNT(*) as count FROM files GROUP BY role ORDER BY count DESC').all();
  const totalSize = db.prepare('SELECT SUM(file_size) as total FROM files').get() as { total: number };
  const synced = db.prepare("SELECT COUNT(*) as count FROM files WHERE sync_status = 'synced'").get() as { count: number };
  return {
    totalFiles: total.count,
    totalSize: totalSize.total || 0,
    syncedFiles: synced.count,
    byType,
    byRole,
  };
}

export function updateFileSyncStatus(id: string, status: string, cloudUrl?: string, cloudAssetId?: string) {
  db.prepare('UPDATE files SET sync_status = ?, cloud_url = ?, cloud_asset_id = ? WHERE id = ?')
    .run(status, cloudUrl ?? null, cloudAssetId ?? null, id);
}

// ── Sync Queue ────────────────────────────────────────────────────────────────

export function enqueueSyncItemIdempotent(item: {
  id: string;
  project_id: string;
  file_id?: string;
  file_name?: string;
  type: string;
  priority?: number;
  created_at: string;
}): { inserted: boolean; id?: string; existingId?: string } {
  const existing = db.prepare(`
    SELECT id FROM sync_queue
    WHERE type = ? AND project_id = ? AND COALESCE(file_id, '') = COALESCE(?, '')
      AND status IN ('pending', 'uploading', 'retrying')
    LIMIT 1
  `).get(item.type, item.project_id, item.file_id ?? null) as { id: string } | undefined;

  if (existing) {
    return { inserted: false, existingId: existing.id };
  }

  db.prepare(`
    INSERT OR IGNORE INTO sync_queue (id, project_id, file_id, file_name, type, priority, created_at)
    VALUES (@id, @project_id, @file_id, @file_name, @type, @priority, @created_at)
  `).run({ priority: 5, file_id: null, file_name: null, ...item });

  return { inserted: true, id: item.id };
}

export function enqueueSyncItem(item: {
  id: string;
  project_id: string;
  file_id?: string;
  file_name?: string;
  type: string;
  priority?: number;
  created_at: string;
}) {
  enqueueSyncItemIdempotent(item);
}

export function repairStalledQueue(): { recovered: number; deduped: number } {
  // 1. Reset uploading → pending (crash recovery)
  const resetResult = db.prepare(`
    UPDATE sync_queue SET status = 'pending', started_at = NULL
    WHERE status = 'uploading'
  `).run();
  const recovered = resetResult.changes;

  // 2. Collapse duplicate active rows — keep newest by created_at, delete rest
  const duplicates = db.prepare(`
    SELECT id FROM sync_queue
    WHERE status IN ('pending', 'retrying')
      AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY type, project_id, COALESCE(file_id, '')
            ORDER BY created_at DESC
          ) AS rn FROM sync_queue
          WHERE status IN ('pending', 'retrying')
        ) WHERE rn = 1
      )
  `).all() as { id: string }[];

  let deduped = 0;
  if (duplicates.length > 0) {
    const ids = duplicates.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM sync_queue WHERE id IN (${placeholders})`).run(...ids);
    deduped = ids.length;
  }

  if (recovered > 0 || deduped > 0) {
    db.prepare(`
      INSERT INTO activity_log (id, type, message, created_at)
      VALUES (?, 'queue_repair', ?, ?)
    `).run(
      crypto.randomUUID(),
      `Queue repair: recovered ${recovered} stalled, deduped ${deduped} duplicates`,
      new Date().toISOString(),
    );
  }

  return { recovered, deduped };
}

export function getPendingSyncItems(limit = 10) {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM sync_queue
    WHERE status IN ('pending', 'retrying')
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY priority DESC, created_at ASC
    LIMIT ?
  `).all(now, limit);
}

export function updateSyncItem(id: string, updates: Record<string, unknown>) {
  const keys = Object.keys(updates);
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => updates[k]);
  db.prepare(`UPDATE sync_queue SET ${setClause} WHERE id = ?`).run(...values, id);
}

export function getSyncQueue() {
  return db.prepare('SELECT * FROM sync_queue ORDER BY created_at DESC LIMIT 50').all();
}

// ── Activity ──────────────────────────────────────────────────────────────────

export function logActivity(entry: {
  id: string;
  type: string;
  message: string;
  project_id?: string;
  file_id?: string;
  metadata?: Record<string, unknown>;
}) {
  db.prepare(`
    INSERT INTO activity_log (id, type, message, project_id, file_id, metadata, created_at)
    VALUES (@id, @type, @message, @project_id, @file_id, @metadata, @created_at)
  `).run({
    project_id: null,
    file_id: null,
    created_at: new Date().toISOString(),
    ...entry,
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
  });
}

export function getActivityLog(limit = 100) {
  return db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ── Versions ──────────────────────────────────────────────────────────────────

export function createVersion(version: {
  id: string;
  project_id: string;
  file_path: string;
  file_size: number;
  checksum?: string;
  label?: string;
  version_type?: string;
  confirmed?: number;
  created_at: string;
}) {
  db.prepare(`
    INSERT INTO versions (id, project_id, file_path, file_size, checksum, label, version_type, confirmed, created_at)
    VALUES (@id, @project_id, @file_path, @file_size, @checksum, @label, @version_type, @confirmed, @created_at)
  `).run({
    label: 'version',
    version_type: 'project',
    confirmed: 1,
    ...version,
  });

  db.prepare('UPDATE projects SET version_count = version_count + 1 WHERE id = ?')
    .run(version.project_id);
}

export function getVersionsByProject(projectId: string) {
  return db.prepare(
    'SELECT * FROM versions WHERE project_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(projectId);
}

export function addBounceCandidate(candidate: {
  id: string;
  project_id: string | null;
  file_path: string;
  file_name: string;
  file_size: number;
  checksum?: string | null;
  role: string;
  detected_at: string;
}) {
  // INSERT OR IGNORE prevents duplicates via unique index on file_path.
  // If the file was previously ignored but has a new checksum, update it back to pending.
  const existing = db.prepare('SELECT id, status, checksum FROM bounce_candidates WHERE file_path = ?').get(candidate.file_path) as any;
  if (existing) {
    // Re-open ignored candidates only if the file has changed (different checksum)
    if (existing.status === 'ignored' && candidate.checksum && existing.checksum !== candidate.checksum) {
      db.prepare(`UPDATE bounce_candidates SET status = 'pending', file_size = ?, checksum = ?, detected_at = ? WHERE file_path = ?`)
        .run(candidate.file_size, candidate.checksum, candidate.detected_at, candidate.file_path);
    }
    // Otherwise do nothing — candidate already exists (pending or resolved)
    return existing.id as string;
  }
  db.prepare(`
    INSERT INTO bounce_candidates (id, project_id, file_path, file_name, file_size, checksum, role, detected_at, status)
    VALUES (@id, @project_id, @file_path, @file_name, @file_size, @checksum, @role, @detected_at, 'pending')
  `).run({ checksum: null, ...candidate });
  return candidate.id;
}

export function getBounceCandidateById(id: string) {
  return db.prepare('SELECT * FROM bounce_candidates WHERE id = ?').get(id) as any;
}

export function getBounceCandidateByPath(filePath: string) {
  return db.prepare('SELECT * FROM bounce_candidates WHERE file_path = ?').get(filePath) as any;
}

export function getPendingBounceCandidates() {
  return db.prepare(
    "SELECT * FROM bounce_candidates WHERE status = 'pending' ORDER BY detected_at DESC LIMIT 20"
  ).all();
}

export function resolveBounceCandidate(id: string, status: 'confirmed' | 'ignored' | 'stem' | 'master') {
  db.prepare("UPDATE bounce_candidates SET status = ? WHERE id = ?").run(status, id);
}

/** Returns true if a version with this checksum already exists for the project. */
export function versionExistsByChecksum(projectId: string, checksum: string): boolean {
  const row = db.prepare('SELECT id FROM versions WHERE project_id = ? AND checksum = ?').get(projectId, checksum);
  return !!row;
}

/** Returns true if a version pointing at this exact file_path already exists for the project. */
export function versionExistsByPath(projectId: string, filePath: string): boolean {
  const row = db.prepare('SELECT id FROM versions WHERE project_id = ? AND file_path = ?').get(projectId, filePath);
  return !!row;
}

// ── Phase 1: File classifier columns ─────────────────────────────────────────

const CLASSIFICATION_VERSION = 1;

export function updateFileClassification(fileId: string, opts: {
  classifier_role: string;
  classifier_confidence: number;
  name_tokens: string; // JSON
}) {
  db.prepare(`
    UPDATE files
    SET classifier_role = ?,
        classifier_confidence = ?,
        name_tokens = ?,
        classification_version = ?
    WHERE id = ?
  `).run(
    opts.classifier_role,
    opts.classifier_confidence,
    opts.name_tokens,
    CLASSIFICATION_VERSION,
    fileId,
  );
}

export function updateFileClassificationByPath(filePath: string, opts: {
  classifier_role: string;
  classifier_confidence: number;
  name_tokens: string; // JSON
}): string | null {
  const row = db.prepare('SELECT id FROM files WHERE file_path = ?').get(filePath) as { id: string } | undefined;
  if (!row) return null;
  updateFileClassification(row.id, opts);
  return row.id;
}

export function getFileIdByPath(filePath: string): string | null {
  const row = db.prepare('SELECT id FROM files WHERE file_path = ?').get(filePath) as { id: string } | undefined;
  return row?.id ?? null;
}

// ── Phase 1: asset_associations ───────────────────────────────────────────────

export type AssociationRelationship =
  | 'same_project'
  | 'stem_of'
  | 'version_of'
  | 'exported_from'
  | 'duplicate_of'
  | 'reference_for';

export function upsertAssetAssociation(assoc: {
  id: string;
  source_file_id: string;
  target_file_id: string;
  relationship: AssociationRelationship;
  confidence: number;
  confirmed_by?: 'auto' | 'user' | 'undo' | null;
}) {
  db.prepare(`
    INSERT INTO asset_associations (id, source_file_id, target_file_id, relationship, confidence, confirmed_by, confirmed_at)
    VALUES (@id, @source_file_id, @target_file_id, @relationship, @confidence, @confirmed_by, @confirmed_at)
    ON CONFLICT(id) DO UPDATE SET
      confidence    = excluded.confidence,
      confirmed_by  = excluded.confirmed_by,
      confirmed_at  = excluded.confirmed_at
  `).run({
    confirmed_by: assoc.confirmed_by ?? null,
    confirmed_at: assoc.confirmed_by ? Math.floor(Date.now() / 1000) : null,
    id:             assoc.id,
    source_file_id: assoc.source_file_id,
    target_file_id: assoc.target_file_id,
    relationship:   assoc.relationship,
    confidence:     assoc.confidence,
  });
}

export function getAssociationsForFile(fileId: string) {
  return db.prepare(`
    SELECT * FROM asset_associations
    WHERE source_file_id = ? OR target_file_id = ?
    ORDER BY confidence DESC
  `).all(fileId, fileId);
}

export function confirmAssociation(id: string, confirmedBy: 'auto' | 'user') {
  db.prepare(`
    UPDATE asset_associations
    SET confirmed_by = ?, confirmed_at = ?
    WHERE id = ?
  `).run(confirmedBy, Math.floor(Date.now() / 1000), id);
}

export function undoAssociation(id: string) {
  db.prepare(`
    UPDATE asset_associations
    SET confirmed_by = 'undo', confirmed_at = ?
    WHERE id = ?
  `).run(Math.floor(Date.now() / 1000), id);
}

// ── Phase 1: association_queue ─────────────────────────────────────────────────

export type QueueStatus = 'pending' | 'confirmed' | 'rejected' | 'deferred';

export function enqueueAssociation(item: {
  id: string;
  file_ids: string[]; // stored as JSON
  suggested_project_id?: string | null;
  relationship: AssociationRelationship;
  confidence: number;
  signals: Record<string, unknown>;
}) {
  db.prepare(`
    INSERT OR IGNORE INTO association_queue
      (id, file_ids, suggested_project_id, relationship, confidence, signals, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', unixepoch())
  `).run(
    item.id,
    JSON.stringify(item.file_ids),
    item.suggested_project_id ?? null,
    item.relationship,
    item.confidence,
    JSON.stringify(item.signals),
  );
}

export function getPendingAssociations(limit = 20) {
  const rows = db.prepare(`
    SELECT * FROM association_queue
    WHERE status = 'pending'
    ORDER BY confidence DESC, created_at ASC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    ...r,
    file_ids: JSON.parse(r.file_ids as string) as string[],
    signals:  JSON.parse(r.signals  as string) as Record<string, unknown>,
  }));
}

export function resolveAssociationQueue(id: string, status: QueueStatus) {
  db.prepare(`
    UPDATE association_queue
    SET status = ?, resolved_at = unixepoch()
    WHERE id = ?
  `).run(status, id);
}
