/**
 * Core desktop workflow, walked end to end against a FRESH production schema.
 *
 * Every other suite tests one link in the chain. Nothing walked the whole
 * thing, which is how a fresh-install defect survived: `links.account_id` was
 * ALTERed into existence 59 lines before the table was created, so on a brand
 * new database Project Link creation threw "table links has no column named
 * account_id" — while a suite written specifically for that migration stayed
 * green, because it replayed CREATE-then-ALTER (the intended order) rather
 * than the order db.ts shipped.
 *
 * This suite therefore does two things deliberately:
 *   1. Builds the schema from db.ts's OWN SQL, in db.ts's OWN source order —
 *      never a hand-copy and never a re-ordered convenience.
 *   2. Walks discovery → project → files → sync → version → link → revoke in
 *      one continuous database, so a break anywhere in the chain fails here.
 *
 * Scope note: this is the local/storage half of the workflow. Upload, download
 * and restore-from-archive cross the network and live in the Electron main
 * process, so they are covered by their own suites (upload.test.ts,
 * restore.security.test.ts). Nothing here mutates the user's filesystem beyond
 * an os.tmpdir() sandbox.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from './test-helpers/native-sqlite';

const maybeDescribe = nativeSqliteAvailable ? describe : describe.skip;

const dbSrc = readFileSync(join(__dirname, 'db.ts'), 'utf8');

function extractSql(marker: string): string {
  const idx = dbSrc.indexOf(marker);
  if (idx < 0) throw new Error(`marker not found in db.ts: ${marker}`);
  const start = dbSrc.lastIndexOf('`', idx);
  const end = dbSrc.indexOf('`', idx + marker.length);
  if (start < 0 || end < 0) throw new Error(`could not bound SQL for: ${marker}`);
  return dbSrc.slice(start + 1, end);
}

/**
 * Declarative schema steps, ordered by where they appear in db.ts.
 *
 * Taking the order from source positions is the point: an ALTER that drifts
 * above its CREATE reproduces the fresh-install bug here instead of shipping.
 */
function schemaSteps(): Array<{ sql: string; tolerant: boolean }> {
  const steps: Array<{ at: number; sql: string; tolerant: boolean }> = [];
  for (const marker of [
    'CREATE TABLE IF NOT EXISTS projects',
    'CREATE TABLE IF NOT EXISTS bounce_candidates',
    'CREATE TABLE IF NOT EXISTS links',
  ]) {
    steps.push({ at: dbSrc.indexOf(marker), sql: extractSql(marker), tolerant: false });
  }
  for (const m of dbSrc.matchAll(/db\.exec\('((?:ALTER TABLE|CREATE UNIQUE INDEX)[^']*)'\)/g)) {
    steps.push({ at: m.index!, sql: m[1], tolerant: true });
  }
  for (const m of dbSrc.matchAll(/db\.exec\("((?:ALTER TABLE|CREATE UNIQUE INDEX)[^"]*)"\)/g)) {
    steps.push({ at: m.index!, sql: m[1], tolerant: true });
  }
  return steps.sort((a, b) => a.at - b.at).map(({ sql, tolerant }) => ({ sql, tolerant }));
}

function freshDb(Database: any) {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const { sql, tolerant } of schemaSteps()) {
    if (tolerant) { try { db.exec(sql); } catch { /* db.ts semantics */ } }
    else db.exec(sql);
  }
  return db;
}

