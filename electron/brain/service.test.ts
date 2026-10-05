/**
 * Project Brain — the composed service.
 *
 * Exercised against an in-memory fake of the row getters, which is legitimate
 * here because the fake supplies ROWS, not behaviour: the logic under test
 * lives in the pure modules, and the real SQL is covered by the db suites.
 */
import { describe, it, expect } from 'vitest';
import { createBrainService, type RawFactRow, type RawRecordRow } from './service';

const NOW = '2026-10-04T12:00:00.000Z';

function makeDeps(over: Partial<Parameters<typeof createBrainService>[0]> = {}) {
  const facts: RawFactRow[] = [];
  let seq = 0;
  const projects: RawRecordRow[] = [{
    id: 'p1', project_id: 'p1', name: 'Midnight Sketch', project_name: 'Midnight Sketch',
    daw_type: 'ableton', role: null, file_type: null, bpm: null, key_note: null,
    status: 'synced', modified_at: '2026-06-22T10:00:00.000Z',
  }];
  const files: RawRecordRow[] = [
    { id: 'f1', project_id: 'p1', name: 'vocal take 3.wav', project_name: 'Midnight Sketch',
      daw_type: 'ableton', role: 'stem', file_type: 'wav', bpm: 128, key_note: 'Am',
      status: 'synced', modified_at: '2026-06-22T10:00:00.000Z' },
    { id: 'f2', project_id: 'p1', name: 'kick.wav', project_name: 'Midnight Sketch',
      daw_type: 'ableton', role: 'stem', file_type: 'wav', bpm: null, key_note: null,
      status: 'synced', modified_at: '2026-07-01T10:00:00.000Z' },
  ];
  const deps = {
    getRecords: () => ({ projects, files }),
    getFactRows: (pid: string) => facts.filter((f) => f.project_id === pid),
    getBelievedFactRow: (pid: string, key: string) =>
      facts.find((f) => f.project_id === pid && f.key === key && !f.superseded_at) ?? null,
    insertFact: (row: RawFactRow) => { facts.push(row); },
    supersedeFact: (id: string, at: string) => {
      const r = facts.find((f) => f.id === id); if (r) r.superseded_at = at;
    },
    getProjectPackInput: (pid: string) => pid !== 'p1' ? null : ({
      project: { id: 'p1', name: 'Midnight Sketch', dawType: 'ableton', bpm: 128, keyNote: 'Am',
                 syncStatus: 'synced', isAdopted: false, parentVersionId: null },
      files: files.map((f) => ({ id: f.id, name: f.name, role: f.role, fileType: f.file_type, sizeBytes: 1, status: f.status })),
      versions: [{ versionNumber: 1, createdAt: '2026-06-01T00:00:00.000Z', fileCount: 2 }],
      issues: [],
      indexTruth: { tempo: '128' },
    }),
    now: () => NOW,
    newId: () => `fact-${++seq}`,
    ...over,
  };
  return { deps, facts };
}

describe('search', () => {
  it('finds a file across the index and says why', () => {
    const { deps } = makeDeps();
    const r = createBrainService(deps).search('vocal');
    expect(r.hits.map((h) => h.record.id)).toEqual(['f1']);
    expect(r.hits[0].matchedOn.join(' ')).toContain('vocal');
  });

  it('honours field filters and date shorthands together', () => {
    const { deps } = makeDeps();
    const svc = createBrainService(deps);
    // June only — kick.wav is July.
    expect(svc.search('daw:ableton after:june before:june').hits.map((h) => h.record.id))
      .toEqual(['f1', 'p1']);
  });

  it('returns nothing for an empty query rather than the whole index', () => {
    // "Show me something" is not answerable; dumping the index would look
    // like a ranked answer.
    const { deps } = makeDeps();
    const r = createBrainService(deps).search('   ');
    expect(r.empty).toBe(true);
    expect(r.hits).toEqual([]);
  });

  it('groups results by project', () => {
    const { deps } = makeDeps();
    const r = createBrainService(deps).search('wav');
    expect(r.byProject[0]).toMatchObject({ projectId: 'p1', projectName: 'Midnight Sketch' });
  });
});

