"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initDatabase = initDatabase;
exports.getDb = getDb;
exports.upsertProject = upsertProject;
exports.getProjects = getProjects;
exports.getProjectById = getProjectById;
exports.updateProjectSyncStatus = updateProjectSyncStatus;
exports.upsertStandaloneFile = upsertStandaloneFile;
exports.upsertFile = upsertFile;
exports.getFilesByProject = getFilesByProject;
exports.getFileById = getFileById;
exports.getAllFiles = getAllFiles;
exports.searchFiles = searchFiles;
exports.getFileStats = getFileStats;
exports.updateFileSyncStatus = updateFileSyncStatus;
exports.enqueueSyncItem = enqueueSyncItem;
exports.getPendingSyncItems = getPendingSyncItems;
exports.updateSyncItem = updateSyncItem;
exports.getSyncQueue = getSyncQueue;
exports.logActivity = logActivity;
exports.getActivityLog = getActivityLog;
exports.createVersion = createVersion;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
let db;
function initDatabase() {
    const userDataPath = electron_1.app.getPath('userData');
    const dbPath = path_1.default.join(userDataPath, 'wavio-studio.db');
    db = new better_sqlite3_1.default(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Schema migrations — safe to run on existing DBs (better-sqlite3 is sync)
    try {
        db.exec('ALTER TABLE sync_queue ADD COLUMN file_name TEXT');
    }
    catch { /* column already exists */ }
    try {
        db.exec('ALTER TABLE files ADD COLUMN bpm INTEGER');
    }
    catch { /* column already exists */ }
    try {
        db.exec('ALTER TABLE files ADD COLUMN key_note TEXT');
    }
    catch { /* column already exists */ }
    try {
        db.exec('ALTER TABLE files ADD COLUMN duration REAL');
    }
    catch { /* column already exists */ }
    try {
        db.exec('ALTER TABLE files ADD COLUMN role TEXT DEFAULT \'unknown\'');
    }
    catch { /* column already exists */ }
    // Allow standalone files (no project) — SQLite doesn't support ALTER COLUMN so we
    // must recreate the table to drop the NOT NULL on project_id.
    // Check if project_id still has a NOT NULL constraint by inspecting table_info.
    const filesCols = db.prepare("PRAGMA table_info(files)").all();
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
    try {
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_files_path ON files(file_path)');
    }
    catch { /* already exists */ }
    try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id)');
    }
    catch { }
    try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_files_modified ON files(modified_at DESC)');
    }
    catch { }
    try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_files_sync ON files(sync_status)');
    }
    catch { }
    try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status)');
    }
    catch { }
    try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC)');
    }
    catch { }
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
    return db;
}
function getDb() {
    return db;
}
// ── Projects ──────────────────────────────────────────────────────────────────
function upsertProject(project) {
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
function getProjects() {
    return db.prepare('SELECT * FROM projects ORDER BY modified_at DESC').all();
}
function getProjectById(id) {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
function updateProjectSyncStatus(id, status, cloudId) {
    db.prepare(`
    UPDATE projects SET sync_status = ?, cloud_id = ?, last_synced_at = ? WHERE id = ?
  `).run(status, cloudId ?? null, new Date().toISOString(), id);
}
// ── Files ─────────────────────────────────────────────────────────────────────
function upsertStandaloneFile(file) {
    // Check if this exact path already exists
    const existing = db.prepare('SELECT id FROM files WHERE file_path = ?').get(file.file_path);
    if (existing) {
        db.prepare(`
      UPDATE files SET
        file_size = ?, checksum = ?,
        bpm = COALESCE(?, bpm), key_note = COALESCE(?, key_note),
        duration = COALESCE(?, duration), role = COALESCE(?, role),
        modified_at = ?, sync_status = 'pending'
      WHERE id = ?
    `).run(file.file_size, file.checksum ?? null, file.bpm ?? null, file.key_note ?? null, file.duration ?? null, file.role ?? 'unknown', file.modified_at, existing.id);
        return existing.id;
    }
    db.prepare(`
    INSERT INTO files (id, project_id, file_path, file_name, file_type, file_size, checksum, bpm, key_note, duration, role, created_at, modified_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(file.id, file.file_path, file.file_name, file.file_type, file.file_size, file.checksum ?? null, file.bpm ?? null, file.key_note ?? null, file.duration ?? null, file.role ?? 'unknown', file.created_at, file.modified_at);
    return file.id;
}
function upsertFile(file) {
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
function getFilesByProject(projectId) {
    return db.prepare('SELECT * FROM files WHERE project_id = ? ORDER BY file_type, file_name').all(projectId);
}
function getFileById(id) {
    return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
}
function getAllFiles(limit = 500, offset = 0) {
    return db.prepare(`
    SELECT f.*, p.project_name, p.daw_type
    FROM files f
    LEFT JOIN projects p ON f.project_id = p.id
    ORDER BY f.modified_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}
function searchFiles(query, limit = 100) {
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
function getFileStats() {
    const total = db.prepare('SELECT COUNT(*) as count FROM files').get();
    const byType = db.prepare('SELECT file_type, COUNT(*) as count FROM files GROUP BY file_type ORDER BY count DESC').all();
    const byRole = db.prepare('SELECT role, COUNT(*) as count FROM files GROUP BY role ORDER BY count DESC').all();
    const totalSize = db.prepare('SELECT SUM(file_size) as total FROM files').get();
    const synced = db.prepare("SELECT COUNT(*) as count FROM files WHERE sync_status = 'synced'").get();
    return {
        totalFiles: total.count,
        totalSize: totalSize.total || 0,
        syncedFiles: synced.count,
        byType,
        byRole,
    };
}
function updateFileSyncStatus(id, status, cloudUrl) {
    db.prepare('UPDATE files SET sync_status = ?, cloud_url = ? WHERE id = ?')
        .run(status, cloudUrl ?? null, id);
}
// ── Sync Queue ────────────────────────────────────────────────────────────────
function enqueueSyncItem(item) {
    db.prepare(`
    INSERT OR IGNORE INTO sync_queue (id, project_id, file_id, file_name, type, priority, created_at)
    VALUES (@id, @project_id, @file_id, @file_name, @type, @priority, @created_at)
  `).run({ priority: 5, file_id: null, file_name: null, ...item });
}
function getPendingSyncItems(limit = 10) {
    return db.prepare(`
    SELECT * FROM sync_queue
    WHERE status IN ('pending', 'retrying')
    ORDER BY priority DESC, created_at ASC
    LIMIT ?
  `).all(limit);
}
function updateSyncItem(id, updates) {
    const keys = Object.keys(updates);
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => updates[k]);
    db.prepare(`UPDATE sync_queue SET ${setClause} WHERE id = ?`).run(...values, id);
}
function getSyncQueue() {
    return db.prepare('SELECT * FROM sync_queue ORDER BY created_at DESC LIMIT 50').all();
}
// ── Activity ──────────────────────────────────────────────────────────────────
function logActivity(entry) {
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
function getActivityLog(limit = 100) {
    return db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?').all(limit);
}
// ── Versions ──────────────────────────────────────────────────────────────────
function createVersion(version) {
    db.prepare(`
    INSERT INTO versions (id, project_id, file_path, file_size, checksum, created_at)
    VALUES (@id, @project_id, @file_path, @file_size, @checksum, @created_at)
  `).run(version);
    db.prepare('UPDATE projects SET version_count = version_count + 1 WHERE id = ?')
        .run(version.project_id);
}
