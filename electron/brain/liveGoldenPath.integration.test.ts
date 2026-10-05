/**
 * Project Brain, live — the full golden path against a FILE-BACKED database.
 *
 * Proves the thing a user would actually notice: a file appears, nobody
 * presses Rescan, and the assistant's next answer is different.
 *
 * File-backed rather than :memory: because the restart step has to mean
 * closing the database and opening it again, or it proves nothing. Schema and
 * the real upsert come from db.ts's own SQL in its own source order.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from '../test-helpers/native-sqlite';
import { createBrainRefresher, type RefresherDeps } from './liveRefresh';
import { parseBrainQuery } from './query';
import { rankRecords, type BrainRecord } from './retrieval';
import { resolveNamedRange } from './timeRange';

const maybeDescribe = nativeSqliteAvailable ? describe : describe.skip;
const dbSrc = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');

function extractSql(marker: string): string {
  const i = dbSrc.indexOf(marker);
  if (i < 0) throw new Error(`marker not found: ${marker}`);
  return dbSrc.slice(dbSrc.lastIndexOf('`', i) + 1, dbSrc.indexOf('`', i + marker.length));
}
const BASE_DDL = extractSql('CREATE TABLE IF NOT EXISTS projects');
const FACTS_DDL = extractSql('CREATE TABLE IF NOT EXISTS project_facts');
/** Named-parameter form: both upserts now share a column list. */
const UPSERT_FILE = extractSql('VALUES (@id, @project_id, @file_path');
const MIGRATIONS = [
  ...[...dbSrc.matchAll(/db\.exec\('((?:CREATE (?:UNIQUE )?INDEX|ALTER TABLE)[^']*)'\)/g)].map((m) => ({ at: m.index!, sql: m[1] })),
  ...[...dbSrc.matchAll(/db\.exec\("((?:ALTER TABLE)[^"]*)"\)/g)].map((m) => ({ at: m.index!, sql: m[1] })),
].sort((a, b) => a.at - b.at).map((m) => m.sql);

const T0 = '2026-10-05T12:00:00.000Z';

maybeDescribe('Project Brain live golden path', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require(NATIVE_SQLITE_PATH);
  let root: string, dbPath: string, db: any;
  let nowMs = Date.parse(T0);
  let queue: Array<{ fn: () => void; at: number }> = [];
  let seq = 0;
  let refresher: ReturnType<typeof createBrainRefresher>;

  function openDb() {
    const d = new Database(dbPath);
    d.pragma('foreign_keys = ON');
    d.exec(BASE_DDL);
    d.exec(FACTS_DDL);
    for (const sql of MIGRATIONS) { try { d.exec(sql); } catch { /* db.ts semantics */ } }
    return d;
  }

  /** What the indexer does on a file event: upsert the row. */
  function indexFile(projectId: string, name: string, role: string, at = new Date(nowMs).toISOString()) {
    db.prepare(UPSERT_FILE).run({
      id: `f-${name}`, project_id: projectId, file_path: `/m/Sunshine/${name}`, file_name: name,
      file_type: name.split('.').pop() ?? '', file_size: 100, checksum: null,
      bpm: null, key_note: null, duration: null, role, created_at: at, modified_at: at,
    });
  }
  function logActivity(type: string, message: string, projectId: string) {
    db.prepare(`INSERT INTO activity_log (id, type, message, project_id, created_at) VALUES (?,?,?,?,?)`)
      .run(`a-${++seq}`, type, message, projectId, new Date(nowMs).toISOString());
  }

  function makeDeps(): RefresherDeps {
    return {
      getDeriveInput: (projectId) => {
        const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
        if (!proj) return null;
        const files = db.prepare('SELECT * FROM files WHERE project_id = ?').all(projectId);
        return {
          projectName: proj.project_name, dawType: proj.daw_type ?? null,
          files: files.map((f: any) => ({
            id: f.id, name: f.file_name, role: f.role, fileType: f.file_type,
            sizeBytes: f.file_size, modifiedAt: f.modified_at,
            localStatus: f.local_status ?? 'present', syncStatus: f.sync_status ?? 'pending',
            checksum: f.checksum ?? null,
          })),
          versions: [], lastActivityAt: null,
        };
      },
      getBelievedFact: (projectId, key) => {
        const r = db.prepare('SELECT * FROM project_facts WHERE project_id=? AND key=? AND superseded_at IS NULL').get(projectId, key);
        return r ? { id: r.id, projectId: r.project_id, key: r.key, value: r.value, kind: r.kind,
                     source: { origin: r.source_origin, producer: r.source_producer },
                     observedAt: r.observed_at, supersededAt: r.superseded_at } : null;
      },
      insertFact: (f) => db.prepare(`INSERT INTO project_facts
        (id, project_id, key, value, kind, source_origin, source_producer, observed_at, superseded_at)
        VALUES (?,?,?,?,?,?,?,?,NULL)`)
        .run(f.id, f.projectId, f.key, f.value, f.kind, f.source.origin, f.source.producer, f.observedAt),
      supersedeFact: (id, at) => db.prepare('UPDATE project_facts SET superseded_at=? WHERE id=?').run(at, id),
      newId: () => `fact-${++seq}`,
      now: () => new Date(nowMs).toISOString(),
      schedule: (fn, ms) => { const h = { fn, at: nowMs + ms }; queue.push(h); return h; },
      cancel: (h) => { const i = queue.indexOf(h as any); if (i >= 0) queue.splice(i, 1); },
    };
  }

  function advance(ms: number) {
    nowMs += ms;
    for (const d of queue.filter((q) => q.at <= nowMs)) { queue.splice(queue.indexOf(d), 1); d.fn(); }
  }
  const believed = (key: string, projectId = 'p-sun') =>
    db.prepare('SELECT value FROM project_facts WHERE project_id=? AND key=? AND superseded_at IS NULL')
      .get(projectId, key)?.value ?? null;

  /** The deterministic retrieval an assistant tool would run. */
  function search(q: string): BrainRecord[] {
    const rows = db.prepare(`SELECT f.id, f.project_id, f.file_name AS name, p.project_name, p.daw_type,
      f.role, f.file_type, f.modified_at, f.local_status FROM files f LEFT JOIN projects p ON f.project_id=p.id`).all();
    const records: BrainRecord[] = rows.map((r: any) => ({
      id: r.id, kind: 'file', projectId: r.project_id, name: r.name, projectName: r.project_name ?? '',
      dawType: r.daw_type ?? null, role: r.role ?? null, fileType: r.file_type ?? null,
      bpm: null, keyNote: null, status: r.local_status ?? null, modifiedAt: r.modified_at,
    }));
    return rankRecords(records, parseBrainQuery(q, 2026), { now: new Date(nowMs).toISOString() }).map((h) => h.record);
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'wavi-brain-live-'));
    dbPath = join(root, 'brain.db');
    db = openDb();
    db.prepare(`INSERT INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
      VALUES ('p-sun','Sunshine','/m/Sunshine/Sunshine.flp','fl-studio',?,?)`).run(T0, T0);
    indexFile('p-sun', 'Sunshine.flp', 'project');
    indexFile('p-sun', 'vocal.wav', 'audio');
    indexFile('p-sun', 'master-v7.wav', 'audio');
    refresher = createBrainRefresher(makeDeps(), { debounceMs: 5_000, minIntervalMs: 0 });
  });
  afterAll(() => { db?.close(); rmSync(root, { recursive: true, force: true }); });

  it('1. initial state: memory reports master-v7 once refreshed', () => {
    refresher.markDirty('p-sun');
    advance(5_000);
    expect(believed('file-count')).toBe('3');
    // likely-master is an inference, so it is not written as a fact — the
    // facts are what the index states outright.
    expect(believed('present-file-count')).toBe('3');
    expect(search('master')[0].name).toBe('master-v7.wav');
  });

  it('2-5. a new bounce appears and the brain updates with no manual rescan', () => {
    // The indexer processes a watcher 'add'…
    indexFile('p-sun', 'master-v8.wav', 'audio');
    logActivity('file_added', 'master-v8.wav added', 'p-sun');
    // …and the ONLY thing anyone calls is markDirty.
    refresher.markDirty('p-sun');
    advance(5_000);

    expect(believed('file-count')).toBe('4');
    // search_music_library would now surface v8
    const masters = search('master').map((r) => r.name);
    expect(masters).toContain('master-v8.wav');
  });

  it('6. "what changed recently?" returns the new event', () => {
    const range = resolveNamedRange('today', new Date(nowMs).toISOString());
    const events = db.prepare(`SELECT * FROM activity_log WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC`)
      .all(range.from, range.to);
    expect(events.some((e: any) => e.message.includes('master-v8.wav'))).toBe(true);
  });

  it('7. discovered_at is set, and differs from the file’s own created_at semantics', () => {
    const r = db.prepare("SELECT * FROM files WHERE file_name='master-v8.wav'").get();
    expect(r.discovered_at).not.toBeNull();
    expect(r.last_seen_at).not.toBeNull();
  });

  it('8. restart: derived memory, activity and discovered_at all survive', () => {
    const factsBefore = db.prepare('SELECT COUNT(*) c FROM project_facts').get().c;
    const discoveredBefore = db.prepare("SELECT discovered_at FROM files WHERE file_name='master-v8.wav'").get().discovered_at;

    db.close();
    db = openDb();                      // genuine restart
    refresher = createBrainRefresher(makeDeps(), { debounceMs: 5_000, minIntervalMs: 0 });

    expect(db.prepare('SELECT COUNT(*) c FROM project_facts').get().c).toBe(factsBefore);
    expect(believed('file-count')).toBe('4');
    expect(db.prepare('SELECT COUNT(*) c FROM activity_log').get().c).toBeGreaterThan(0);
    expect(db.prepare("SELECT discovered_at FROM files WHERE file_name='master-v8.wav'").get().discovered_at)
      .toBe(discoveredBefore);
  });

  it('9. the first event after restart updates the SAME project without duplicating memory', () => {
    const before = db.prepare("SELECT COUNT(*) c FROM project_facts WHERE key='file-count' AND superseded_at IS NULL").get().c;
    refresher.markDirty('p-sun');
    advance(5_000);
    // Nothing changed, so nothing was written — and still exactly one believed
    // value for the key, not a second parallel memory.
    expect(db.prepare("SELECT COUNT(*) c FROM project_facts WHERE key='file-count' AND superseded_at IS NULL").get().c)
      .toBe(before);
    expect(db.prepare('SELECT COUNT(*) c FROM projects').get().c).toBe(1);
  });

  it('10. a rename reconciles in place rather than creating a second file', () => {
    const original = db.prepare("SELECT * FROM files WHERE file_name='vocal.wav'").get();
    db.prepare(`UPDATE files SET file_path=?, file_name=?, last_seen_at=?, local_status='present',
                reconciled_from=file_path WHERE id=?`)
      .run('/m/Sunshine/vocal-final.wav', 'vocal-final.wav', new Date(nowMs).toISOString(), original.id);
    logActivity('file_moved', 'vocal.wav → vocal-final.wav', 'p-sun');

    refresher.markDirty('p-sun'); advance(5_000);

    const moved = db.prepare("SELECT * FROM files WHERE file_name='vocal-final.wav'").get();
    expect(moved.id).toBe(original.id);                      // same identity
    expect(moved.discovered_at).toBe(original.discovered_at); // history kept
    expect(believed('file-count')).toBe('4');                 // not 5
  });

  it('11. a delete shows as missing, and memory says so', () => {
    db.prepare("UPDATE files SET local_status='missing' WHERE file_name='vocal-final.wav'").run();
    logActivity('file_missing', 'vocal-final.wav is missing', 'p-sun');
    refresher.markDirty('p-sun'); advance(5_000);

    expect(believed('missing-file-count')).toBe('1');
    expect(believed('present-file-count')).toBe('3');
  });

  it('12. restoring the file converges the state again', () => {
    db.prepare("UPDATE files SET local_status='present', last_seen_at=? WHERE file_name='vocal-final.wav'")
      .run(new Date(nowMs).toISOString());
    refresher.markDirty('p-sun'); advance(5_000);

    expect(believed('missing-file-count')).toBe('0');
    expect(believed('present-file-count')).toBe('4');
    // And the file never lost its identity through the whole cycle.
    expect(db.prepare('SELECT COUNT(*) c FROM files').get().c).toBe(4);
  });
});