describe('remember / recall', () => {
  it('stores an attributed stated fact and recalls it', () => {
    const { deps } = makeDeps();
    const svc = createBrainService(deps);
    expect(svc.remember({ projectId: 'p1', key: 'brief', value: 'keep it sparse', kind: 'stated', origin: 'user', producer: 'ui' }))
      .toMatchObject({ ok: true, action: 'insert' });
    const recalled = svc.recall('p1');
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toMatchObject({ key: 'brief', value: 'keep it sparse', kind: 'stated' });
    expect(recalled[0].source).toEqual({ origin: 'user', producer: 'ui' });
  });

  it('is a no-op when nothing changed', () => {
    const { deps, facts } = makeDeps();
    const svc = createBrainService(deps);
    const w = { projectId: 'p1', key: 'tempo', value: '128', kind: 'derived' as const, origin: 'index' as const, producer: 'watcher' };
    svc.remember(w);
    expect(svc.remember(w)).toMatchObject({ action: 'noop' });
    expect(facts).toHaveLength(1);
  });

  it('supersedes rather than overwriting, keeping the history', () => {
    const { deps, facts } = makeDeps();
    const svc = createBrainService(deps);
    svc.remember({ projectId: 'p1', key: 'tempo', value: '128', kind: 'derived', origin: 'index', producer: 'watcher' });
    expect(svc.remember({ projectId: 'p1', key: 'tempo', value: '140', kind: 'derived', origin: 'index', producer: 'watcher' }))
      .toMatchObject({ action: 'supersede' });
    expect(facts).toHaveLength(2);
    expect(facts.filter((f) => !f.superseded_at)).toHaveLength(1);
    expect(svc.recall('p1')[0].value).toBe('140');
  });

  it('refuses an agent-minted derived fact', () => {
    // The whole point of the derived/stated split: a model cannot write
    // something the brain will then repeat as ground truth.
    const { deps } = makeDeps();
    const r = createBrainService(deps).remember({
      projectId: 'p1', key: 'tempo', value: '999', kind: 'derived', origin: 'agent', producer: 'copilot',
    });
    expect(r).toMatchObject({ ok: false, action: 'reject' });
    expect(r.reason).toMatch(/must originate from 'index'/);
  });

  it('refuses to let a derived observation erase a stated fact', () => {
    const { deps } = makeDeps();
    const svc = createBrainService(deps);
    svc.remember({ projectId: 'p1', key: 'vibe', value: 'sparse', kind: 'stated', origin: 'user', producer: 'ui' });
    expect(svc.remember({ projectId: 'p1', key: 'vibe', value: 'busy', kind: 'derived', origin: 'index', producer: 'watcher' }))
      .toMatchObject({ ok: false, action: 'reject' });
    expect(svc.recall('p1')[0].value).toBe('sparse');
  });
});

describe('context pack', () => {
  it('returns an attributed, bounded pack with a summary', () => {
    const { deps } = makeDeps();
    const svc = createBrainService(deps);
    svc.remember({ projectId: 'p1', key: 'brief', value: 'sparse', kind: 'stated', origin: 'user', producer: 'ui' });
    const out = svc.contextPack('p1')!;
    expect(out.pack.schema).toBe('wavi.context/1');
    expect(out.pack.facts[0]).toMatchObject({ key: 'brief', origin: 'user:ui' });
    expect(out.summary).toContain('Midnight Sketch');
  });

  it('lets the index overrule a remembered derived fact', () => {
    const { deps } = makeDeps();
    const svc = createBrainService(deps);
    svc.remember({ projectId: 'p1', key: 'tempo', value: '95', kind: 'derived', origin: 'index', producer: 'watcher' });
    const out = svc.contextPack('p1')!;   // indexTruth says tempo is 128
    expect(out.pack.facts.find((f) => f.key === 'tempo')).toBeUndefined();
    expect(out.pack.issues.some((i) => i.kind === 'stale-fact')).toBe(true);
  });

  it('returns null for an unknown project instead of an empty pack', () => {
    const { deps } = makeDeps();
    expect(createBrainService(deps).contextPack('nope')).toBeNull();
  });

  it('never emits a filesystem path', () => {
    const { deps } = makeDeps();
    const out = createBrainService(deps).contextPack('p1')!;
    expect(JSON.stringify(out)).not.toMatch(/\/Users\//);
  });
});
