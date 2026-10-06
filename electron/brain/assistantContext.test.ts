/**
 * The canonical assistant context boundary.
 *
 * These test SELECTION, not prose: which records the brain hands over for a
 * given question, and how each is attributed. A model later renders this; it
 * must never be what decides it.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAssistantContext, selectMemory, scoreMemory, detectConflicts,
  reconcileInferences, CONTEXT_LIMITS,
  type ContextMemory, type AssistantContextInput,
} from './assistantContext';
import type { Inference } from './derive';

const NOW = '2026-10-06T12:00:00.000Z';

function mem(over: Partial<ContextMemory> & { key: string; value: string }): ContextMemory {
  return {
    category: 'note', scope: 'global', origin: 'user', producer: 'ui',
    observedAt: '2026-10-01T00:00:00.000Z', ...over,
  };
}

const EXPORT_PREF = mem({ key: 'vocal-export', value: 'I usually export vocals into Bounces' });
const COLLAB_PREF = mem({ key: 'collaborator', value: 'I prefer FL Studio for collaborations' });
const MASTERING = mem({ key: 'mastering-note', value: 'leave headroom for the mastering engineer' });
const SUNSHINE_REF = mem({ key: 'reference', value: 'Reference mix is sunshine-ref.wav', scope: 'project' });

function input(over: Partial<AssistantContextInput> = {}): AssistantContextInput {
  return {
    query: '',
    project: { id: 'p-sun', name: 'Sunshine', dawType: 'fl-studio' },
    memory: [], facts: [], inferences: [], files: [], versions: [], recentActivity: [],
    now: NOW, ...over,
  };
}

describe('deterministic relevance — not every memory for every request', () => {
  const all = [EXPORT_PREF, COLLAB_PREF, MASTERING];

  it('"Where do I usually export vocals?" selects the export note only', () => {
    const picked = selectMemory(all, 'Where do I usually export vocals?', 8);
    expect(picked.map((p) => p.value.key)).toEqual(['vocal-export']);
    expect(picked[0].matchedOn).toEqual(expect.arrayContaining(['export', 'vocals']));
  });

  it('"Which DAW do I usually use?" does not return the export note', () => {
    const picked = selectMemory(all, 'Which DAW do I usually use for collaborations?', 8);
    expect(picked.map((p) => p.value.key)).toEqual(['collaborator']);
  });

  it('"What do I normally do when sharing demos?" returns nothing rather than guessing', () => {
    // No memory lexically matches; inventing relevance would hand the model
    // an unrelated note to answer from.
    expect(selectMemory(all, 'sharing demos', 8)).toEqual([]);
  });

  it('a broad question with no matches falls back to recency, not emptiness', () => {
    // "What do you remember?" is a real question.
    const picked = selectMemory(all, '', 8);
    expect(picked).toHaveLength(3);
  });

  it('matches a term inside a longer word', () => {
    const m = mem({ key: 'k', value: 'vocals are exported nightly' });
    expect(scoreMemory(m, ['export']).score).toBeGreaterThan(0);
  });

  it('ranking is stable regardless of input order', () => {
    const a = selectMemory(all, 'export vocals', 8).map((p) => p.value.key);
    const b = selectMemory([...all].reverse(), 'export vocals', 8).map((p) => p.value.key);
    expect(b).toEqual(a);
  });
});

describe('scope isolation', () => {
  it('project memory is offered before global, and Faith never appears in Sunshine', () => {
    const picked = selectMemory([SUNSHINE_REF, COLLAB_PREF], 'reference mix', 8);
    expect(picked[0].value.scope).toBe('project');
    // Faith's memory was never passed in — isolation happens at the query
    // layer; this asserts the builder does not invent cross-project items.
    expect(picked.every((p) => p.value.key !== 'faith-reference')).toBe(true);
  });

  it('caps each scope independently', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      mem({ key: `g${i}`, value: 'vocals', scope: i % 2 ? 'project' : 'global' }));
    const picked = selectMemory(many, 'vocals', 3);
    expect(picked.filter((p) => p.value.scope === 'global')).toHaveLength(3);
    expect(picked.filter((p) => p.value.scope === 'project')).toHaveLength(3);
  });
});

describe('conflict semantics', () => {
  it('the index wins for current file state, but the statement is kept', () => {
    // Stated "master-v7 is latest"; the index now observes master-v8.
    const memory = selectMemory([mem({ key: 'latest-master', value: 'master-v7.wav' })], '', 8);
    const conflicts = detectConflicts(memory, [{ key: 'latest-master', value: 'master-v8.wav' }]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      statedValue: 'master-v7.wav', indexValue: 'master-v8.wav', authoritative: 'index',
    });
    // Kept, not dropped — the caller can explain the discrepancy.
    expect(memory).toHaveLength(1);
  });

  it('a preference and a project fact are NOT treated as a conflict', () => {
    // "I prefer FL Studio for collaborations" vs "this project is Ableton" are
    // different claims about different things. Comparing across categories
    // would invent a disagreement.
    const memory = selectMemory([COLLAB_PREF], '', 8);
    const conflicts = detectConflicts(memory, [{ key: 'source-daw', value: 'ableton' }]);
    expect(conflicts).toEqual([]);
  });

  it('only the SAME key is comparable', () => {
    const memory = selectMemory([mem({ key: 'reference', value: 'a.wav' })], '', 8);
    expect(detectConflicts(memory, [{ key: 'file-count', value: '4' }])).toEqual([]);
  });

  it('an explicit statement takes precedence over an inference about the same thing', () => {
    const inf: Inference = {
      key: 'likely-master', value: 'mix-final.wav',
      evidence: 'only master-like file', strength: 'strong',
    };
    const stated = selectMemory([mem({ key: 'likely-master', value: 'master-approved.wav' })], '', 8);
    const out = reconcileInferences([inf], stated);
    expect(out[0].attribution.evidence).toMatch(/takes precedence/);
    // The inference is still present with its evidence — not deleted.
    expect(out[0].value.value).toBe('mix-final.wav');
  });

  it('an inference with no competing statement is untouched', () => {
    const inf: Inference = { key: 'likely-master', value: 'master-v8.wav', evidence: 'highest version', strength: 'strong' };
    const out = reconcileInferences([inf], []);
    expect(out[0].attribution.evidence).toBe('highest version');
  });
});

describe('provenance stays structured', () => {
  it('distinguishes stated, derived and inferred', () => {
    const ctx = buildAssistantContext(input({
      memory: [EXPORT_PREF],
      facts: [{ key: 'source-daw', value: 'fl-studio' }],
      inferences: [{ key: 'likely-master', value: 'master-v8.wav', evidence: 'highest version', strength: 'strong' }],
    }));
    expect(ctx.userMemory[0].attribution).toMatchObject({ kind: 'stated', origin: 'user', scope: 'global' });
    expect(ctx.facts[0].attribution).toMatchObject({ kind: 'derived', origin: 'index', producer: 'watcher' });
    expect(ctx.inferences[0].attribution).toMatchObject({ kind: 'inferred', strength: 'strong' });
  });

  it('keeps attribution as fields, not a flattened sentence', () => {
    const ctx = buildAssistantContext(input({ memory: [EXPORT_PREF] }));
    expect(typeof ctx.userMemory[0].attribution).toBe('object');
    expect(ctx.userMemory[0].attribution.kind).toBe('stated');
  });

  it('labels an agent-recorded memory distinctly from the user', () => {
    const ctx = buildAssistantContext(input({ memory: [mem({ key: 'k', value: 'v', origin: 'agent', producer: 'copilot' })] }));
    expect(ctx.userMemory[0].attribution.origin).toBe('agent');
  });
});

describe('context limits', () => {
  it('a 25,000-file library does not become 25,000 context records', () => {
    const files = Array.from({ length: 25_000 }, (_, i) => ({
      id: `f${i}`, name: `take-${i}.wav`, role: 'audio', status: 'synced',
      modifiedAt: `2026-0${(i % 9) + 1}-01T00:00:00.000Z`,
    }));
    const ctx = buildAssistantContext(input({ files }));
    expect(ctx.files.length).toBeLessThanOrEqual(CONTEXT_LIMITS.files);
    expect(ctx.truncation.truncated).toBe(true);
    expect(ctx.truncation.dropped.files).toBe(25_000 - ctx.files.length);
  });

  it('caps every category and says what it dropped', () => {
    const ctx = buildAssistantContext(input({
      memory: Array.from({ length: 30 }, (_, i) => mem({ key: `k${i}`, value: 'x' })),
      facts: Array.from({ length: 50 }, (_, i) => ({ key: `f${i}`, value: 'v' })),
      versions: Array.from({ length: 20 }, (_, i) => ({ versionNumber: i, createdAt: NOW, fileCount: 1 })),
      recentActivity: Array.from({ length: 40 }, (_, i) => ({ type: 't', message: `m${i}`, at: NOW })),
    }));
    expect(ctx.userMemory.length).toBeLessThanOrEqual(CONTEXT_LIMITS.memoriesPerScope * 2);
    expect(ctx.facts).toHaveLength(CONTEXT_LIMITS.facts);
    expect(ctx.versions).toHaveLength(CONTEXT_LIMITS.versions);
    expect(ctx.recentActivity).toHaveLength(CONTEXT_LIMITS.activityEvents);
    expect(ctx.truncation.notes.length).toBeGreaterThan(0);
  });

  it('limits are overridable but named by default', () => {
    const ctx = buildAssistantContext(input({ files: Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, name: `a${i}.wav`, role: null, status: null, modifiedAt: null })), limits: { files: 2 } }));
    expect(ctx.files).toHaveLength(2);
  });

  it('a small library is not marked truncated', () => {
    const ctx = buildAssistantContext(input({ memory: [EXPORT_PREF] }));
    expect(ctx.truncation.truncated).toBe(false);
  });
});

describe('safety', () => {
  it('carries no filesystem path, token or DID', () => {
    const ctx = buildAssistantContext(input({
      memory: [EXPORT_PREF, SUNSHINE_REF],
      files: [{ id: 'f1', name: 'vocal.wav', role: 'audio', status: 'synced', modifiedAt: NOW }],
    }));
    const json = JSON.stringify(ctx);
    expect(json).not.toMatch(/\/Users\//);
    expect(json).not.toMatch(/Bearer |did:privy:|wv_[A-Za-z0-9]{16,}/);
  });

  it('is deterministic for identical input', () => {
    const args = input({ memory: [EXPORT_PREF, COLLAB_PREF], query: 'vocals' });
    expect(JSON.stringify(buildAssistantContext(args))).toBe(JSON.stringify(buildAssistantContext(args)));
  });
});
