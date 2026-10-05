/**
 * Migrating the legacy electron-store memory into project_facts.
 *
 * A migration that loses user data is worse than no migration, so these
 * defend the safety rules rather than the happy path: idempotent, never
 * destructive, never overwriting something newer, and never fatal on junk.
 */
import { describe, it, expect } from 'vitest';
import { planLegacyMemoryMigration, LEGACY_PRODUCER, type ExistingFact } from './legacyMemoryMigration';

const NOW = '2026-10-05T12:00:00.000Z';
const none = new Map<string, ExistingFact>();

function existing(over: Partial<ExistingFact> & { key: string }): Map<string, ExistingFact> {
  return new Map([[over.key, {
    id: 'e1', kind: 'stated', value: 'old', observedAt: '2026-09-01T00:00:00.000Z', ...over,
  }]]);
}

describe('reading the legacy blob', () => {
  it('migrates the modern object form with its category and timestamp', () => {
    const plan = planLegacyMemoryMigration({
      last_chat: { value: 'hello', category: 'context', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
    }, none, NOW);
    expect(plan.willWrite).toBe(1);
    const a = plan.actions[0];
    expect(a.action).toBe('insert');
    expect(a.action !== 'skip' && a.fact).toMatchObject({
      key: 'last_chat', value: 'hello', kind: 'stated', projectId: null,
      observedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('migrates the older bare-string form too', () => {
    // The legacy store held plain strings before it gained metadata; those are
    // still real user memory and must not be dropped.
    const plan = planLegacyMemoryMigration({ note: 'a bare string' }, none, NOW);
    expect(plan.willWrite).toBe(1);
    const a = plan.actions[0];
    expect(a.action !== 'skip' && a.fact.value).toBe('a bare string');
    expect(a.action !== 'skip' && a.fact.observedAt).toBe(NOW); // no timestamp to carry
  });

  it('records every entry as EXPLICIT user memory, never derived', () => {
    // A person typed this. Collapsing it into derived facts would make a human
    // assertion indistinguishable from something the watcher computed.
    const plan = planLegacyMemoryMigration({ a: 'x', b: 'y' }, none, NOW);
    for (const act of plan.actions) {
      expect(act.action !== 'skip' && act.fact.kind).toBe('stated');
      expect(act.action !== 'skip' && act.fact.source).toEqual({ origin: 'user', producer: LEGACY_PRODUCER });
    }
  });

  it('scopes migrated entries as GLOBAL, not to some arbitrary project', () => {
    const plan = planLegacyMemoryMigration({ a: 'x' }, none, NOW);
    expect(plan.actions[0].action !== 'skip' && plan.actions[0].fact.projectId).toBeNull();
  });
});

describe('malformed legacy data fails safely', () => {
  it('skips unreadable values without throwing or writing', () => {
    const plan = planLegacyMemoryMigration({
      good: 'fine',
      numeric: 12345,
      nested: { noValueField: true },
      nulled: null,
      arr: [1, 2],
    } as any, none, NOW);
    expect(plan.willWrite).toBe(1);
    expect(plan.skipped.map((s) => s.key).sort()).toEqual(['arr', 'nested', 'nulled', 'numeric']);
    for (const s of plan.skipped) expect(s.reason).toBe('unreadable legacy value');
  });

  it('skips an empty key', () => {
    const plan = planLegacyMemoryMigration({ '   ': 'x' }, none, NOW);
    expect(plan.willWrite).toBe(0);
    expect(plan.skipped[0].reason).toBe('empty key');
  });

  it('treats a missing or non-object blob as nothing to do', () => {
    expect(planLegacyMemoryMigration(null, none, NOW).actions).toEqual([]);
    expect(planLegacyMemoryMigration(undefined, none, NOW).actions).toEqual([]);
    expect(planLegacyMemoryMigration('not an object' as any, none, NOW).actions).toEqual([]);
  });
});

describe('idempotence', () => {
  it('a second run writes nothing when the value already matches', () => {
    const legacy = { note: { value: 'keep it sparse', category: 'note', updatedAt: '2026-02-01T00:00:00.000Z' } };
    const after = existing({ key: 'note', value: 'keep it sparse', observedAt: '2026-02-01T00:00:00.000Z' });
    const plan = planLegacyMemoryMigration(legacy, after, NOW);
    expect(plan.willWrite).toBe(0);
    expect(plan.skipped[0].reason).toBe('already present with the same value');
  });

  it('is deterministic — same input, same plan', () => {
    const legacy = { b: 'two', a: 'one', c: 'three' };
    const p1 = JSON.stringify(planLegacyMemoryMigration(legacy, none, NOW));
    const p2 = JSON.stringify(planLegacyMemoryMigration(legacy, none, NOW));
    expect(p1).toBe(p2);
    // and ordered by key, so a plan is reviewable
    expect(planLegacyMemoryMigration(legacy, none, NOW).actions.map((a) => a.key)).toEqual(['a', 'b', 'c']);
  });
});

describe('never overwrites something stronger or newer', () => {
  it('skips when Project Brain already has a NEWER record', () => {
    // By then the legacy blob is the stale copy.
    const legacy = { note: { value: 'old idea', updatedAt: '2026-01-01T00:00:00.000Z' } };
    const newer = existing({ key: 'note', value: 'current idea', observedAt: '2026-06-01T00:00:00.000Z' });
    const plan = planLegacyMemoryMigration(legacy, newer, NOW);
    expect(plan.willWrite).toBe(0);
    expect(plan.skipped[0].reason).toBe('a newer Project Brain record already exists');
  });

  it('supersedes when the legacy entry is genuinely newer', () => {
    const legacy = { note: { value: 'newer idea', updatedAt: '2026-06-01T00:00:00.000Z' } };
    const older = existing({ key: 'note', value: 'stale', observedAt: '2026-01-01T00:00:00.000Z' });
    const plan = planLegacyMemoryMigration(legacy, older, NOW);
    const a = plan.actions[0];
    expect(a.action).toBe('supersede');
    expect(a.action === 'supersede' && a.supersedeId).toBe('e1');
  });

  it('refuses to overwrite a DERIVED fact with user memory', () => {
    // Two different kinds of claim; the index would recompute it anyway.
    const legacy = { 'file-count': 'nine' };
    const derived = existing({ key: 'file-count', kind: 'derived', value: '4' });
    const plan = planLegacyMemoryMigration(legacy, derived, NOW);
    expect(plan.willWrite).toBe(0);
    expect(plan.skipped[0].reason).toBe('a derived fact already holds this key');
  });
});

describe('the planner is non-destructive by construction', () => {
  it('never proposes deleting anything', () => {
    // The legacy blob stays on disk; the only actions are insert/supersede/skip,
    // and supersede preserves the prior row as history.
    const plan = planLegacyMemoryMigration({ a: 'x', b: 'y' }, existing({ key: 'a', value: 'old' }), NOW);
    for (const act of plan.actions) {
      expect(['insert', 'supersede', 'skip']).toContain(act.action);
    }
  });
});
