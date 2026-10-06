/**
 * Project Brain — the canonical assistant context builder.
 *
 * One boundary. A local or cloud model later consumes THIS, and nothing else:
 * it never queries the database, never walks the filesystem, and never decides
 * what is true. That split is what keeps the app's beliefs testable and
 * independent of whichever model is installed.
 *
 * Three properties the result must have:
 *
 *  · **Bounded by named constants**, so a 25,000-file library cannot become
 *    25,000 context records.
 *  · **Attributed** — every item says whether a person stated it, the index
 *    observed it, or the brain inferred it. Collapsing those into plain
 *    strings would make a guess indistinguishable from a measurement.
 *  · **Relevant, deterministically** — the same query and index always select
 *    the same records, by lexical overlap only. No embeddings, no model.
 *
 * Pure: no I/O, no Electron, no clock.
 */
import { parseBrainQuery } from './query';
import type { DerivedFact, Inference } from './derive';

// ── Context limits ───────────────────────────────────────────────────────────
// Named and exported so they are reviewable and assertable, rather than magic
// numbers buried in a slice(). Sized to leave a model room to actually reason:
// a context that fills the window with inventory is worse than a smaller one.

export const CONTEXT_LIMITS = {
  /** Remembered items per scope (global and project counted separately). */
  memoriesPerScope: 8,
  /** Files, after relevance selection. */
  files: 20,
  /** Versions, newest first. */
  versions: 5,
  /** Activity events, newest first. */
  activityEvents: 15,
  /** Deterministic facts about the project. */
  facts: 20,
  /** Convention-based guesses. */
  inferences: 8,
} as const;

export type ContextLimits = Partial<typeof CONTEXT_LIMITS>;

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface ContextMemory {
  key: string;
  value: string;
  category: string;
  scope: 'global' | 'project';
  /** 'user' | 'agent' — who asserted it. */
  origin: string;
  producer: string;
  observedAt: string;
}

export interface ContextFile {
  id: string;
  /** File NAME, never a path. */
  name: string;
  role: string | null;
  status: string | null;
  modifiedAt: string | null;
}

export interface ContextVersion {
  versionNumber: number | null;
  createdAt: string | null;
  fileCount: number | null;
}

export interface ContextActivity {
  type: string;
  message: string;
  at: string;
}

export interface AssistantContextInput {
  /** The user's question, used for deterministic relevance selection. */
  query: string;
  project: {
    id: string;
    name: string;
    dawType: string | null;
  } | null;
  /** Memory from BOTH scopes; this builder filters and ranks it. */
  memory: ContextMemory[];
  facts: DerivedFact[];
  inferences: Inference[];
  files: ContextFile[];
  versions: ContextVersion[];
  recentActivity: ContextActivity[];
  limits?: ContextLimits;
  /** Injected so recency ordering is reproducible. */
  now: string;
}

// ── Output ───────────────────────────────────────────────────────────────────

/** Provenance kept structured, never flattened to a sentence. */
export interface Attribution {
  kind: 'stated' | 'observed' | 'derived' | 'inferred';
  origin: string;
  producer?: string;
  /** Inference only. */
  strength?: 'strong' | 'weak';
  evidence?: string;
  scope?: 'global' | 'project';
}

export interface ContextItem<T> {
  value: T;
  attribution: Attribution;
  /** Why this was selected, for explainability. */
  matchedOn?: string[];
}

export interface AssistantContext {
  schema: 'wavi.assistant-context/1';
  query: string;
  project: AssistantContextInput['project'];
  /** Explicit human/agent statements, ranked by relevance to the query. */
  userMemory: ContextItem<ContextMemory>[];
  /** Deterministic facts the index asserts. */
  facts: ContextItem<DerivedFact>[];
  /** Convention-based guesses, with their evidence. */
  inferences: ContextItem<Inference>[];
  files: ContextFile[];
  versions: ContextVersion[];
  recentActivity: ContextActivity[];
  /**
   * Where a stated memory disagrees with what the index currently observes.
   * Surfaced rather than resolved: the brain says what each source claims and
   * which one is authoritative for that kind of question, and leaves the
   * wording to the caller.
   */
  conflicts: Array<{
    key: string;
    statedValue: string;
    indexValue: string;
    /** Which source wins for THIS kind of claim, and why. */
    authoritative: 'index' | 'statement';
    note: string;
  }>;
  truncation: {
    truncated: boolean;
    dropped: Record<string, number>;
    notes: string[];
  };
}

