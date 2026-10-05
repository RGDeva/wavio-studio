/**
 * Project Brain — staying current from live watcher events.
 *
 * The properties that make it safe to call this on EVERY file event: a burst
 * collapses to one recompute, a recompute that finds nothing writes nothing,
 * one project cannot starve another, and a failure never escapes into the
 * watcher's ingestion path.
 *
 * Timing is driven by an injected scheduler, so these run instantly and
 * deterministically rather than waiting on real timers.
 */
import { describe, it, expect } from 'vitest';
import { createBrainRefresher, planRefreshBatch, type RefresherDeps } from './liveRefresh';
import type { DeriveFile } from './derive';
import type { ProjectFact } from './memory';

const T0 = '2026-10-05T12:00:00.000Z';

/** A controllable clock + scheduler. */
function harness(overrides: Partial<RefresherDeps> = {}) {
  let nowMs = Date.parse(T0);
  const queue: Array<{ fn: () => void; at: number }> = [];
  const facts: Array<ProjectFact> = [];
  let seq = 0;
  const derives: Record<string, DeriveFile[]> = {
    p1: [{ id: 'f1', name: 'master-v1.wav', role: 'audio', fileType: 'wav', sizeBytes: 1, modifiedAt: T0, localStatus: 'present', syncStatus: 'synced', checksum: null }],
    p2: [{ id: 'f9', name: 'kick.wav', role: 'audio', fileType: 'wav', sizeBytes: 1, modifiedAt: T0, localStatus: 'present', syncStatus: 'synced', checksum: null }],
  };

  const deps: RefresherDeps = {
    getDeriveInput: (projectId) => derives[projectId]
      ? { projectName: projectId, dawType: 'ableton', files: derives[projectId], versions: [], lastActivityAt: null }
      : null,
    getBelievedFact: (projectId, key) =>
      facts.find((f) => f.projectId === projectId && f.key === key && !f.supersededAt) ?? null,
    insertFact: (f) => { facts.push({ ...f, supersededAt: null } as ProjectFact); },
    supersedeFact: (id, at) => { const r = facts.find((f) => f.id === id); if (r) r.supersededAt = at; },
    newId: () => `fact-${++seq}`,
    now: () => new Date(nowMs).toISOString(),
    schedule: (fn, ms) => { const h = { fn, at: nowMs + ms }; queue.push(h); return h; },
    cancel: (h) => { const i = queue.indexOf(h as any); if (i >= 0) queue.splice(i, 1); },
    ...overrides,
  };

  return {
    deps, facts, derives,
    advance(ms: number) {
      nowMs += ms;
      const due = queue.filter((q) => q.at <= nowMs);
      for (const d of due) { queue.splice(queue.indexOf(d), 1); d.fn(); }
    },
    pendingTimers: () => queue.length,
    setFiles(projectId: string, files: DeriveFile[]) { derives[projectId] = files; },
    believed: () => facts.filter((f) => !f.supersededAt),
  };
}

describe('planRefreshBatch', () => {
  it('refreshes the longest-waiting project first', () => {
    // Otherwise a project that has been waiting can be perpetually overtaken
    // by newer activity.
    const plan = planRefreshBatch([
      { projectId: 'new', markedAt: '2026-10-05T12:00:10.000Z', lastRefreshedAt: null },
      { projectId: 'old', markedAt: '2026-10-05T12:00:00.000Z', lastRefreshedAt: null },
    ], T0, { minIntervalMs: 0, maxPerBatch: 10 });
    expect(plan.flush).toEqual(['old', 'new']);
  });

  it('defers a project refreshed too recently, without dropping it', () => {
    const plan = planRefreshBatch(
      [{ projectId: 'p1', markedAt: T0, lastRefreshedAt: '2026-10-05T11:59:55.000Z' }],
      T0, { minIntervalMs: 15_000, maxPerBatch: 10 });
    expect(plan.flush).toEqual([]);
    expect(plan.deferred).toEqual(['p1']);
  });

  it('caps a batch so one storm cannot monopolise a flush', () => {
    const dirty = Array.from({ length: 10 }, (_, i) => ({ projectId: `p${i}`, markedAt: T0, lastRefreshedAt: null }));
    const plan = planRefreshBatch(dirty, T0, { minIntervalMs: 0, maxPerBatch: 3 });
    expect(plan.flush).toHaveLength(3);
    expect(plan.deferred).toHaveLength(7);
  });

  it('applies the floor per project, so a busy project cannot starve a quiet one', () => {
    const plan = planRefreshBatch([
      { projectId: 'busy', markedAt: T0, lastRefreshedAt: T0 },
      { projectId: 'quiet', markedAt: T0, lastRefreshedAt: null },
    ], T0, { minIntervalMs: 15_000, maxPerBatch: 10 });
    expect(plan.flush).toEqual(['quiet']);
    expect(plan.deferred).toEqual(['busy']);
  });
});

