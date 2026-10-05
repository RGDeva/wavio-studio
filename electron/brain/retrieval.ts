/**
 * Project Brain — deterministic retrieval.
 *
 * Ranking here is integer-scored, fully explainable, and totally ordered: the
 * same index and the same query always produce the same list in the same
 * order. That matters more than cleverness. A later LLM agent will present
 * these results as fact, so "why did this match?" must be answerable without
 * re-running a model, and the answer must not change between runs.
 *
 * No embeddings and no fuzzy similarity in v1 — both would make the brain's
 * output depend on a model's state, which is exactly what the deterministic
 * source-of-truth rule forbids. Every hit carries `matchedOn`.
 *
 * Pure: no I/O, no Electron, no clock (now is injected).
 */
import type { BrainQuery } from './query';

export type RecordKind = 'project' | 'file' | 'version';

/**
 * One indexable thing. Deliberately carries NO absolute path: the brain's
 * results may be handed to a model, and a filesystem path is user data that a
 * model never needs — callers resolve paths from the opaque id in main.
 */
export interface BrainRecord {
  id: string;
  kind: RecordKind;
  /** Owning project id; equals `id` for a project record. */
  projectId: string;
  /** File name or project name. Never a path. */
  name: string;
  projectName: string;
  dawType: string | null;
  role: string | null;
  fileType: string | null;
  bpm: number | null;
  keyNote: string | null;
  /** Sync/local state, e.g. 'synced' | 'pending' | 'failed' | 'missing'. */
  status: string | null;
  /** ISO timestamp used for recency and date filters. */
  modifiedAt: string | null;
}

export interface BrainHit {
  record: BrainRecord;
  score: number;
  /** Human-readable reasons, in a stable order. */
  matchedOn: string[];
}

export interface RankOptions {
  /** Injected so recency scoring is reproducible. */
  now: string;
  limit?: number;
}

/** Scoring weights, named so the ranking can be reasoned about and adjusted. */
export const WEIGHTS = {
  exactName: 100,
  phraseInName: 60,
  termInName: 40,
  termInProjectName: 20,
  termInRoleOrType: 10,
  recentToday: 5,
  recentWeek: 3,
  recentMonth: 1,
} as const;

function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase();
}

/** Word-ish split so "kick_drum-01.wav" matches the term "drum". */
function tokenize(s: string): string[] {
  return norm(s).split(/[^a-z0-9]+/).filter(Boolean);
}

function daysBetween(a: string, b: string): number | null {
  const ta = Date.parse(a); const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.floor((tb - ta) / 86_400_000);
}

/**
 * Apply the query's field filters. Filters are GATES, not score: a query that
 * says `daw:ableton` must never return an FL project just because its name
 * matched well.
 */
export function passesFilters(r: BrainRecord, q: BrainQuery): { ok: true } | { ok: false; failed: string } {
  const f = q.filters;
  if (f.daw && norm(r.dawType) !== f.daw) return { ok: false, failed: `daw:${f.daw}` };
  if (f.role && norm(r.role) !== f.role) return { ok: false, failed: `role:${f.role}` };
  if (f.type && norm(r.fileType) !== f.type) return { ok: false, failed: `type:${f.type}` };
  if (f.status && norm(r.status) !== f.status) return { ok: false, failed: `status:${f.status}` };
  if (f.key && norm(r.keyNote) !== f.key) return { ok: false, failed: `key:${f.key}` };
  if (f.bpm != null && r.bpm !== f.bpm) return { ok: false, failed: `bpm:${f.bpm}` };
  if (f.project && !norm(r.projectName).includes(f.project)) return { ok: false, failed: `project:${f.project}` };
  if (f.after) {
    if (!r.modifiedAt || r.modifiedAt < f.after) return { ok: false, failed: `after:${f.after}` };
  }
  if (f.before) {
    if (!r.modifiedAt || r.modifiedAt > f.before) return { ok: false, failed: `before:${f.before}` };
  }
  return { ok: true };
}

/**
 * Score one record. Returns null when the record does not satisfy the query.
 *
 * Terms use AND semantics: every term must match somewhere. OR would flood
 * results with records that matched one common word, and "why did this
 * match?" would stop having a useful answer.
 */
