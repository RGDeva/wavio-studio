/**
 * REAL SQLite migration verification for the P3-2c `links.account_id` change.
 *
 * db.ts itself binds the Electron-ABI better-sqlite3 and cannot be imported
 * under vitest — but its SQL can. This suite EXTRACTS the actual SQL text from
 * electron/db.ts (CREATE TABLE links, the account_id ALTER, and the scoped
 * query/update statements) and executes those exact strings against a real
 * better-sqlite3 database (repo Node-ABI fixture). Unlike a mirrored copy,
 * this fails if db.ts's shipped SQL changes — it is drift-proof.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from './test-helpers/native-sqlite';

const maybeDescribe = nativeSqliteAvailable ? describe : describe.skip;

const dbSrc = readFileSync(join(__dirname, 'db.ts'), 'utf8');

/** Extract the backtick SQL template that contains `marker`. */
function extractSql(marker: string): string {
  const idx = dbSrc.indexOf(marker);
  if (idx < 0) throw new Error(`marker not found in db.ts: ${marker}`);
  const start = dbSrc.lastIndexOf('`', idx);
  const end = dbSrc.indexOf('`', idx + marker.length);
  if (start < 0 || end < 0) throw new Error(`could not bound SQL for: ${marker}`);
  return dbSrc.slice(start + 1, end);
}

/** Extract a single-quoted SQL statement containing `marker`. */
function extractQuotedSql(marker: string): string {
  const m = dbSrc.match(new RegExp(`'([^']*${marker}[^']*)'`));
  if (!m) throw new Error(`quoted SQL not found: ${marker}`);
  return m[1];
}

const CREATE_LINKS_SQL = extractSql('CREATE TABLE IF NOT EXISTS links');
const ALTER_ACCOUNT_SQL = extractQuotedSql('ALTER TABLE links ADD COLUMN account_id');
const SCOPED_SELECT_SQL = extractSql('WHERE l.account_id = ?');
const LEGACY_SELECT_SQL = extractSql('WHERE l.account_id IS NULL');
const APPLY_AUTH_SQL = extractSql('SET account_id = @account_id');
const REVOKE_SCOPED_SQL = extractQuotedSql('AND account_id = \\? AND revoked_at IS NULL');

/** Run the same init sequence db.ts runs: CREATE IF NOT EXISTS + guarded ALTER. */
function runInit(db: any) {
  db.exec(CREATE_LINKS_SQL);
  try { db.exec(ALTER_ACCOUNT_SQL); } catch { /* column already exists — db.ts semantics */ }
}

maybeDescribe('REAL links.account_id migration (actual db.ts SQL, real SQLite)', () => {
  let Database: any;
  let db: any;
  const DID_A = 'did:privy:aaa111';
  const DID_B = 'did:privy:bbb222';

  const insertLegacy = (id: string) => db.prepare(
    "INSERT INTO links (tracking_id, kind, project_id, url, created_at) VALUES (?, 'project', 'p1', 'https://w/pl/x', ?)",
  ).run(id, new Date().toISOString());

  beforeEach(() => {
    if (!Database) Database = require(NATIVE_SQLITE_PATH);
    db = new Database(':memory:');
    // projects table only for the LEFT JOIN in the scoped selects
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, project_name TEXT)');
  });
  afterEach(() => db?.close());

  it('(1)(2)(3) pre-migration legacy rows survive; account_id added nullable; existing rows NULL', () => {
    db.exec(CREATE_LINKS_SQL);           // pre-migration schema (no account_id)
    insertLegacy('legacy1');
    insertLegacy('legacy2');
    db.exec(ALTER_ACCOUNT_SQL);          // the real migration
    const cols = db.prepare('PRAGMA table_info(links)').all();
    const acct = cols.find((c: any) => c.name === 'account_id');
    expect(acct).toBeTruthy();
    expect(acct.notnull).toBe(0);        // nullable
    const rows = db.prepare('SELECT tracking_id, account_id FROM links ORDER BY tracking_id').all();
    expect(rows).toEqual([
      { tracking_id: 'legacy1', account_id: null },
      { tracking_id: 'legacy2', account_id: null },
    ]);
  });

  it('(4) repeated initialization succeeds (idempotent init + guarded ALTER)', () => {
    runInit(db);
    insertLegacy('r1');
    expect(() => { runInit(db); runInit(db); }).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) n FROM links').get().n).toBe(1);
  });

  it('(5) account A and B reads are isolated; legacy rows in neither view', () => {
    runInit(db);
    insertLegacy('legacy');
    db.prepare("INSERT INTO links (tracking_id, kind, project_id, url, created_at, account_id) VALUES ('ta','project','p1','u',?,?)").run(new Date().toISOString(), DID_A);
    db.prepare("INSERT INTO links (tracking_id, kind, project_id, url, created_at, account_id) VALUES ('tb','project','p1','u',?,?)").run(new Date().toISOString(), DID_B);
    const a = db.prepare(SCOPED_SELECT_SQL).all(DID_A).map((r: any) => r.tracking_id);
    const b = db.prepare(SCOPED_SELECT_SQL).all(DID_B).map((r: any) => r.tracking_id);
    const legacy = db.prepare(LEGACY_SELECT_SQL).all().map((r: any) => r.tracking_id);
    expect(a).toEqual(['ta']);
    expect(b).toEqual(['tb']);
    expect(legacy).toEqual(['legacy']);
  });

  it('(6) foreign-account mutation is rejected (scoped revoke + guarded apply)', () => {
    runInit(db);
    db.prepare("INSERT INTO links (tracking_id, kind, project_id, url, created_at, account_id) VALUES ('ta','project','p1','u',?,?)").run(new Date().toISOString(), DID_A);
    // Wrong-account revoke: 0 rows changed.
    const wrong = db.prepare(REVOKE_SCOPED_SQL.replace(/\\\?/g, '?')).run(new Date().toISOString(), 'ta', DID_B);
    expect(wrong.changes).toBe(0);
    // applyAuthoritativeLink guarded by (account_id IS NULL OR account_id=@account_id):
    db.prepare(APPLY_AUTH_SQL).run({ tracking_id: 'ta', account_id: DID_B, version_id: null, expires_at: null, revoked: 1, now: new Date().toISOString() });
    const row = db.prepare("SELECT account_id, revoked_at FROM links WHERE tracking_id='ta'").get();
    expect(row.account_id).toBe(DID_A);  // ownership NOT transferred
    expect(row.revoked_at).toBeNull();   // foreign revoke did NOT apply
  });

  it('(7) a failing migration attempt does not destroy or alter existing data', () => {
    runInit(db);
    insertLegacy('keep');
    db.prepare("UPDATE links SET account_id=? WHERE tracking_id='keep'").run(DID_A);
    // Second ALTER throws (duplicate column) — db.ts catches it; data intact.
    expect(() => db.exec(ALTER_ACCOUNT_SQL)).toThrow();
    const row = db.prepare("SELECT tracking_id, account_id FROM links WHERE tracking_id='keep'").get();
    expect(row).toEqual({ tracking_id: 'keep', account_id: DID_A });
  });
});