describe('coalescing a burst', () => {
  it('collapses many events in one project into a single recompute', () => {
    // A DAW save touches dozens of files; recomputing per event would storm
    // both the CPU and the append-only store.
    let derives = 0;
    const h = harness();
    const spy: RefresherDeps = { ...h.deps, getDeriveInput: (id) => { derives++; return h.deps.getDeriveInput(id); } };
    const r = createBrainRefresher(spy, { debounceMs: 5_000, minIntervalMs: 0 });

    for (let i = 0; i < 50; i++) r.markDirty('p1');
    expect(derives).toBe(0);          // nothing yet — still coalescing
    expect(r.pendingCount()).toBe(1); // 50 events, one dirty project

    h.advance(5_000);
    expect(derives).toBe(1);
    expect(r.pendingCount()).toBe(0);
  });

  it('does not arm a second timer while one is pending', () => {
    const h = harness();
    const r = createBrainRefresher(h.deps, { debounceMs: 5_000 });
    r.markDirty('p1'); r.markDirty('p2'); r.markDirty('p1');
    expect(h.pendingTimers()).toBe(1);
  });

  it('ignores a null or empty project id', () => {
    const h = harness();
    const r = createBrainRefresher(h.deps, {});
    r.markDirty(null); r.markDirty(undefined); r.markDirty('');
    expect(r.pendingCount()).toBe(0);
    expect(h.pendingTimers()).toBe(0);
  });
});

describe('only genuine changes are written', () => {
  it('writes facts on the first refresh', () => {
    const h = harness();
    const r = createBrainRefresher(h.deps, { debounceMs: 1_000, minIntervalMs: 0 });
    r.markDirty('p1');
    h.advance(1_000);
    expect(h.believed().length).toBeGreaterThan(0);
    expect(h.believed().every((f) => f.kind === 'derived' && f.source.origin === 'index')).toBe(true);
  });

  it('writes NOTHING when a recompute finds no change', () => {
    // This is what makes it safe for the watcher to over-notify.
    const h = harness();
    const r = createBrainRefresher(h.deps, { debounceMs: 1_000, minIntervalMs: 0 });
    r.markDirty('p1');
    h.advance(1_000);
    const afterFirst = h.facts.length;
    r.markDirty('p1');
    h.advance(1_000);
    expect(h.facts.length).toBe(afterFirst);
  });

  it('supersedes only the fact whose value actually moved', () => {
    const h = harness();
    const r = createBrainRefresher(h.deps, { debounceMs: 1_000, minIntervalMs: 0 });
    r.markDirty('p1');
    h.advance(1_000);
    const before = h.believed().length;

    // One more file: present/file counts change, source-daw does not.
    h.setFiles('p1', [
      ...h.derives.p1,
      { id: 'f2', name: 'vocal.wav', role: 'audio', fileType: 'wav', sizeBytes: 1, modifiedAt: T0, localStatus: 'present', syncStatus: 'synced', checksum: null },
    ]);
    r.markDirty('p1');
    h.advance(1_000);

    expect(h.believed().length).toBe(before);           // same keys believed
    expect(h.facts.length).toBeGreaterThan(before);     // history retained
    const daw = h.believed().filter((f) => f.key === 'source-daw');
    expect(daw).toHaveLength(1);                        // unchanged, not rewritten
    expect(h.believed().find((f) => f.key === 'file-count')!.value).toBe('2');
  });

  it('reflects a deleted file as missing rather than forgetting it', () => {
    const h = harness();
    const r = createBrainRefresher(h.deps, { debounceMs: 1_000, minIntervalMs: 0 });
    r.markDirty('p1'); h.advance(1_000);

    h.setFiles('p1', [{ ...h.derives.p1[0], localStatus: 'missing' }]);
    r.markDirty('p1'); h.advance(1_000);

    expect(h.believed().find((f) => f.key === 'missing-file-count')!.value).toBe('1');
    expect(h.believed().find((f) => f.key === 'present-file-count')!.value).toBe('0');
  });
});