// ── Relevance ────────────────────────────────────────────────────────────────

/**
 * Filler words carry no retrieval signal and actively mislead.
 *
 * "Which DAW do I usually use?" would otherwise match "I *usually* export
 * vocals…", and "for" matches almost any sentence — both produce confident
 * selections of the wrong memory.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'our', 'are', 'was', 'were', 'with', 'that', 'this',
  'what', 'when', 'where', 'which', 'who', 'how', 'why', 'do', 'does', 'did', 'is', 'it',
  'my', 'me', 'we', 'us', 'usually', 'normally', 'often', 'always', 'use', 'used', 'about',
  'know', 'remember', 'tell', 'can', 'should', 'would', 'into', 'from', 'have', 'has',
]);

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Loose stem match: "export"/"exported", "vocal"/"vocals",
 * "collaborator"/"collaborations". A shared prefix of 5+ characters is enough
 * to relate two word forms without pulling in unrelated words, and unlike a
 * raw substring test it cannot match a fragment inside an unrelated word.
 */
function relatedToken(a: string, b: string): boolean {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 5) return false;
  let i = 0;
  while (i < min && a[i] === b[i]) i++;
  return i >= 5;
}

/**
 * Lexical overlap between a memory and the query.
 *
 * Deliberately simple and explainable: a count of query terms appearing in the
 * memory's key or value. Returning every memory for every request would bury
 * the relevant one; ranking by a model would make selection unreproducible.
 */
export function scoreMemory(memory: ContextMemory, queryTerms: string[]): { score: number; matchedOn: string[] } {
  if (queryTerms.length === 0) return { score: 0, matchedOn: [] };
  const haystack = [...tokens(memory.key), ...tokens(memory.value), ...tokens(memory.category)];
  const matchedOn: string[] = [];
  for (const term of queryTerms) {
    if (haystack.some((h) => relatedToken(h, term))) matchedOn.push(term);
  }
  return { score: matchedOn.length, matchedOn };
}

function attributionFor(m: ContextMemory): Attribution {
  return {
    kind: 'stated',
    origin: m.origin,
    producer: m.producer,
    scope: m.scope,
  };
}

/**
 * Select memory for the query.
 *
 * With no query terms, falls back to most-recent-first rather than returning
 * nothing: "what do you remember?" is a real question.
 */
export function selectMemory(
  memory: ContextMemory[],
  queryText: string,
  perScope: number,
): ContextItem<ContextMemory>[] {
  const q = parseBrainQuery(queryText ?? '', 2026);
  const queryTerms = [...new Set([...q.terms.flatMap(tokens), ...q.phrases.flatMap(tokens)])];

  const scored = memory.map((m) => ({ m, ...scoreMemory(m, queryTerms) }));
  // Fall back to recency ONLY when the question carries no usable terms
  // ("what do you remember?"). If the user asked something specific and
  // nothing matched, the honest answer is nothing — returning everything
  // would hand the model unrelated notes to answer from.
  const broadQuery = queryTerms.length === 0;

  const pick = (scope: 'global' | 'project') => scored
    .filter((s) => s.m.scope === scope)
    // When nothing matches lexically, fall back to recency rather than
    // returning an empty context for a broad question.
    .filter((s) => broadQuery || s.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      b.m.observedAt.localeCompare(a.m.observedAt) ||
      a.m.key.localeCompare(b.m.key))
    .slice(0, perScope)
    .map((s) => ({ value: s.m, attribution: attributionFor(s.m), matchedOn: s.matchedOn }));

  // Project memory first: in a project context it is the more specific claim.
  return [...pick('project'), ...pick('global')];
}

// ── Conflicts ────────────────────────────────────────────────────────────────

/**
 * Compare stated memory against index facts, by KEY only.
 *
 * Deliberately not a universal relevance score across categories. "I prefer FL
 * Studio for collaborations" and "this project is Ableton" are not in conflict
 * — they are different claims about different things — and a scheme that
 * ranked every statement against every fact would invent a disagreement there.
 * Only the same key is comparable.
 *
 * Where they do collide, the INDEX wins for questions of current file state:
 * it re-reads the disk, and a remembered filename goes stale the moment the
 * user bounces again. The statement is still returned, with its provenance, so
 * the caller can explain rather than silently drop it.
 */
