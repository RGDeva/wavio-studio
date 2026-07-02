/**
 * Links registry tests (Phase C) — real arm64 better-sqlite3, SQL mirrored
 * from electron/db.ts (same convention as syncScalability.test.ts: db.ts
 * itself loads the Electron-ABI binary and can't be imported under vitest).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';

const NATIVE_SQLITE_PATH = '/tmp/wavio-sqlite-test/node_modules/better-sqlite3';
const maybeDescribe = existsSync(NATIVE_SQLITE_PATH) ? describe : describe.skip;

function buildSchema(Database: any) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      share_url TEXT,
      tracking_id TEXT,
      created_at TEXT,
      modified_at TEXT
    );
    CREATE TABLE links (
      tracking_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('listen', 'project')),
      project_id TEXT,
      asset_id TEXT,
      version_id TEXT,
      url TEXT NOT NULL,
      label TEXT,
      allow_download INTEGER DEFAULT 1,
      collaborator_mode TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
  `);
  return db;
}

// Exact SQL from db.ts backfill migration.
function backfill(db: any) {
  db.exec(`
    INSERT OR IGNORE INTO links (tracking_id, kind, project_id, url, created_at)
    SELECT tracking_id, 'listen', id, share_url, COALESCE(modified_at, created_at)
    FROM projects
    WHERE tracking_id IS NOT NULL AND share_url IS NOT NULL
  `);
}

// Exact SQL from db.ts recordLink.
function recordLink(db: any, link: any) {
  db.prepare(`
    INSERT INTO links (tracking_id, kind, project_id, asset_id, version_id, url, label, allow_download, collaborator_mode, expires_at, created_at)
    VALUES (@tracking_id, @kind, @project_id, @asset_id, @version_id, @url, @label, @allow_download, @collaborator_mode, @expires_at, @created_at)
    ON CONFLICT(tracking_id) DO UPDATE SET
      url = excluded.url,
      allow_download = excluded.allow_download,
      collaborator_mode = excluded.collaborator_mode,
      expires_at = excluded.expires_at,
      revoked_at = NULL
  `).run({
    project_id: null, asset_id: null, version_id: null, label: null,
    allow_download: 1, collaborator_mode: null, expires_at: null,
    created_at: new Date().toISOString(), ...link,
  });
}

function markLinkRevoked(db: any, trackingId: string) {
  db.prepare('UPDATE links SET revoked_at = ? WHERE tracking_id = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), trackingId);
}

maybeDescribe('links registry (real arm64 sqlite)', () => {
  let Database: any;
  let db: any;

  beforeEach(async () => {
    if (!Database) Database = (await import(NATIVE_SQLITE_PATH)).default;
    db = buildSchema(Database);
  });
  afterEach(() => db.close());

  it('backfills legacy listen links from projects.share_url/tracking_id exactly once', () => {
    db.prepare("INSERT INTO projects (id, project_name, share_url, tracking_id, created_at) VALUES ('p1','Song','https://w/s/abc','abc','2026-01-01')").run();
    db.prepare("INSERT INTO projects (id, project_name, created_at) VALUES ('p2','No Link','2026-01-01')").run();
    backfill(db);
    backfill(db); // idempotent — INSERT OR IGNORE
    const rows = db.prepare('SELECT * FROM links').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tracking_id: 'abc', kind: 'listen', project_id: 'p1', url: 'https://w/s/abc' });
  });

  it('recordLink upserts on reuse and clears a stale revocation', () => {
    recordLink(db, { tracking_id: 't1', kind: 'listen', url: 'https://w/s/t1', asset_id: 'a1' });
    markLinkRevoked(db, 't1');
    // Server "reused" an equivalent active link → re-record must reactivate
    recordLink(db, { tracking_id: 't1', kind: 'listen', url: 'https://w/s/t1', asset_id: 'a1' });
    const row = db.prepare("SELECT revoked_at FROM links WHERE tracking_id='t1'").get();
    expect(row.revoked_at).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM links').get().c).toBe(1);
  });

  it('rename updates the label only', () => {
    recordLink(db, { tracking_id: 't1', kind: 'project', url: 'https://w/pl/t1', project_id: 'p1' });
    db.prepare('UPDATE links SET label = ? WHERE tracking_id = ?').run('For mixer', 't1');
    const row = db.prepare("SELECT label, url FROM links WHERE tracking_id='t1'").get();
    expect(row).toEqual({ label: 'For mixer', url: 'https://w/pl/t1' });
  });

  it('markLinkRevoked is idempotent and preserves the first revocation time', () => {
    recordLink(db, { tracking_id: 't1', kind: 'listen', url: 'u' });
    markLinkRevoked(db, 't1');
    const first = db.prepare("SELECT revoked_at FROM links WHERE tracking_id='t1'").get().revoked_at;
    markLinkRevoked(db, 't1');
    const second = db.prepare("SELECT revoked_at FROM links WHERE tracking_id='t1'").get().revoked_at;
    expect(second).toBe(first);
  });

  it('getLinks join returns project display names, newest first', () => {
    db.prepare("INSERT INTO projects (id, project_name, created_at) VALUES ('p1','Alpha','2026-01-01')").run();
    recordLink(db, { tracking_id: 'old', kind: 'listen', url: 'u1', project_id: 'p1', created_at: '2026-01-01T00:00:00Z' });
    recordLink(db, { tracking_id: 'new', kind: 'project', url: 'u2', project_id: 'p1', created_at: '2026-02-01T00:00:00Z' });
    const rows = db.prepare(`
      SELECT l.*, p.project_name FROM links l LEFT JOIN projects p ON p.id = l.project_id
      ORDER BY l.created_at DESC
    `).all();
    expect(rows.map((r: any) => r.tracking_id)).toEqual(['new', 'old']);
    expect(rows[0].project_name).toBe('Alpha');
  });

  it('rejects unknown kinds (CHECK constraint)', () => {
    expect(() => recordLink(db, { tracking_id: 'x', kind: 'weird', url: 'u' })).toThrow();
  });
});
