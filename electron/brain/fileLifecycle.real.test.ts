/**
 * discovered_at / last_seen_at against REAL SQLite.
 *
 * These columns were added in an earlier pass together with helper functions
 * to stamp them — and nothing ever called those helpers, so both columns sat
 * permanently NULL. The fix moved the behaviour into the upsert statements
 * themselves, because stamping at call sites meant six places to forget and
 * every one of them was forgotten.
 *
 * The SQL is EXTRACTED from db.ts rather than copied, so these fail if the
 * shipped statements change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from '../test-helpers/native-sqlite';

const maybeDescribe = nativeSqliteAvailable ? describe : describe.skip;
const dbSrc = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');

function extractSql(marker: string): string {
  const i = dbSrc.indexOf(marker);
  if (i < 0) throw new Error(`marker not found: ${marker}`);
  return dbSrc.slice(dbSrc.lastIndexOf('`', i) + 1, dbSrc.indexOf('`', i + marker.length));
}

/**
 * One template literal in db.ts declares projects, files, sync_queue,
 * activity_log and versions together, so both markers resolve to the SAME
 * block — executing it twice would fail with "table already exists".
 */
const BASE_DDL = extractSql('CREATE TABLE IF NOT EXISTS projects');
/**
 * The real project-scoped upsert with its ON CONFLICT clause.
 *
 * Matched on the NAMED-parameter VALUES line: upsertFile and
 * upsertStandaloneFile now share a column list, so the column names alone
 * would ambiguously match the positional one.
 */
const UPSERT_FILE = extractSql('VALUES (@id, @project_id, @file_path');
const RECONCILE_MOVED = extractSql('local_status=\'present\', reconciled_from=file_path');

/**
 * Index statements, in db.ts source order.
 *
 * Required, not optional: the upsert uses ON CONFLICT(file_path), which needs
 * the UNIQUE index that a later migration adds — the base CREATE does not
 * declare it. Omitting them makes the real statement unpreparable.
 */
const MIGRATIONS = [
  ...[...dbSrc.matchAll(/db\.exec\('((?:CREATE (?:UNIQUE )?INDEX|ALTER TABLE)[^']*)'\)/g)].map((m) => ({ at: m.index!, sql: m[1] })),
  ...[...dbSrc.matchAll(/db\.exec\("((?:ALTER TABLE)[^"]*)"\)/g)].map((m) => ({ at: m.index!, sql: m[1] })),
].sort((a, b) => a.at - b.at).map((m) => m.sql);

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-05T18:00:00.000Z';

maybeDescribe('file lifecycle timestamps (real SQLite, real shipped SQL)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require(NATIVE_SQLITE_PATH);
  let db: any;

  const upsert = (over: Record<string, unknown> = {}) => db.prepare(UPSERT_FILE).run({
    id: 'f1', project_id: 'p1', file_path: '/m/Sunshine/vocal.wav', file_name: 'vocal.wav',
    file_type: 'wav', file_size: 100, checksum: null, bpm: null, key_note: null,
    duration: null, role: 'audio', created_at: T1, modified_at: T1, ...over,
  });
  const row = (path = '/m/Sunshine/vocal.wav') =>
    db.prepare('SELECT * FROM files WHERE file_path = ?').get(path);

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(BASE_DDL);
    // db.ts wraps each of these in try/catch ("column already exists"); mirror
    // that tolerance rather than assuming which ones apply to this subset.
    for (const sql of MIGRATIONS) { try { db.exec(sql); } catch { /* db.ts semantics */ } }
    db.prepare(`INSERT INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
      VALUES ('p1','Sunshine','/m/Sunshine/Sunshine.flp','fl-studio',?,?)`).run(T1, T1);
  });
  afterEach(() => db?.close());

  it('first discovery sets BOTH timestamps — they are no longer NULL', () => {
    upsert();
    expect(row().discovered_at).toBe(T1);
    expect(row().last_seen_at).toBe(T1);
  });

  it('a later observation advances last_seen_at but NEVER discovered_at', () => {
    upsert();
    upsert({ modified_at: T2, file_size: 200 });
    expect(row().discovered_at).toBe(T1);   // preserved
    expect(row().last_seen_at).toBe(T2);    // advanced
  });

  it('a rescan does not make a long-known file look newly found', () => {
    // The whole point of COALESCE on discovered_at: re-running the same
    // upsert during a rescan must not rewrite history.
    upsert();
    for (let i = 0; i < 5; i++) upsert({ modified_at: T2 });
    expect(row().discovered_at).toBe(T1);
  });

  it('a move keeps the SAME row, so discovered_at survives the rename', () => {
    // Move reconciliation updates in place by id — it must not mint a new
    // file identity, which would lose the file's history.
    upsert();
    const originalId = row().id;

    db.prepare(RECONCILE_MOVED).run('/m/Sunshine/vocal-final.wav', 'vocal-final.wav', 150, T2, T2, originalId);

    const moved = row('/m/Sunshine/vocal-final.wav');
    expect(moved.id).toBe(originalId);           // same identity
    expect(moved.discovered_at).toBe(T1);        // history intact
    expect(moved.last_seen_at).toBe(T2);         // observed at the new path
    expect(moved.reconciled_from).toBe('/m/Sunshine/vocal.wav');
    expect(db.prepare('SELECT COUNT(*) c FROM files').get().c).toBe(1);  // no duplicate
  });

  it('a missing file keeps its historical identity rather than being erased', () => {
    upsert();
    db.prepare("UPDATE files SET local_status='missing' WHERE file_path=?").run('/m/Sunshine/vocal.wav');
    const r = row();
    expect(r.local_status).toBe('missing');
    expect(r.discovered_at).toBe(T1);     // still knows when it was first seen
    expect(r.last_seen_at).toBe(T1);      // and when it was last actually there
  });

  it('a reappearance converges without rewriting when it was discovered', () => {
    upsert();
    db.prepare("UPDATE files SET local_status='missing' WHERE file_path=?").run('/m/Sunshine/vocal.wav');
    // markFilePresent's shipped behaviour: advance last_seen_at, keep discovered_at.
    db.prepare("UPDATE files SET local_status='present', last_seen_at=COALESCE(?, last_seen_at) WHERE file_path=?")
      .run(T2, '/m/Sunshine/vocal.wav');
    const r = row();
    expect(r.local_status).toBe('present');
    expect(r.discovered_at).toBe(T1);
    expect(r.last_seen_at).toBe(T2);
  });

  it('answers "indexed since" and "missing since", which the file’s own timestamps cannot', () => {
    // created_at/modified_at belong to the FILE; these belong to Wavi's
    // knowledge of it, which is why both are needed.
    upsert({ created_at: '2020-01-01T00:00:00.000Z', modified_at: T1 });
    const r = row();
    expect(r.created_at).toBe('2020-01-01T00:00:00.000Z'); // file is old
    expect(r.discovered_at).toBe(T1);                      // Wavi only just met it
  });
});
