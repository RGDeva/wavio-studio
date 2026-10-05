/**
 * Project Brain — memory and the context pack.
 *
 * The rule being defended throughout: deterministic local state is the source
 * of truth. A model (or a stale observation) must never be able to write
 * something that the brain then repeats as fact.
 */
import { describe, it, expect } from 'vitest';
import {
  validateFact, planFactWrite, reconcileWithIndex, believedFacts,
  MAX_FACT_VALUE_BYTES, type ProjectFact, type FactInput,
} from './memory';
import { buildContextPack, summarizePack, DEFAULT_BUDGET, type PackFile } from './contextPack';

const NOW = '2026-10-04T12:00:00.000Z';

function fact(over: Partial<ProjectFact> & { id: string }): ProjectFact {
  return {
    projectId: 'p1', key: 'tempo', value: '128', kind: 'derived',
    source: { origin: 'index', producer: 'watcher' },
    observedAt: '2026-10-01T00:00:00.000Z', supersededAt: null,
    ...over,
  };
}
function input(over: Partial<FactInput> = {}): FactInput {
  return {
    projectId: 'p1', key: 'tempo', value: '128', kind: 'derived',
    source: { origin: 'index', producer: 'watcher' }, observedAt: NOW,
    ...over,
  };
}

describe('a fact must be attributable, scoped and bounded', () => {
  it('accepts a well-formed fact', () => {
    expect(validateFact(input())).toEqual({ ok: true });
  });

  it('rejects an unscoped or unkeyed fact', () => {
    expect(validateFact(input({ projectId: '' })).ok).toBe(false);
    expect(validateFact(input({ key: '   ' })).ok).toBe(false);
  });

  it('rejects a fact with no provenance', () => {
    // An unattributed fact cannot be judged later, so it is not a fact.
    expect(validateFact({ ...input(), source: undefined as any }).ok).toBe(false);
    expect(validateFact({ ...input(), source: { origin: 'agent', producer: '' } as any }).ok).toBe(false);
  });

  it('refuses to let an agent mint a DERIVED fact', () => {
    // Derived means "recomputable from local state". Letting an agent claim it
    // would smuggle an opinion in as ground truth.
    const r = validateFact(input({ kind: 'derived', source: { origin: 'agent', producer: 'copilot' } }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/must originate from 'index'/);
  });

  it('refuses to let a STATED fact claim the index as its origin', () => {
    const r = validateFact(input({ kind: 'stated', source: { origin: 'index', producer: 'watcher' } }));
    expect(r.ok).toBe(false);
  });

  it('caps the value so one write cannot crowd out a context pack', () => {
    expect(validateFact(input({ value: 'x'.repeat(MAX_FACT_VALUE_BYTES + 1) })).ok).toBe(false);
  });
});

describe('writes are append-only and idempotent', () => {
  it('inserts when nothing is believed yet', () => {
    expect(planFactWrite(null, input(), NOW)).toMatchObject({ action: 'insert' });
  });

  it('is a no-op when the value has not changed', () => {
    // The watcher re-derives constantly; recording "still 128 BPM" thousands
    // of times would bury the moments that actually changed.
    const plan = planFactWrite(fact({ id: 'f1', value: '128' }), input({ value: '128' }), NOW);
    expect(plan).toMatchObject({ action: 'noop' });
  });

  it('supersedes rather than overwrites when the value changes', () => {
    const plan = planFactWrite(fact({ id: 'f1', value: '128' }), input({ value: '140' }), NOW);
    expect(plan).toMatchObject({ action: 'supersede', supersedeId: 'f1', supersededAt: NOW });
  });

  it('will not let a derived observation overwrite something a person said', () => {
    // The index owns derived keys; it does not get to erase human knowledge.
    const stated = fact({ id: 'f1', kind: 'stated', value: 'client wants it brighter',
      source: { origin: 'user', producer: 'ui' } });
    const plan = planFactWrite(stated, input({ kind: 'derived', value: '128' }), NOW);
    expect(plan).toMatchObject({ action: 'reject' });
  });

  it('rejects an invalid write before touching history', () => {
    expect(planFactWrite(null, input({ projectId: '' }), NOW)).toMatchObject({ action: 'reject' });
  });

  it('treats a superseded row as absent', () => {
    const old = fact({ id: 'f1', supersededAt: '2026-09-01T00:00:00.000Z' });
    expect(planFactWrite(old, input(), NOW)).toMatchObject({ action: 'insert' });
  });
});

describe('the index wins over remembered derived facts', () => {
  it('marks a derived fact stale when it disagrees with local state', () => {
    const r = reconcileWithIndex([fact({ id: 'f1', key: 'tempo', value: '128' })], { tempo: '140' });
    expect(r.current).toHaveLength(0);
    expect(r.stale[0].indexValue).toBe('140');
    expect(r.stale[0].reason).toContain('140');
  });

  it('keeps a derived fact the index agrees with', () => {
    const r = reconcileWithIndex([fact({ id: 'f1', value: '128' })], { tempo: '128' });
    expect(r.current).toHaveLength(1);
    expect(r.stale).toHaveLength(0);
  });

  it('never marks a STATED fact stale — the index has no view on an opinion', () => {
    // Doing so would quietly delete human knowledge the index cannot hold.
    const stated = fact({ id: 'f1', key: 'brief', value: 'keep it sparse', kind: 'stated',
      source: { origin: 'user', producer: 'ui' } });
    const r = reconcileWithIndex([stated], { brief: 'something else' });
    expect(r.current).toHaveLength(1);
    expect(r.stale).toHaveLength(0);
  });

  it('keeps a derived fact whose key the index says nothing about', () => {
    const r = reconcileWithIndex([fact({ id: 'f1', key: 'unheard-of' })], { tempo: '128' });
    expect(r.current).toHaveLength(1);
  });

  it('orders believed facts deterministically', () => {
    const a = fact({ id: 'a', key: 'b', observedAt: '2026-10-01T00:00:00.000Z' });
    const b = fact({ id: 'b', key: 'a', observedAt: '2026-10-01T00:00:00.000Z' });
    expect(believedFacts([a, b]).map((f) => f.id)).toEqual(believedFacts([b, a]).map((f) => f.id));
  });
});

// ── Context pack ────────────────────────────────────────────────────────────

const project = {
  id: 'p1', name: 'Midnight Sketch', dawType: 'ableton', bpm: 128, keyNote: 'Am',
  syncStatus: 'synced', isAdopted: false, parentVersionId: null,
};
function files(n: number, role: string): PackFile[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${role}-${i}`, name: `${role}-${String(i).padStart(3, '0')}.wav`,
    role, fileType: 'wav', sizeBytes: 1000, status: 'synced',
  }));
}

describe('context pack', () => {
  it('groups files by role and keeps every role represented under a tight budget', () => {
    // A flat truncation would drop whole roles invisibly; keeping some of each
    // preserves the shape of the project.
    const pack = buildContextPack({
      project, versions: [], facts: [],
      files: [...files(50, 'stem'), ...files(3, 'project'), ...files(10, 'bounce')],
      budget: { maxFiles: 9 },
    });
    const roles = pack.filesByRole.map((g) => g.role).sort();
    expect(roles).toEqual(['bounce', 'project', 'stem']);
    expect(pack.filesByRole.reduce((n, g) => n + g.files.length, 0)).toBeLessThanOrEqual(9);
  });

  it('never truncates silently', () => {
    const pack = buildContextPack({ project, versions: [], facts: [], files: files(100, 'stem'), budget: { maxFiles: 5 } });
    expect(pack.truncation.truncated).toBe(true);
    expect(pack.truncation.droppedFiles).toBe(95);
    expect(pack.truncation.notes.join(' ')).toMatch(/omitted/);
    expect(pack.counts.totalFiles).toBe(100);
  });

  it('attributes every fact it carries', () => {
    const pack = buildContextPack({
      project, versions: [], files: [],
      facts: [fact({ id: 'f1', key: 'brief', value: 'sparse', kind: 'stated', source: { origin: 'user', producer: 'ui' } })],
    });
    expect(pack.facts[0]).toMatchObject({ key: 'brief', kind: 'stated', origin: 'user:ui' });
  });

  it('surfaces a stale derived fact as an issue instead of repeating it', () => {
    const pack = buildContextPack({
      project, versions: [], files: [],
      facts: [fact({ id: 'f1', key: 'tempo', value: '128' })],
      indexTruth: { tempo: '140' },
    });
    expect(pack.facts).toHaveLength(0);
    expect(pack.issues.find((i) => i.kind === 'stale-fact')?.detail).toMatch(/index wins/i);
  });

  it('orders versions newest first', () => {
    const pack = buildContextPack({
      project, files: [], facts: [],
      versions: [
        { versionNumber: 1, createdAt: '2026-01-01T00:00:00.000Z', fileCount: 3 },
        { versionNumber: 3, createdAt: '2026-03-01T00:00:00.000Z', fileCount: 5 },
        { versionNumber: 2, createdAt: '2026-02-01T00:00:00.000Z', fileCount: 4 },
      ],
    });
    expect(pack.versions.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
  });

  it('stays within the byte budget and says so', () => {
    const pack = buildContextPack({
      project, versions: [], facts: [], files: files(400, 'stem'),
      budget: { maxFiles: 400, maxBytes: 3000 },
    });
    expect(Buffer.byteLength(JSON.stringify(pack), 'utf8')).toBeLessThanOrEqual(3000);
    expect(pack.truncation.truncated).toBe(true);
  });

  it('leaks no filesystem path or credential', () => {
    // The pack may cross into a model's context.
    const pack = buildContextPack({ project, versions: [], facts: [], files: files(5, 'stem') });
    const json = JSON.stringify(pack);
    expect(json).not.toMatch(/\/Users\//);
    expect(json).not.toMatch(/Bearer|did:privy|wv_[A-Za-z0-9]/);
  });

  it('is deterministic for the same input', () => {
    const args = { project, versions: [], facts: [], files: [...files(20, 'stem'), ...files(5, 'bounce')] };
    expect(JSON.stringify(buildContextPack(args))).toBe(JSON.stringify(buildContextPack(args)));
  });

  it('summarizes without the model having to infer the headline', () => {
    const pack = buildContextPack({ project, versions: [], facts: [], files: files(3, 'stem') });
    const s = summarizePack(pack);
    expect(s).toContain('Midnight Sketch');
    expect(s).toContain('128 BPM');
    expect(s).toContain('3 files');
  });

  it('flags an adopted project and a partial view in the summary', () => {
    const pack = buildContextPack({
      project: { ...project, isAdopted: true, parentVersionId: 'v7' },
      versions: [], facts: [], files: files(100, 'stem'), budget: { maxFiles: 2 },
    });
    expect(summarizePack(pack)).toMatch(/received from a Project Link/);
    expect(summarizePack(pack)).toMatch(/partial view/);
  });

  it('has sane defaults', () => {
    expect(DEFAULT_BUDGET.maxFiles).toBeGreaterThan(0);
    const pack = buildContextPack({ project, versions: [], facts: [], files: files(5, 'stem') });
    expect(pack.truncation.truncated).toBe(false);
    expect(pack.schema).toBe('wavi.context/1');
  });
});
