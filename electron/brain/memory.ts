/**
 * Project Brain — durable, project-scoped memory.
 *
 * Replaces the flat `memory` blob in electron-store, which had no project
 * scope, no provenance, no history and no query beyond an exact key. That is
 * a scratchpad, not a memory: there was no way to ask "where did this come
 * from?" or "is this still true?".
 *
 * Two rules shape everything here.
 *
 * 1. **The index is the source of truth.** A fact is either DERIVED from
 *    deterministic local state (and therefore recomputable, and never allowed
 *    to contradict it) or STATED by a person or agent (and therefore an
 *    opinion that must carry provenance). When a derived fact disagrees with
 *    the index, the index wins and the fact is stale — not the other way
 *    round. Without this a model could write a wrong "fact" once and have the
 *    brain repeat it forever.
 *
 * 2. **Memory is append-only.** Writes supersede rather than overwrite, so
 *    "what did we believe last month, and why did it change?" stays
 *    answerable — the same reasoning that makes project versions immutable.
 *
 * Pure: no I/O, no Electron, no clock. The caller persists the plan.
 */

export type FactKind = 'derived' | 'stated';

/** Where a fact came from. Required — an unattributed fact is not a fact. */
export interface FactSource {
  /** 'index' for derived; 'user' or 'agent' for stated. */
  origin: 'index' | 'user' | 'agent';
  /** What produced it, e.g. 'watcher', 'association-engine', 'copilot'. */
  producer: string;
}

/**
 * Memory scope.
 *
 * `null` means GLOBAL — memory that belongs to the userrather than to one
 * project. The legacy memory:* store was global, and forcing those entries
 * into an arbitrary project would misclassify them, so the scope is modelled
 * honestly instead.
 */
export type MemoryScope = string | null;

export interface ProjectFact {
  id: string;
  projectId: MemoryScope;
  /** Stable identifier, e.g. 'tempo', 'arrangement-note', 'collaborator-brief'. */
  key: string;
  value: string;
  kind: FactKind;
  source: FactSource;
  observedAt: string;
  /** Set when a later write replaced it. Null = currently believed. */
  supersededAt: string | null;
}

export type FactInput = Omit<ProjectFact, 'id' | 'supersededAt'>;

/** Values are capped so one runaway write cannot crowd out a context pack. */
export const MAX_FACT_VALUE_BYTES = 4096;
export const MAX_FACT_KEY_LENGTH = 128;

export type Validation = { ok: true } | { ok: false; reason: string };

/**
 * Reject anything that would make the memory untrustworthy later. Fails
 * closed: a fact that cannot be attributed, scoped or bounded is not stored.
 */
export function validateFact(input: Partial<FactInput>): Validation {
  // projectId may be null (global memory), but it must be PRESENT as a key so
  // an accidental omission is still caught rather than silently becoming global.
  if (!('projectId' in input)) return { ok: false, reason: 'a fact must declare its scope (project id, or null for global)' };
  if (input.projectId !== null && !input.projectId) {
    return { ok: false, reason: 'a project-scoped fact needs a project id' };
  }
  if (!input.key || !input.key.trim()) return { ok: false, reason: 'a fact must have a key' };
  if (input.key.length > MAX_FACT_KEY_LENGTH) return { ok: false, reason: `key exceeds ${MAX_FACT_KEY_LENGTH} characters` };
  if (typeof input.value !== 'string') return { ok: false, reason: 'a fact value must be a string' };
  if (Buffer.byteLength(input.value, 'utf8') > MAX_FACT_VALUE_BYTES) {
    return { ok: false, reason: `value exceeds ${MAX_FACT_VALUE_BYTES} bytes` };
  }
  if (input.kind !== 'derived' && input.kind !== 'stated') {
    return { ok: false, reason: "kind must be 'derived' or 'stated'" };
  }
  const src = input.source;
  if (!src?.origin || !src?.producer) return { ok: false, reason: 'a fact must carry its source (origin + producer)' };
  if (input.kind === 'derived' && src.origin !== 'index') {
    // A derived fact claims to be recomputable from local state; letting an
    // agent mint one would smuggle an opinion in as ground truth.
    return { ok: false, reason: "a derived fact must originate from 'index'" };
  }
  if (input.kind === 'stated' && src.origin === 'index') {
    return { ok: false, reason: "a stated fact cannot claim to originate from 'index'" };
  }
  // Global scope is for explicit human/agent memory. A DERIVED fact is
  // recomputed from a project's rows, so a global derived fact could never be
  // recomputed and would become unfalsifiable.
  if (input.projectId === null && input.kind === 'derived') {
    return { ok: false, reason: 'global memory cannot be derived — it has no project to recompute from' };
  }
  if (!input.observedAt) return { ok: false, reason: 'a fact must record when it was observed' };
  return { ok: true };
}

export type FactWritePlan =
  | { action: 'reject'; reason: string }
  | { action: 'noop'; reason: string }
  | { action: 'insert'; fact: FactInput }
  | { action: 'supersede'; supersedeId: string; supersededAt: string; fact: FactInput };

/**
 * Decide what a write should do against the currently-believed fact.
 *
 * Re-writing an identical value is a no-op rather than a new row: the watcher
 * re-derives facts constantly, and recording "still 128 BPM" thousands of
 * times would bury the moments that actually changed.
 */
export function planFactWrite(current: ProjectFact | null, incoming: FactInput, now: string): FactWritePlan {
  const valid = validateFact(incoming);
  if (!valid.ok) return { action: 'reject', reason: valid.reason };

  if (!current || current.supersededAt) return { action: 'insert', fact: incoming };

  if (current.value === incoming.value && current.kind === incoming.kind) {
    return { action: 'noop', reason: 'value unchanged' };
  }

  // A derived re-observation must not silently erase something a person said.
  // The index still wins on the facts it owns, but it owns derived keys only.
  if (incoming.kind === 'derived' && current.kind === 'stated') {
    return { action: 'reject', reason: 'a derived observation cannot overwrite a stated fact — use a different key' };
  }

  return { action: 'supersede', supersedeId: current.id, supersededAt: now, fact: incoming };
}

export interface IndexTruth {
  /** Key → the value deterministic local state currently says. */
  [key: string]: string | null;
}

export interface FactReconciliation {
  current: ProjectFact[];
  /** Derived facts that disagree with the index — the index wins. */
  stale: Array<{ fact: ProjectFact; indexValue: string | null; reason: string }>;
}

/**
 * Compare believed facts against the index.
 *
 * Only DERIVED facts are checked: a stated fact ("the client wants this
 * brighter") is an opinion the index has no view on, and marking it stale
 * because the index lacks the key would quietly delete human knowledge.
 */
export function reconcileWithIndex(facts: ProjectFact[], truth: IndexTruth): FactReconciliation {
  const current: ProjectFact[] = [];
  const stale: FactReconciliation['stale'] = [];
  for (const f of facts) {
    if (f.supersededAt) continue;
    if (f.kind !== 'derived') { current.push(f); continue; }
    if (!(f.key in truth)) { current.push(f); continue; }
    const indexValue = truth[f.key];
    if (indexValue !== f.value) {
      stale.push({ fact: f, indexValue, reason: `index says ${indexValue === null ? 'unknown' : `"${indexValue}"`}` });
    } else {
      current.push(f);
    }
  }
  return { current, stale };
}

/**
 * The believed facts for a project, newest first, with a stable total order so
 * the same memory renders identically every time.
 */
export function believedFacts(facts: ProjectFact[]): ProjectFact[] {
  return facts
    .filter((f) => !f.supersededAt)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
}