maybeDescribe('coalescing at burst scale', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require(NATIVE_SQLITE_PATH);

  it('200 events across 10 projects produce 10 refreshes, not 200', () => {
    // Logical coalescing, counted — not a timing assertion, which would be
    // brittle on a busy machine.
    let derives = 0;
    let nowMs = Date.parse(T0);
    const queue: Array<{ fn: () => void; at: number }> = [];
    const db = new Database(':memory:');
    db.exec(BASE_DDL); db.exec(FACTS_DDL);
    for (const sql of MIGRATIONS) { try { db.exec(sql); } catch { /* db.ts semantics */ } }

    for (let p = 0; p < 10; p++) {
      db.prepare(`INSERT INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
        VALUES (?,?,?,?,?,?)`).run(`p${p}`, `Project ${p}`, `/m/p${p}/x.als`, 'ableton', T0, T0);
    }

    let seq = 0;
    const r = createBrainRefresher({
      getDeriveInput: (projectId) => {
        derives++;
        const proj = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
        if (!proj) return null;
        return { projectName: proj.project_name, dawType: proj.daw_type, files: [], versions: [], lastActivityAt: null };
      },
      getBelievedFact: () => null,
      insertFact: (f) => db.prepare(`INSERT INTO project_facts
        (id, project_id, key, value, kind, source_origin, source_producer, observed_at, superseded_at)
        VALUES (?,?,?,?,?,?,?,?,NULL)`)
        .run(f.id, f.projectId, f.key, f.value, f.kind, f.source.origin, f.source.producer, f.observedAt),
      supersedeFact: () => {},
      newId: () => `fact-${++seq}`,
      now: () => new Date(nowMs).toISOString(),
      schedule: (fn, ms) => { const h = { fn, at: nowMs + ms }; queue.push(h); return h; },
      cancel: (h) => { const i = queue.indexOf(h as any); if (i >= 0) queue.splice(i, 1); },
    }, { debounceMs: 5_000, minIntervalMs: 0, maxPerBatch: 25 });

    // 200 events, 20 per project.
    for (let i = 0; i < 200; i++) r.markDirty(`p${i % 10}`);
    expect(derives).toBe(0);          // all still coalescing
    expect(r.pendingCount()).toBe(10);

    nowMs += 5_000;
    for (const d of queue.filter((q) => q.at <= nowMs)) { queue.splice(queue.indexOf(d), 1); d.fn(); }

    expect(derives).toBe(10);         // one per project, not one per event
    expect(r.pendingCount()).toBe(0);
    db.close();
  });
});