describe('resilience', () => {
  it('a failing project never breaks the others, and never throws', () => {
    // Refreshing memory is secondary to indexing the file; it must not reach
    // the watcher's ingestion path.
    const h = harness();
    const deps: RefresherDeps = {
      ...h.deps,
      getDeriveInput: (id) => { if (id === 'bad') throw new Error('boom'); return h.deps.getDeriveInput(id); },
    };
    const r = createBrainRefresher(deps, { debounceMs: 1_000, minIntervalMs: 0 });
    r.markDirty('bad'); r.markDirty('p1');
    expect(() => h.advance(1_000)).not.toThrow();
    expect(h.believed().some((f) => f.projectId === 'p1')).toBe(true);
  });

  it('an unknown project is skipped quietly', () => {
    const h = harness();
    const r = createBrainRefresher(h.deps, { debounceMs: 1_000, minIntervalMs: 0 });
    r.markDirty('ghost');
    h.advance(1_000);
    expect(h.facts).toHaveLength(0);
  });

  it('re-arms so deferred projects are not stranded', () => {
    const h = harness();
    const r = createBrainRefresher(h.deps, { debounceMs: 1_000, minIntervalMs: 0, maxPerBatch: 1 });
    r.markDirty('p1'); r.markDirty('p2');
    h.advance(1_000);
    expect(r.pendingCount()).toBe(1);   // one deferred
    expect(h.pendingTimers()).toBe(1);  // and re-armed
    h.advance(1_000);
    expect(r.pendingCount()).toBe(0);
  });

  it('stop() cancels pending work and ignores later events', () => {
    const h = harness();
    const r = createBrainRefresher(h.deps, { debounceMs: 1_000 });
    r.markDirty('p1');
    r.stop();
    expect(h.pendingTimers()).toBe(0);
    r.markDirty('p1');
    expect(r.pendingCount()).toBe(0);
    h.advance(10_000);
    expect(h.facts).toHaveLength(0);
  });
});

describe('manual rescan bypasses the throttle', () => {
  it('forceRefresh ignores the per-project floor', () => {
    // A user clicking Rescan is asking explicitly; making them wait out a
    // debounce they cannot see would look broken.
    const h = harness();
    const r = createBrainRefresher(h.deps, { debounceMs: 1_000, minIntervalMs: 60_000 });
    r.markDirty('p1'); h.advance(1_000);
    const before = h.facts.length;

    h.setFiles('p1', []);
    expect(r.forceRefresh('p1')).toBeGreaterThan(0);
    expect(h.facts.length).toBeGreaterThan(before);
    expect(h.believed().find((f) => f.key === 'file-count')!.value).toBe('0');
  });

  it('flushNow runs the pending batch immediately', () => {
    const h = harness();
    const r = createBrainRefresher(h.deps, { debounceMs: 60_000, minIntervalMs: 0 });
    r.markDirty('p1');
    const out = r.flushNow();
    expect(out.refreshed).toEqual(['p1']);
    expect(h.pendingTimers()).toBe(0);
  });
});
