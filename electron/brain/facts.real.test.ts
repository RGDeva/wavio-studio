/**
 * REAL SQLite verification of the project_facts schema, on a FRESH database.
 *
 * This is the exact class of bug that broke Project Link creation for every
 * new user: an ALTER that ran before its CREATE, failed silently, and left a
 * column missing — invisible on any machine whose database predated it.
 *
 * As in dbMigration.real.test.ts, the SQL is EXTRACTED from db.ts rather than
 * copied, and the statements are replayed in db.ts's own SOURCE ORDER, so a
 * re-ordering regression fails here instead of shipping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from '../test-helpers/native-sqlite';

const maybeDescribe = nativeSqliteAvailable ? describe : describe.skip;
const dbSrc = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');

function extractSql(marker: string): string {
  const idx = dbSrc.indexOf(marker);
  if (idx < 0) throw new Error(`marker not found in db.ts: ${marker}`);
  const start = dbSrc.lastIndexOf('`', idx);
  const end = dbSrc.indexOf('`', idx + marker.length);
  return dbSrc.slice(start + 1, end);
}

const CREATE_PROJECTS = extractSql('CREATE TABLE IF NOT EXISTS projects');
const CREATE_FACTS = extractSql('CREATE TABLE IF NOT EXISTS project_facts');

/** Index statements for project_facts, in the order db.ts runs them. */
function factIndexStatements(): string[] {
  return [...dbSrc.matchAll(/db\.exec\('((?:CREATE[^']*project_facts[^']*))'\)/g)]
    .sort((a, b) => a.index! - b.index!)
    .map((m) => m[1]);
}

maybeDescribe('project_facts on a fresh database (real SQLite)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require(NATIVE_SQLITE_PATH);
  let db: any;

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'f1', project_id: 'p1', key: 'tempo', value: '128', kind: 'derived',
    source_origin: 'index', source_producer: 'watcher',
    observed_at: '2026-10-04T12:00:00.000Z', superseded_at: null, ...over,
  });
  const insert = (r: Record<string, unknown>) => db.prepare(`
    INSERT INTO project_facts (id, project_id, key, value, kind, source_origin, source_producer, observed_at, superseded_at)
    VALUES (@id, @project_id, @key, @value, @kind, @source_origin, @source_producer, @observed_at, @superseded_at)
  `).run(r);

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_PROJECTS);
    db.exec(CREATE_FACTS);
    for (const sql of factIndexStatements()) db.exec(sql);
    db.prepare(`INSERT INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
      VALUES ('p1','Midnight','/m/Midnight.als','ableton','2026-10-01','2026-10-01')`).run();
  });
  afterEach(() => db?.close());

  it('the shipped CREATE declares every column the inserts write', () => {
    // Belt and braces against the ALTER-before-CREATE failure mode.
    const cols = db.prepare('PRAGMA table_info(project_facts)').all().map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'project_id', 'key', 'value', 'kind',
      'source_origin', 'source_producer', 'observed_at', 'superseded_at',
    ]));
  });

  it('a fresh database can store and read back a fact', () => {
    expect(() => insert(row())).not.toThrow();
    expect(db.prepare("SELECT value FROM project_facts WHERE id='f1'").get().value).toBe('128');
  });

  it('allows only ONE believed fact per (project, key)', () => {
    insert(row());
    expect(() => insert(row({ id: 'f2', value: '140' }))).toThrow(/UNIQUE/i);
  });

  it('allows history: superseded rows fall out of the unique index', () => {
    insert(row());
    db.prepare("UPDATE project_facts SET superseded_at='2026-10-04T13:00:00.000Z' WHERE id='f1'").run();
    expect(() => insert(row({ id: 'f2', value: '140' }))).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM project_facts').get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM project_facts WHERE superseded_at IS NULL').get().c).toBe(1);
  });

  it('keeps the same key independent across projects', () => {
    db.prepare(`INSERT INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
      VALUES ('p2','Other','/m/Other.als','ableton','2026-10-01','2026-10-01')`).run();
    insert(row());
    expect(() => insert(row({ id: 'f2', project_id: 'p2' }))).not.toThrow();
  });

  it('removes a project’s memory when the project is deleted', () => {
    // Facts are scoped to a project; orphaned memory would be unattributable.
    insert(row());
    db.prepare("DELETE FROM projects WHERE id='p1'").run();
    expect(db.prepare('SELECT COUNT(*) c FROM project_facts').get().c).toBe(0);
  });

  it('refuses a fact for a project that does not exist', () => {
    expect(() => insert(row({ id: 'f9', project_id: 'ghost' }))).toThrow(/FOREIGN KEY/i);
  });
});