export function detectConflicts(
  memory: ContextItem<ContextMemory>[],
  facts: DerivedFact[],
): AssistantContext['conflicts'] {
  const byKey = new Map(facts.map((f) => [f.key, f.value]));
  const out: AssistantContext['conflicts'] = [];
  for (const item of memory) {
    const indexValue = byKey.get(item.value.key);
    if (indexValue === undefined || indexValue === item.value.value) continue;
    out.push({
      key: item.value.key,
      statedValue: item.value.value,
      indexValue,
      authoritative: 'index',
      note: 'The index re-reads the current state, so it is authoritative for what the files are now. The remembered value is kept for context.',
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * An explicit statement outranks a convention-based guess about the same
 * subject. If the user says which file is the master, the brain should not
 * keep asserting its own guess as though it were equally good.
 */
export function reconcileInferences(
  inferences: Inference[],
  memory: ContextItem<ContextMemory>[],
): ContextItem<Inference>[] {
  const statedKeys = new Set(memory.map((m) => m.value.key.toLowerCase()));
  return inferences.map((inf) => {
    const overridden = statedKeys.has(inf.key.toLowerCase());
    return {
      value: inf,
      attribution: {
        kind: 'inferred' as const,
        origin: 'brain',
        strength: inf.strength,
        evidence: overridden
          ? `${inf.evidence} — but the user has stated a value for "${inf.key}", which takes precedence`
          : inf.evidence,
      },
    };
  });
}

// ── Builder ──────────────────────────────────────────────────────────────────

export function buildAssistantContext(input: AssistantContextInput): AssistantContext {
  const limits = { ...CONTEXT_LIMITS, ...(input.limits ?? {}) };
  const dropped: Record<string, number> = {};
  const notes: string[] = [];

  const userMemory = selectMemory(input.memory, input.query, limits.memoriesPerScope);
  const memoryDropped = input.memory.length - userMemory.length;
  if (memoryDropped > 0) dropped.memories = memoryDropped;

  const facts = input.facts.slice(0, limits.facts).map((f) => ({
    value: f,
    attribution: { kind: 'derived' as const, origin: 'index', producer: 'watcher' },
  }));
  if (input.facts.length > facts.length) dropped.facts = input.facts.length - facts.length;

  const inferences = reconcileInferences(input.inferences, userMemory).slice(0, limits.inferences);
  if (input.inferences.length > inferences.length) dropped.inferences = input.inferences.length - inferences.length;

  // Files: relevance first, then recency — a 25,000-file library must not
  // become 25,000 context records.
  const q = parseBrainQuery(input.query ?? '', 2026);
  const queryTerms = [...new Set([...q.terms.flatMap(tokens), ...q.phrases.flatMap(tokens)])];
  const scoredFiles = input.files.map((f) => {
    const hay = [...tokens(f.name), ...tokens(f.role ?? '')];
    const score = queryTerms.filter((t) => hay.some((h) => relatedToken(h, t))).length;
    return { f, score };
  });
  const broadFileQuery = queryTerms.length === 0;
  const files = scoredFiles
    .filter((s) => broadFileQuery || s.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      (b.f.modifiedAt ?? '').localeCompare(a.f.modifiedAt ?? '') ||
      a.f.name.localeCompare(b.f.name))
    .slice(0, limits.files)
    .map((s) => s.f);
  if (input.files.length > files.length) dropped.files = input.files.length - files.length;

  const versions = [...input.versions]
    .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0))
    .slice(0, limits.versions);
  if (input.versions.length > versions.length) dropped.versions = input.versions.length - versions.length;

  const recentActivity = [...input.recentActivity]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limits.activityEvents);
  if (input.recentActivity.length > recentActivity.length) {
    dropped.activityEvents = input.recentActivity.length - recentActivity.length;
  }

  for (const [what, n] of Object.entries(dropped)) {
    notes.push(`${n} ${what} omitted to stay within the context budget.`);
  }

  return {
    schema: 'wavi.assistant-context/1',
    query: input.query,
    project: input.project,
    userMemory,
    facts,
    inferences,
    files,
    versions,
    recentActivity,
    conflicts: detectConflicts(userMemory, input.facts),
    truncation: {
      truncated: Object.keys(dropped).length > 0,
      dropped,
      notes,
    },
  };
}
