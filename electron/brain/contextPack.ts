/**
 * Project Brain — the context pack.
 *
 * This is the interface a later local LLM agent consumes. It is deliberately a
 * DATA structure, not a prompt: the brain decides what is true and what is
 * relevant; the model decides only how to say it. Keeping that split means the
 * brain can be tested, and a model swap cannot change what the app believes.
 *
 * Three properties the pack must have:
 *
 *  · **Bounded.** A context window is finite, so the pack has explicit item
 *    and byte budgets and reports what it dropped. Silent truncation would let
 *    a model confidently answer from a half-view.
 *  · **Attributed.** Every claim says whether it came from deterministic local
 *    state or from someone's assertion, so the model can hedge correctly.
 *  · **Private.** No absolute paths, no tokens, no account identifiers. The
 *    pack may cross into a model's context; user data that it does not need
 *    must not be there at all.
 *
 * Pure: no I/O, no Electron, no clock.
 */
import type { ProjectFact } from './memory';
import { believedFacts, reconcileWithIndex, type IndexTruth } from './memory';

export interface PackProject {
  id: string;
  name: string;
  dawType: string | null;
  bpm: number | null;
  keyNote: string | null;
  syncStatus: string | null;
  /** True when this project was adopted from someone else's Project Link. */
  isAdopted: boolean;
  /** Canonical version this descends from, when adopted. */
  parentVersionId: string | null;
}

export interface PackFile {
  id: string;
  name: string;
  role: string | null;
  fileType: string | null;
  sizeBytes: number | null;
  status: string | null;
}

export interface PackVersion {
  versionNumber: number | null;
  createdAt: string | null;
  fileCount: number | null;
}

export interface PackIssue {
  kind: 'missing-file' | 'failed-sync' | 'unresolved-association' | 'stale-fact';
  detail: string;
}

export interface ContextPackInput {
  project: PackProject;
  files: PackFile[];
  versions: PackVersion[];
  facts: ProjectFact[];
  /** What deterministic local state says, for reconciling derived facts. */
  indexTruth?: IndexTruth;
  issues?: PackIssue[];
  budget?: Partial<PackBudget>;
}

export interface PackBudget {
  maxFiles: number;
  maxVersions: number;
  maxFacts: number;
  maxBytes: number;
}

export const DEFAULT_BUDGET: PackBudget = {
  maxFiles: 40,
  maxVersions: 10,
  maxFacts: 25,
  // Roughly a few thousand tokens — large enough to be useful, small enough to
  // leave the model room to actually reason.
  maxBytes: 16_000,
};

export interface ContextPack {
  schema: 'wavi.context/1';
  project: PackProject;
  /** Files grouped by role, each group ordered deterministically. */
  filesByRole: Array<{ role: string; files: PackFile[] }>;
  versions: PackVersion[];
  /** Currently believed facts, each attributed. */
  facts: Array<{ key: string; value: string; kind: ProjectFact['kind']; origin: string; observedAt: string }>;
  issues: PackIssue[];
  /** What was left out, and why. Never silent. */
  truncation: {
    truncated: boolean;
    droppedFiles: number;
    droppedVersions: number;
    droppedFacts: number;
    notes: string[];
  };
  counts: { totalFiles: number; totalVersions: number; totalFacts: number };
}

