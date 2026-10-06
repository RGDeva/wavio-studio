/**
 * Context-pack golden path — real SQLite, file-backed.
 *
 * Two projects exist. The question is about one of them. The context must
 * carry what is relevant to Sunshine plus the global preference, and must not
 * carry Faith's notes — then survive an update, a delete, and a restart.
 *
 * Selection only: no generated prose is asserted anywhere.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from '../test-helpers/native-sqlite';
import { createBrainService } from './service';

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
const PROVENANCE_SQL = extractSql("SELECT key, value, COALESCE(category, 'note') AS category,");
const MIGRATIONS = [
  ...[...dbSrc.matchAll(/db\.exec\('((?:CREATE (?:UNIQUE )?INDEX|ALTER TABLE)[^']*)'\)/g)].map((m) => ({ at: m.index!, sql: m[1] })),
  ...[...dbSrc.matchAll(/db\.exec\("((?:CREATE (?:UNIQUE )?INDEX|ALTER TABLE)[^"]*)"\)/g)].map((m) => ({ at: m.index!, sql: m[1] })),
].sort((a, b) => a.at - b.at).map((m) => m.sql);

const T = '2026-10-06T12:00:00.000Z';
const QUERY = 'Where is my latest Sunshine vocal and master work, and how do I normally export vocals?';

maybeDescribe('assistant context golden path', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require(NATIVE_SQLITE_PATH);
  let root: string, dbPath: string, db: any, n = 0;

  function openDb() {
    const d = new Database(dbPath);
    d.pragma('foreign_keys = ON');
    d.exec(BASE_DDL);
    d.exec(FACTS_DDL);
    for (const sql of MIGRATIONS) { try { d.exec(sql); } catch { /* db.ts semantics */ } }
    return d;
  }
  const remember = (scope: string | null, key: string, value: string) =>
    db.prepare(INSERT_MEMORY_SQL).run({
      id: `m${++n}`, project_id: scope, key, value, kind: 'stated',
      source_origin: 'user', source_producer: 'ui', observed_at: T, category: 'note',
    });
  const forget = (scope: string | null, key: string) =>
    db.prepare(`UPDATE project_facts SET superseded_at=? WHERE COALESCE(project_id,'')=COALESCE(?,'')
                AND key=? AND superseded_at IS NULL`).run(T, scope, key);

  function svc() {
    return createBrainService({
      getRecords: () => ({ projects: [], files: [] }),
      getFactRows: () => [], getBelievedFactRow: () => null,
      insertFact: () => {}, supersedeFact: () => {},
      getProjectPackInput: () => null,
      getActivityInRange: () => db.prepare(
        'SELECT a.*, p.project_name FROM activity_log a LEFT JOIN projects p ON a.project_id=p.id ORDER BY a.created_at DESC',
      ).all() as any,
      getRecentProjectRows: () => [], getRecentFileRows: () => [],
      getFilesChangedSinceVersion: () => null,
      getDeriveInput: (projectId) => {
        const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
        if (!p) return null;
        const files = db.prepare('SELECT * FROM files WHERE project_id=?').all(projectId);
        return {
          projectName: p.project_name, dawType: p.daw_type,
          files: files.map((f: any) => ({
            id: f.id, name: f.file_name, role: f.role, fileType: f.file_type,
            sizeBytes: f.file_size, modifiedAt: f.modified_at,
            localStatus: f.local_status ?? 'present', syncStatus: f.sync_status ?? 'synced',
            checksum: null,
          })),
          versions: [], lastActivityAt: null,
        };
      },
      listMemoryWithProvenance: (scope) => db.prepare(PROVENANCE_SQL).all(scope) as any,
      now: () => T, newId: () => `id${++n}`,
    });
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'wavi-ctx-'));
    dbPath = join(root, 'brain.db');
    db = openDb();

    for (const [id, name, file, daw] of [
      ['p-sun', 'Sunshine', '/m/Sunshine/Sunshine.flp', 'fl-studio'],
      ['p-faith', 'Faith', '/m/Faith/Faith.als', 'ableton'],
    ]) {
      db.prepare(`INSERT INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
        VALUES (?,?,?,?,?,?)`).run(id, name, file, daw, T, T);
    }
    const addFile = (pid: string, fname: string, role: string) =>
      db.prepare(`INSERT INTO files (id, project_id, file_path, file_name, file_type, file_size, role, created_at, modified_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(`f${++n}`, pid, `/m/${fname}`, fname, fname.split('.').pop(), 10, role, T, T);
    addFile('p-sun', 'Sunshine.flp', 'project');
    addFile('p-sun', 'vocal.wav', 'audio');
    addFile('p-sun', 'master-v8.wav', 'audio');
    addFile('p-faith', 'Faith.als', 'project');

    remember(null, 'vocal-export', 'I usually export vocals into Bounces');
    remember('p-sun', 'reference', 'Sunshine reference mix is sunshine-ref.wav');
    remember('p-faith', 'reference', 'Faith reference mix is faith-ref.wav');

    db.prepare(`INSERT INTO activity_log (id, type, message, project_id, created_at) VALUES (?,?,?,?,?)`)
      .run('a1', 'file_added', 'master-v8.wav added', 'p-sun', T);
  });
  afterAll(() => { db?.close(); rmSync(root, { recursive: true, force: true }); });

  it('carries the relevant global preference and the project identity', () => {
    const ctx = svc().assistantContext({ query: QUERY, projectId: 'p-sun' });
    expect(ctx.project).toMatchObject({ name: 'Sunshine', dawType: 'fl-studio' });
    const keys = ctx.userMemory.map((m) => m.value.key);
    expect(keys).toContain('vocal-export');
  });

  it('EXCLUDES the other project’s memory entirely', () => {
    // Faith's note is never fetched, so it cannot leak — asserted on the
    // serialized context, not just the key list.
    const ctx = svc().assistantContext({ query: QUERY, projectId: 'p-sun' });
    expect(JSON.stringify(ctx)).not.toContain('faith-ref');
    expect(ctx.userMemory.every((m) => m.value.scope !== 'project' || m.value.value.includes('Sunshine'))).toBe(true);
  });

  it('includes the relevant Sunshine files and the master candidate', () => {
    const ctx = svc().assistantContext({ query: QUERY, projectId: 'p-sun' });
    const names = ctx.files.map((f) => f.name);
    expect(names).toContain('master-v8.wav');
    expect(names).toContain('vocal.wav');
    expect(names).not.toContain('Faith.als');
  });

  it('includes recent Sunshine activity only', () => {
    const ctx = svc().assistantContext({ query: QUERY, projectId: 'p-sun' });
    expect(ctx.recentActivity.some((a) => a.message.includes('master-v8'))).toBe(true);
  });

  it('attributes memory, facts and inferences distinctly', () => {
    const ctx = svc().assistantContext({ query: QUERY, projectId: 'p-sun' });
    expect(ctx.userMemory[0].attribution.kind).toBe('stated');
    if (ctx.facts.length) expect(ctx.facts[0].attribution.kind).toBe('derived');
    if (ctx.inferences.length) expect(ctx.inferences[0].attribution.kind).toBe('inferred');
  });

  it('carries no filesystem path into the context', () => {
    const ctx = svc().assistantContext({ query: QUERY, projectId: 'p-sun' });
    expect(JSON.stringify(ctx)).not.toMatch(/\/m\/|\/Users\//);
  });

  it('an updated preference returns the new value', () => {
    forget(null, 'vocal-export');
    remember(null, 'vocal-export', 'I now export vocals into Stems');
    const ctx = svc().assistantContext({ query: 'how do I export vocals?', projectId: 'p-sun' });
    const m = ctx.userMemory.find((x) => x.value.key === 'vocal-export')!;
    expect(m.value.value).toContain('Stems');
    expect(m.value.value).not.toContain('Bounces');
  });

  it('a deleted preference disappears from context, leaving project memory intact', () => {
    forget(null, 'vocal-export');
    const ctx = svc().assistantContext({ query: 'export vocals reference', projectId: 'p-sun' });
    expect(ctx.userMemory.map((m) => m.value.key)).not.toContain('vocal-export');
    // Deleting GLOBAL memory must not touch PROJECT memory.
    expect(ctx.userMemory.map((m) => m.value.key)).toContain('reference');
  });

  it('the same context function still works after a genuine restart', () => {
    db.close();
    db = openDb();
    const ctx = svc().assistantContext({ query: 'reference mix', projectId: 'p-sun' });
    expect(ctx.project?.name).toBe('Sunshine');
    expect(ctx.userMemory.map((m) => m.value.key)).toContain('reference');
    expect(JSON.stringify(ctx)).not.toContain('faith-ref');
  });

  it('deleting project memory does not delete global memory', () => {
    remember(null, 'style', 'keep mixes sparse');
    forget('p-sun', 'reference');
    const ctx = svc().assistantContext({ query: '', projectId: 'p-sun' });
    const keys = ctx.userMemory.map((m) => m.value.key);
    expect(keys).not.toContain('reference');
    expect(keys).toContain('style');
  });
});