export function scoreRecord(r: BrainRecord, q: BrainQuery, now: string): BrainHit | null {
  const gate = passesFilters(r, q);
  if (!gate.ok) return null;

  const name = norm(r.name);
  const projectName = norm(r.projectName);
  const nameTokens = tokenize(r.name);
  const projectTokens = tokenize(r.projectName);
  const roleType = `${norm(r.role)} ${norm(r.fileType)}`.trim();

  let score = 0;
  const matchedOn: string[] = [];

  for (const phrase of q.phrases) {
    if (name.includes(phrase)) {
      score += WEIGHTS.phraseInName;
      matchedOn.push(`phrase "${phrase}" in name`);
    } else if (projectName.includes(phrase)) {
      score += WEIGHTS.termInProjectName;
      matchedOn.push(`phrase "${phrase}" in project name`);
    } else {
      return null; // a quoted phrase is an explicit requirement
    }
  }

  for (const term of q.terms) {
    if (name === term) {
      score += WEIGHTS.exactName;
      matchedOn.push(`name is exactly "${term}"`);
    } else if (nameTokens.includes(term)) {
      score += WEIGHTS.termInName;
      matchedOn.push(`"${term}" in name`);
    } else if (name.includes(term)) {
      // Substring but not a whole token — still a match, scored the same as a
      // token hit would over-reward noise like "a".
      score += WEIGHTS.termInName;
      matchedOn.push(`"${term}" in name`);
    } else if (projectTokens.includes(term) || projectName.includes(term)) {
      score += WEIGHTS.termInProjectName;
      matchedOn.push(`"${term}" in project name`);
    } else if (roleType.includes(term)) {
      score += WEIGHTS.termInRoleOrType;
      matchedOn.push(`"${term}" matches role/type`);
    } else {
      return null; // AND semantics
    }
  }

  // A query that is only filters still returns the filtered set.
  if (q.terms.length === 0 && q.phrases.length === 0) {
    matchedOn.push('matched filters only');
  }

  if (r.modifiedAt) {
    const age = daysBetween(r.modifiedAt, now);
    if (age !== null && age >= 0) {
      if (age === 0) { score += WEIGHTS.recentToday; matchedOn.push('modified today'); }
      else if (age <= 7) { score += WEIGHTS.recentWeek; matchedOn.push('modified this week'); }
      else if (age <= 30) { score += WEIGHTS.recentMonth; matchedOn.push('modified this month'); }
    }
  }

  return { record: r, score, matchedOn };
}

/**
 * Rank records for a query.
 *
 * The ordering is a TOTAL order — score, then recency, then id — so two runs
 * over the same index never disagree. Ties broken only by score would let
 * SQLite row order leak into the brain's answers.
 */
export function rankRecords(records: BrainRecord[], q: BrainQuery, opts: RankOptions): BrainHit[] {
  const hits: BrainHit[] = [];
  for (const r of records) {
    const hit = scoreRecord(r, q, opts.now);
    if (hit) hits.push(hit);
  }
  hits.sort((a, b) =>
    b.score - a.score ||
    (b.record.modifiedAt ?? '').localeCompare(a.record.modifiedAt ?? '') ||
    a.record.id.localeCompare(b.record.id));
  const limit = opts.limit ?? 50;
  return hits.slice(0, Math.max(0, limit));
}

/**
 * Group hits by project so a caller can answer "which project was that in?"
 * without a second pass. Project order follows the best hit in each group,
 * preserving the deterministic ranking above.
 */
export function groupHitsByProject(hits: BrainHit[]): Array<{ projectId: string; projectName: string; hits: BrainHit[] }> {
  const order: string[] = [];
  const byProject = new Map<string, BrainHit[]>();
  for (const h of hits) {
    const key = h.record.projectId;
    if (!byProject.has(key)) { byProject.set(key, []); order.push(key); }
    byProject.get(key)!.push(h);
  }
  return order.map((projectId) => ({
    projectId,
    projectName: byProject.get(projectId)![0].record.projectName,
    hits: byProject.get(projectId)!,
  }));
}