function sortFiles(a: PackFile, b: PackFile): number {
  // Deterministic: name, then id. Never insertion order.
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * Build the pack.
 *
 * Files are kept per role rather than as one flat list because a musician's
 * question is almost always role-shaped ("where are the stems?"), and because
 * a flat truncation would drop whole roles invisibly — keeping a few of each
 * role preserves the shape of the project even under a tight budget.
 */
export function buildContextPack(input: ContextPackInput): ContextPack {
  const budget: PackBudget = { ...DEFAULT_BUDGET, ...(input.budget ?? {}) };
  const notes: string[] = [];
  const issues: PackIssue[] = [...(input.issues ?? [])];

  // ── Facts: reconcile against the index first; the index wins ──────────────
  const reconciled = input.indexTruth
    ? reconcileWithIndex(input.facts, input.indexTruth)
    : { current: believedFacts(input.facts), stale: [] as ReturnType<typeof reconcileWithIndex>['stale'] };
  for (const s of reconciled.stale) {
    issues.push({
      kind: 'stale-fact',
      detail: `Remembered ${s.fact.key} = "${s.fact.value}", but ${s.reason}. The index wins.`,
    });
  }
  const allFacts = believedFacts(reconciled.current);
  const facts = allFacts.slice(0, budget.maxFacts).map((f) => ({
    key: f.key, value: f.value, kind: f.kind,
    origin: `${f.source.origin}:${f.source.producer}`,
    observedAt: f.observedAt,
  }));
  const droppedFacts = Math.max(0, allFacts.length - facts.length);

  // ── Files: group by role, then budget across roles evenly ─────────────────
  const byRole = new Map<string, PackFile[]>();
  for (const f of input.files) {
    const role = f.role ?? 'unknown';
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role)!.push(f);
  }
  const roles = [...byRole.keys()].sort();
  for (const r of roles) byRole.get(r)!.sort(sortFiles);

  let remaining = budget.maxFiles;
  const filesByRole: ContextPack['filesByRole'] = [];
  // Round-robin so no role is starved by an alphabetically earlier one.
  const perRole = roles.length ? Math.max(1, Math.floor(budget.maxFiles / roles.length)) : 0;
  for (const role of roles) {
    if (remaining <= 0) break;
    const take = Math.min(perRole, remaining, byRole.get(role)!.length);
    filesByRole.push({ role, files: byRole.get(role)!.slice(0, take) });
    remaining -= take;
  }
  // Spend any leftover budget on the largest roles, largest first.
  if (remaining > 0) {
    for (const group of [...filesByRole].sort((a, b) => (byRole.get(b.role)!.length - byRole.get(a.role)!.length))) {
      if (remaining <= 0) break;
      const all = byRole.get(group.role)!;
      const extra = Math.min(remaining, all.length - group.files.length);
      if (extra > 0) { group.files = all.slice(0, group.files.length + extra); remaining -= extra; }
    }
  }
  const includedFiles = filesByRole.reduce((n, g) => n + g.files.length, 0);
  const droppedFiles = input.files.length - includedFiles;

  // ── Versions: newest first ────────────────────────────────────────────────
  const sortedVersions = [...input.versions].sort((a, b) =>
    (b.versionNumber ?? 0) - (a.versionNumber ?? 0) ||
    (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const versions = sortedVersions.slice(0, budget.maxVersions);
  const droppedVersions = sortedVersions.length - versions.length;

  if (droppedFiles > 0) notes.push(`${droppedFiles} file${droppedFiles === 1 ? '' : 's'} omitted to fit the budget.`);
  if (droppedVersions > 0) notes.push(`${droppedVersions} older version${droppedVersions === 1 ? '' : 's'} omitted.`);
  if (droppedFacts > 0) notes.push(`${droppedFacts} older fact${droppedFacts === 1 ? '' : 's'} omitted.`);

  const pack: ContextPack = {
    schema: 'wavi.context/1',
    project: input.project,
    filesByRole,
    versions,
    facts,
    issues,
    truncation: {
      truncated: droppedFiles > 0 || droppedVersions > 0 || droppedFacts > 0,
      droppedFiles, droppedVersions, droppedFacts, notes,
    },
    counts: {
      totalFiles: input.files.length,
      totalVersions: input.versions.length,
      totalFacts: allFacts.length,
    },
  };

  // ── Byte budget: a last resort, applied visibly ───────────────────────────
  if (Buffer.byteLength(JSON.stringify(pack), 'utf8') > budget.maxBytes) {
    let trimmed = 0;
    // Drop from the largest role first so the project's shape survives.
    while (Buffer.byteLength(JSON.stringify(pack), 'utf8') > budget.maxBytes) {
      const biggest = pack.filesByRole.reduce<{ role: string; files: PackFile[] } | null>(
        (best, g) => (!best || g.files.length > best.files.length ? g : best), null);
      if (!biggest || biggest.files.length === 0) break;
      biggest.files.pop();
      trimmed++;
    }
    if (trimmed > 0) {
      pack.truncation.truncated = true;
      pack.truncation.droppedFiles += trimmed;
      pack.truncation.notes.push(`${trimmed} further file${trimmed === 1 ? '' : 's'} omitted to stay within the size budget.`);
      pack.filesByRole = pack.filesByRole.filter((g) => g.files.length > 0);
    }
  }

  return pack;
}

/**
 * A one-paragraph deterministic summary.
 *
 * Provided so the brain — not the model — decides what the headline facts are.
 * The model may rewrite this for tone, but it should not have to infer it.
 */
export function summarizePack(pack: ContextPack): string {
  const p = pack.project;
  const bits: string[] = [`${p.name}${p.dawType ? ` (${p.dawType})` : ''}`];
  if (p.bpm) bits.push(`${p.bpm} BPM`);
  if (p.keyNote) bits.push(`key ${p.keyNote}`);
  bits.push(`${pack.counts.totalFiles} file${pack.counts.totalFiles === 1 ? '' : 's'}`);
  if (pack.counts.totalVersions) bits.push(`${pack.counts.totalVersions} version${pack.counts.totalVersions === 1 ? '' : 's'}`);
  if (p.isAdopted) bits.push('received from a Project Link');
  if (pack.issues.length) bits.push(`${pack.issues.length} open issue${pack.issues.length === 1 ? '' : 's'}`);
  if (pack.truncation.truncated) bits.push('partial view');
  return bits.join(' · ');
}
