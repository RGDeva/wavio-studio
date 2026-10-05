/**
 * The live loop, against a REAL database.
 *
 * Unit tests prove the coalescing logic; this proves the thing that actually
 * matters to a user: a file changes, nobody presses Rescan, and what the brain
 * believes afterwards is different — persisted, and still there on the next
 * read.
 *
 * Schema comes from db.ts's own SQL in db.ts's own source order, so a schema
 * drift or a re-ordered migration fails here rather than shipping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from '../test-helpers/native-sqlite';
import { createBrainRefresher, type RefresherDeps } from './liveRefresh';

const maybeDescribe = nativeSqliteAvailable ? describe : describe.skip;
const dbSrc = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');

function extractSql(marker: string): string {
  const i = dbSrc.indexOf(marker);
  if (i < 0) throw new Error(`marker not found: ${marker}`);
  return dbSrc.slice(dbSrc.lastIndexOf('`', i) + 1, dbSrc.indexOf('`', i + marker.length));
}
function schemaSteps(): Array<{ sql: string; tolerant: boolean }> {
  const steps: Array<{ at: number; sql: string; tolerant: boolean }> = [];
  for (const m of ['CREATE TABLE IF NOT EXISTS projects', 'CREATE TABLE IF NOT EXISTS project_facts']) {
    steps.push({ at: dbSrc.indexOf(m), sql: extractSql(m), tolerant: false });
  }
  for (const m of dbSrc.matchAll(/db\.exec\('((?:ALTER TABLE|CREATE UNIQUE INDEX|CREATE INDEX)[^']*)'\)/g)) {
    steps.push({ at: m.index!, sql: m[1], tolerant: true });
  }
  for (const m of dbSrc.matchAll(/db\.exec\("((?:ALTER TABLE)[^"]*)"\)/g)) {
    steps.push({ at: m.index!, sql: m[1], tolerant: true });
  }
  return steps.sort((a, b) => a.at - b.at).map(({ sql, tolerant }) => ({ sql, tolerant }));
}

const T0 = '2026-10-05T12:00:00.000Z';

maybeDescribe('live refresh against real SQLite', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require(NATIVE_SQLITE_PATH);
  let db: any;
  let nowMs: number;
  let queue: Array<{ fn: () => void; at: number }>;
  let seq: number;

  /** Mutable stand-in for what the indexer has written about the project. */
  let files: Array<{ id: string; name: string; role: string; status: string }>;

  function makeDeps(): RefresherDeps {
    return {
      getDeriveInput: (projectId) => {
        const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
        if (!row) return null;
        return {
          projectName: row.project_name,
          dawType: row.daw_type ?? null,
          files: files.map((f) => ({
            id: f.id, name: f.name, role: f.role, fileType: 'wav', sizeBytes: 1,
            modifiedAt: T0, localStatus: f.status, syncStatus: 'synced', checksum: null,
          })),
          versions: [],
          lastActivityAt: null,
        };
      },
      getBelievedFact: (projectId, key) => {
        const r = db.prepare('SELECT * FROM project_facts WHERE project_id=? AND key=? AND superseded_at IS NULL')
          .get(projectId, key);
        return r ? {
          id: r.id, projectId: r.project_id, key: r.key, value: r.value,
          kind: r.kind, source: { origin: r.source_origin, producer: r.source_producer },
          observedAt: r.observed_at, supersededAt: r.superseded_at,
        } : null;
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
    for (const d of queue.filter((q) => q.at <= nowMs)) {
      queue.splice(queue.indexOf(d), 1); d.fn();
    }
  }
  const believed = (key: string) =>
    db.prepare("SELECT value FROM project_facts WHERE project_id='p1' AND key=? AND superseded_at IS NULL")
      .get(key)?.value ?? null;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const { sql, tolerant } of schemaSteps()) {
      if (tolerant) { try { db.exec(sql); } catch { /* db.ts semantics */ } }
      else db.exec(sql);
    }
    db.prepare(`INSERT INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
      VALUES ('p1','Sunshine','/m/Sunshine.flp','fl-studio',?,?)`).run(T0, T0);
    nowMs = Date.parse(T0);
    queue = [];
    seq = 0;
    files = [{ id: 'f1', name: 'Sunshine.flp', role: 'project', status: 'present' }];
  });
  afterEach(() => db?.close());

  it('persists derived memory without anyone pressing Rescan', () => {
    const r = createBrainRefresher(makeDeps(), { debounceMs: 5_000, minIntervalMs: 0 });
    expect(believed('file-count')).toBeNull();      // nothing remembered yet

    r.markDirty('p1');
    advance(5_000);

    expect(believed('file-count')).toBe('1');
    expect(believed('source-daw')).toBe('fl-studio');
  });

  it('a burst of events produces ONE set of facts, not one per event', () => {
    const r = createBrainRefresher(makeDeps(), { debounceMs: 5_000, minIntervalMs: 0 });
    for (let i = 0; i < 40; i++) r.markDirty('p1');
    advance(5_000);
    // 40 events, one recompute: no key was written more than once.
    const rows = db.prepare("SELECT key, COUNT(*) c FROM project_facts WHERE project_id='p1' GROUP BY key HAVING c > 1").all();
    expect(rows).toEqual([]);
  });

  it('tracks a real change and keeps the previous belief as history', () => {
    const r = createBrainRefresher(makeDeps(), { debounceMs: 1_000, minIntervalMs: 0 });
    r.markDirty('p1'); advance(1_000);
    expect(believed('file-count')).toBe('1');

    // The watcher indexes a new bounce.
    files.push({ id: 'f2', name: 'master-v7.wav', role: 'audio', status: 'present' });
    r.markDirty('p1'); advance(1_000);

    expect(believed('file-count')).toBe('2');
    // The old value is superseded, not deleted — "what did we believe, and
    // when did it change?" stays answerable.
    const history = db.prepare("SELECT value, superseded_at FROM project_facts WHERE project_id='p1' AND key='file-count' ORDER BY observed_at").all();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ value: '1' });
    expect(history[0].superseded_at).not.toBeNull();
  });

  it('writes nothing at all when the recompute finds no change', () => {
    const r = createBrainRefresher(makeDeps(), { debounceMs: 1_000, minIntervalMs: 0 });
    r.markDirty('p1'); advance(1_000);
    const before = db.prepare('SELECT COUNT(*) c FROM project_facts').get().c;

    r.markDirty('p1'); advance(1_000);
    expect(db.prepare('SELECT COUNT(*) c FROM project_facts').get().c).toBe(before);
  });

  it('reflects a deleted file as missing rather than dropping it from memory', () => {
    const r = createBrainRefresher(makeDeps(), { debounceMs: 1_000, minIntervalMs: 0 });
    files.push({ id: 'f2', name: 'vocal.wav', role: 'audio', status: 'present' });
    r.markDirty('p1'); advance(1_000);
    expect(believed('missing-file-count')).toBe('0');

    files[1].status = 'missing';     // watcher saw an unlink
    r.markDirty('p1'); advance(1_000);
    expect(believed('missing-file-count')).toBe('1');
    expect(believed('present-file-count')).toBe('1');
  });

  it('every fact it writes is attributed to the index, never to an agent', () => {
    // A derived fact may only originate from the index; this is what stops a
    // model's opinion being laundered into ground truth.
    const r = createBrainRefresher(makeDeps(), { debounceMs: 1_000, minIntervalMs: 0 });
    r.markDirty('p1'); advance(1_000);
    const rows = db.prepare("SELECT DISTINCT kind, source_origin, source_producer FROM project_facts").all();
    expect(rows).toEqual([{ kind: 'derived', source_origin: 'index', source_producer: 'watcher' }]);
  });

  it('forceRefresh bypasses the throttle for a manual Rescan', () => {
    const r = createBrainRefresher(makeDeps(), { debounceMs: 1_000, minIntervalMs: 600_000 });
    r.markDirty('p1'); advance(1_000);

    files.push({ id: 'f2', name: 'extra.wav', role: 'audio', status: 'present' });
    // The debounced path would refuse for ten minutes; Rescan must not.
    expect(r.forceRefresh('p1')).toBeGreaterThan(0);
    expect(believed('file-count')).toBe('2');
  });

  it('survives the project disappearing mid-flight', () => {
    const r = createBrainRefresher(makeDeps(), { debounceMs: 1_000, minIntervalMs: 0 });
    r.markDirty('p1');
    db.prepare("DELETE FROM projects WHERE id='p1'").run();
    expect(() => advance(1_000)).not.toThrow();
    // Cascade removed its memory along with it; nothing orphaned.
    expect(db.prepare('SELECT COUNT(*) c FROM project_facts').get().c).toBe(0);
  });
});