maybeDescribe('core desktop workflow — fresh install, one continuous database', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require(NATIVE_SQLITE_PATH);
  let db: any;
  const ACCOUNT = 'did:privy:owner001';
  const OTHER = 'did:privy:other002';
  const now = '2026-09-30T12:00:00.000Z';

  beforeEach(() => { db = freshDb(Database); });
  afterEach(() => db?.close());

  it('walks discovery → project → files → sync → version → link → revoke', () => {
    // ── 1. Discovery result becomes a project ───────────────────────────────
    db.prepare(`INSERT INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
      VALUES (@id, @name, @path, @daw, @t, @t)`)
      .run({ id: 'p1', name: 'Feel Me', path: '/Music/Feel Me/Feel Me.als', daw: 'ableton', t: now });

    // ── 2. Auto-organisation attaches the project file and its samples ──────
    const addFile = db.prepare(`INSERT INTO files
      (id, project_id, file_path, file_name, file_type, file_size, role, created_at, modified_at)
      VALUES (@id, @pid, @path, @name, @type, @size, @role, @t, @t)`);
    addFile.run({ id: 'f1', pid: 'p1', path: '/Music/Feel Me/Feel Me.als', name: 'Feel Me.als', type: 'als', size: 334317, role: 'project', t: now });
    addFile.run({ id: 'f2', pid: 'p1', path: '/Music/Feel Me/Samples/kick.wav', name: 'kick.wav', type: 'wav', size: 2048, role: 'audio', t: now });
    expect(db.prepare('SELECT COUNT(*) c FROM files WHERE project_id = ?').get('p1').c).toBe(2);

    // ── 3. Sync queue, including a resumable-upload resume ──────────────────
    db.prepare(`INSERT INTO sync_queue (id, project_id, file_id, file_name, type, status, created_at)
      VALUES ('q1','p1','f1','Feel Me.als','project_upload','pending',@t)`).run({ t: now });
    // interrupted part-way, then resumed from the recorded offset
    db.prepare("UPDATE sync_queue SET upload_offset = ?, upload_url = ?, status = 'retrying' WHERE id = 'q1'")
      .run(131072, 'https://upload.example/s/abc');
    const resumed = db.prepare("SELECT upload_offset, upload_url, status FROM sync_queue WHERE id='q1'").get();
    expect(resumed).toEqual({ upload_offset: 131072, upload_url: 'https://upload.example/s/abc', status: 'retrying' });

    db.prepare("UPDATE sync_queue SET status='completed', completed_at=? WHERE id='q1'").run(now);
    db.prepare("UPDATE files SET sync_status='synced', cloud_asset_id='asset_1' WHERE id='f1'").run();
    db.prepare("UPDATE projects SET sync_status='synced', cloud_id='cloud_p1', last_synced_at=? WHERE id='p1'").run(now);

    // ── 4. Publish an immutable version ─────────────────────────────────────
    db.prepare(`INSERT INTO versions (id, project_id, file_path, file_size, checksum, created_at)
      VALUES ('v1','p1','/Music/Feel Me/Feel Me.als',334317,@sum,@t)`)
      .run({ sum: 'a'.repeat(64), t: now });
    db.prepare("UPDATE projects SET cloud_version_id='cv1', version_count=1 WHERE id='p1'").run();

    // The unique index must stop the same checksum being versioned twice.
    expect(() => db.prepare(`INSERT INTO versions (id, project_id, file_path, checksum, created_at)
      VALUES ('v2','p1','/Music/Feel Me/Feel Me.als',@sum,@t)`).run({ sum: 'a'.repeat(64), t: now }))
      .toThrow(/UNIQUE/i);

    // ── 5. Create a Project Link — the step that was broken on fresh installs ─
    const insertLink = extractSql('INSERT INTO links (tracking_id');
    expect(() => db.prepare(insertLink).run({
      tracking_id: 'trk1', kind: 'project', project_id: 'p1', asset_id: 'asset_1',
      version_id: 'cv1', url: 'https://wavi.stream/pl/trk1', label: 'v1 for Sam',
      allow_download: 1, collaborator_mode: 'contribute', expires_at: null,
      created_at: now, account_id: ACCOUNT,
    })).not.toThrow();

    // ── 6. Links are scoped to the owning account ───────────────────────────
    const mine = db.prepare('SELECT tracking_id FROM links WHERE account_id = ?').all(ACCOUNT);
    expect(mine.map((r: any) => r.tracking_id)).toEqual(['trk1']);
    expect(db.prepare('SELECT tracking_id FROM links WHERE account_id = ?').all(OTHER)).toEqual([]);

    // ── 7. Revoke is account-scoped and idempotent ──────────────────────────
    const revoke = db.prepare('UPDATE links SET revoked_at = ? WHERE tracking_id = ? AND account_id = ? AND revoked_at IS NULL');
    expect(revoke.run(now, 'trk1', OTHER).changes).toBe(0);   // not yours
    expect(revoke.run(now, 'trk1', ACCOUNT).changes).toBe(1); // yours
    expect(revoke.run(now, 'trk1', ACCOUNT).changes).toBe(0); // already revoked
  });

  it('a fresh database can create a Project Link at all', () => {
    // The narrowest statement of the shipped bug, kept separate so a
    // regression is unmistakable rather than buried in the long walk above.
    const cols = db.prepare('PRAGMA table_info(links)').all().map((c: any) => c.name);
    expect(cols).toContain('account_id');
  });

  it('cascades file rows when a project is deleted', () => {
    db.prepare(`INSERT INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
      VALUES ('p2','Gone','/Music/Gone/Gone.als','ableton',@t,@t)`).run({ t: now });
    db.prepare(`INSERT INTO files (id, project_id, file_path, file_name, file_type, created_at, modified_at)
      VALUES ('f9','p2','/Music/Gone/Gone.als','Gone.als','als',@t,@t)`).run({ t: now });
    db.prepare("DELETE FROM projects WHERE id='p2'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM files WHERE project_id='p2'").get().c).toBe(0);
  });

  it('keeps a standalone file with no project (project_id is nullable on files)', () => {
    expect(() => db.prepare(`INSERT INTO files (id, file_path, file_name, file_type, created_at, modified_at)
      VALUES ('f10','/Music/loose.wav','loose.wav','wav',@t,@t)`).run({ t: now })).not.toThrow();
    expect(db.prepare("SELECT project_id FROM files WHERE id='f10'").get().project_id).toBeNull();
  });
});
