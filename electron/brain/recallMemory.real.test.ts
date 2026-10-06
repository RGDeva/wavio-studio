/**
 * End-to-end memory retrieval: real SQL in, assistant tool out.
 *
 * The example the milestone names:
 *
 *   the user remembers "Sunshine vocals are usually exported to /Bounces"
 *   …later, the assistant asks for memory and gets it back.
 *
 * File-backed, so the retrieval is proven across a genuine restart rather than
 * within one process. The SQL is EXTRACTED from db.ts, so a change to the
 * shipped statements fails here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from '../test-helpers/native-sqlite';
import { createBrainService } from './service';
import { buildBrainToolSpecs } from '../copilotTools/brainTools';
import { sanitizeToolResult } from '../copilotTools/envelope';

const maybeDescribe = nativeSqliteAvailable ? describe : describe.skip;
const dbSrc = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');

function extractSql(marker: string): string {
  const i = dbSrc.indexOf(marker);
  if (i < 0) throw new Error(`marker not found: ${marker}`);
  return dbSrc.slice(dbSrc.lastIndexOf('`', i) + 1, dbSrc.indexOf('`', i + marker.length));
}
const BASE_DDL = extractSql('CREATE TABLE IF NOT EXISTS projects');
const FACTS_DDL = extractSql('CREATE TABLE IF NOT EXISTS project_facts');
const INSERT_MEMORY_SQL = extractSql('INSERT INTO project_facts\n      (id, project_id, key, value, kind, source_origin, source_producer, observed_at, category, superseded_at)');
const PROVENANCE_SQL = extractSql('SELECT key, value, COALESCE(category, \'note\') AS category,');
const MIGRATIONS = [
  ...[...dbSrc.matchAll(/db\.exec\('((?:CREATE (?:UNIQUE )?INDEX|ALTER TABLE)[^']*)'\)/g)].map((m) => ({ at: m.index!, sql: m[1] })),
  ...[...dbSrc.matchAll(/db\.exec\("((?:CREATE (?:UNIQUE )?INDEX|ALTER TABLE)[^"]*)"\)/g)].map((m) => ({ at: m.index!, sql: m[1] })),
].sort((a, b) => a.at - b.at).map((m) => m.sql);

const T = '2026-10-06T10:00:00.000Z';

maybeDescribe('memory retrieval, end to end (real SQLite, file-backed)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require(NATIVE_SQLITE_PATH);
  let root: string, dbPath: string, db: any;

  function openDb() {
    const d = new Database(dbPath);
    d.pragma('foreign_keys = ON');
    d.exec(BASE_DDL);
    d.exec(FACTS_DDL);
    for (const sql of MIGRATIONS) { try { d.exec(sql); } catch { /* db.ts semantics */ } }
    return d;
  }

  /** The service, reading through the REAL provenance query. */
  function svc() {
    return createBrainService({
      getRecords: () => ({ projects: [], files: [] }),
      getFactRows: () => [], getBelievedFactRow: () => null,
      insertFact: () => {}, supersedeFact: () => {},
      getProjectPackInput: () => null,
      getActivityInRange: () => [], getRecentProjectRows: () => [], getRecentFileRows: () => [],
      getFilesChangedSinceVersion: () => null, getDeriveInput: () => null,
      listMemoryWithProvenance: (scope) => db.prepare(PROVENANCE_SQL).all(scope) as any,
      now: () => T, newId: () => 'id',
    });
  }
  const tool = () => {
    const s = svc();
    return buildBrainToolSpecs({
      search: () => s.search(''), findFiles: () => s.findFiles(''),
      recentActivity: () => s.recentActivity('today'), recentProjects: () => s.recentProjects('today'),
      projectMemory: () => null, changedSince: () => null,
      recallMemory: (o) => s.recallMemory(o),
    } as any).find((t) => t.name === 'recall_memory')!;
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'wavi-recall-'));
    dbPath = join(root, 'brain.db');
    db = openDb();
    db.prepare(`INSERT INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
      VALUES ('p-sun','Sunshine','/m/Sunshine/Sunshine.flp','fl-studio',?,?)`).run(T, T);

    // The user records a project note and a standing preference.
    db.prepare(INSERT_MEMORY_SQL).run({
      id: 'm1', project_id: 'p-sun', key: 'bounce-dir',
      value: 'Sunshine vocals are usually exported to /Bounces',
      kind: 'stated', source_origin: 'user', source_producer: 'ui', observed_at: T, category: 'note',
    });
    db.prepare(INSERT_MEMORY_SQL).run({
      id: 'm2', project_id: null, key: 'style', value: 'keep mixes sparse',
      kind: 'stated', source_origin: 'user', source_producer: 'ui', observed_at: T, category: 'note',
    });
    // …and the index records a derived fact, which memory retrieval must NOT
    // present as something the user said.
    db.prepare(INSERT_MEMORY_SQL).run({
      id: 'm3', project_id: 'p-sun', key: 'file-count', value: '4',
      kind: 'derived', source_origin: 'index', source_producer: 'watcher', observed_at: T, category: null,
    });
  });
  afterAll(() => { db?.close(); rmSync(root, { recursive: true, force: true }); });

  it('retrieves the remembered note through the assistant tool', async () => {
    const res: any = await tool().run({}, { projectId: 'p-sun' });
    expect(res.status).toBe('done');
    const found = res.data.project.find((m: any) => m.key === 'bounce-dir');
    expect(found.value).toContain('Bounces');
    expect(found.attribution).toBe('you told Wavi (via ui)');
  });

  it('keeps the standing preference in the global bucket', async () => {
    const res: any = await tool().run({}, { projectId: 'p-sun' });
    expect(res.data.global.map((m: any) => m.key)).toEqual(['style']);
    expect(res.data.project.map((m: any) => m.key)).toEqual(['bounce-dir']);
  });

  it('never presents a DERIVED index fact as user memory', () => {
    // file-count is the index's own bookkeeping; surfacing it here would let
    // the assistant claim the user said it.
    const out = svc().recallMemory({ projectId: 'p-sun' });
    expect(out.project.map((m) => m.key)).not.toContain('file-count');
  });

  it('reduces an absolute path to a name before the result leaves the app', async () => {
    // The memory text contains "/Bounces". The boundary redacts absolute paths,
    // so the model sees the folder NAME and cannot quote a filesystem path.
    const res: any = await tool().run({}, { projectId: 'p-sun' });
    const sanitized: any = sanitizeToolResult(res);
    const json = JSON.stringify(sanitized);
    expect(json).not.toContain('/Bounces');
    expect(json).toContain('Bounces');
  });

  it('survives a genuine restart', async () => {
    db.close();
    db = openDb();                       // reopen the same file
    const res: any = await tool().run({}, { projectId: 'p-sun' });
    expect(res.data.total).toBe(2);
    expect(res.data.project[0].value).toContain('Bounces');
    // Re-running the schema did not duplicate anything.
    expect(db.prepare("SELECT COUNT(*) c FROM project_facts WHERE key='bounce-dir'").get().c).toBe(1);
  });

  it('another project sees the global memory but not Sunshine’s note', async () => {
    db.prepare(`INSERT INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
      VALUES ('p-other','Faith','/m/Faith/Faith.als','ableton',?,?)`).run(T, T);
    const res: any = await tool().run({}, { projectId: 'p-other' });
    expect(res.data.project).toEqual([]);
    expect(res.data.global.map((m: any) => m.key)).toEqual(['style']);
  });
});
