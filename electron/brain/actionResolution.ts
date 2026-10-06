/**
 * Deterministic entity resolution — the model names an intent, code names the
 * target.
 *
 * The rule this module exists to enforce: a canonical identifier never
 * originates with the model. A model may say "Sunshine"; it may not say
 * "p-9f3c…". Everything that becomes an argument to a real tool is looked up
 * here, from state Wavi itself recorded, so a hallucinated id cannot reach the
 * server even if the model is confidently wrong.
 *
 * The second rule: when the target is unclear, do not guess. A wrong guess
 * that mutates state is worse than a question, so ambiguity resolves to
 * candidates for the user to choose between, never to the closest match.
 *
 * Pure: no I/O, no Electron.
 */

export interface ProjectCandidate {
  /** Canonical local project id. Never shown to a model. */
  id: string;
  /** Display name, which is what a model and a user both actually use. */
  name: string;
  /** Most recent activity, used only to describe — never to break a tie. */
  updatedAt?: string | null;
}

export interface VersionCandidate {
  /** Canonical version id. */
  id: string;
  /** Monotonic version number as Wavi recorded it. */
  versionNumber: number;
  publishedAt?: string | null;
}

export type ProjectResolution =
  | { kind: 'resolved'; project: ProjectCandidate }
  | { kind: 'ambiguous'; candidates: ProjectCandidate[] }
  | { kind: 'none' };

function norm(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Words that carry no identifying information in a project request. */
const FILLER = new Set([
  'the', 'my', 'a', 'an', 'project', 'projects', 'track', 'song', 'newest',
  'latest', 'last', 'recent', 'version', 'for', 'of', 'please', 'folder',
  'make', 'create', 'share', 'send', 'get', 'me', 'link', 'links',
]);

/**
 * Strip the phrasing around a name: "make a link for the newest Sunshine
 * project" → "sunshine".
 *
 * Where the request says "… for X", everything before it is the instruction
 * and X is the target, so the split happens there first. Otherwise the filler
 * words are removed. This is not language understanding — it is narrowing a
 * phrase enough for the containment rules below to be meaningful, and both of
 * those still refuse to guess.
 */
export function extractProjectName(phrase: string): string {
  let text = norm(phrase);
  const forIdx = text.lastIndexOf(' for ');
  if (forIdx >= 0) text = text.slice(forIdx + 5);
  return text.split(' ').filter((w) => w && !FILLER.has(w)).join(' ');
}

/**
 * Resolve a spoken project name against what Wavi has indexed.
 *
 * An EXACT name match wins outright, even when other names contain it. This
 * matters for the common real case: a user with "Sunshine", "Sunshine Remix"
 * and "Sunshine 2" who says "Sunshine" means Sunshine, and asking them to
 * disambiguate an exact match would be obtuse. Anything less than exact that
 * matches more than one project is ambiguous and stops here.
 */
export function resolveProjectTarget(
  phrase: string,
  candidates: ProjectCandidate[],
): ProjectResolution {
  const wanted = extractProjectName(phrase);
  if (!wanted) return { kind: 'none' };

  const exact = candidates.filter((c) => norm(c.name) === wanted);
  if (exact.length === 1) return { kind: 'resolved', project: exact[0] };
  // Two projects genuinely sharing a name is ambiguous no matter how exact the
  // match is; there is nothing deterministic left to prefer.
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };

  // A phrase that CONTAINS a whole project name is a strong match: "the
  // sunshine remix thing" names Sunshine Remix, and the longest name it
  // contains is the most specific thing the user can be said to have named.
  const contained = candidates.filter((c) => wanted.includes(norm(c.name)));
  if (contained.length) {
    const longest = Math.max(...contained.map((c) => norm(c.name).length));
    const best = contained.filter((c) => norm(c.name).length === longest);
    if (best.length === 1) return { kind: 'resolved', project: best[0] };
    return { kind: 'ambiguous', candidates: best };
  }

  // The other direction is weak: "sun" is a fragment of three different names
  // and prefers none of them. Length is no help here — the longest name is not
  // the likeliest meaning of a fragment — so more than one match stops.
  const fragment = candidates.filter((c) => norm(c.name).includes(wanted));
  if (fragment.length === 1) return { kind: 'resolved', project: fragment[0] };
  if (fragment.length > 1) return { kind: 'ambiguous', candidates: fragment };
  return { kind: 'none' };
}

export type VersionResolution =
  | { kind: 'resolved'; version: VersionCandidate }
  | { kind: 'ambiguous'; candidates: VersionCandidate[] }
  | { kind: 'none' };

/**
 * Resolve "the newest version" to a specific published version.
 *
 * Ordering is by the version number Wavi assigned, not by timestamp: numbers
 * are authoritative and totally ordered, while published-at can tie or be
 * absent. Two versions sharing the highest number means Wavi's own records
 * disagree, and the honest response to that is a question rather than a coin
 * toss.
 */
export function resolveLatestVersion(versions: VersionCandidate[]): VersionResolution {
  const valid = (versions ?? []).filter((v) => v && Number.isFinite(v.versionNumber));
  if (!valid.length) return { kind: 'none' };
  const top = Math.max(...valid.map((v) => v.versionNumber));
  const highest = valid.filter((v) => v.versionNumber === top);
  if (highest.length > 1) return { kind: 'ambiguous', candidates: highest };
  return { kind: 'resolved', version: highest[0] };
}

/** How a candidate is offered to the user: a display label and a safe ref. */
export interface ClarificationOption {
  /** Safe, opaque, per-request reference. Not a canonical id. */
  ref: string;
  label: string;
}

/**
 * Describe candidates for the user to choose between.
 *
 * The refs are positional and local to this question — handing out canonical
 * ids to make a UI convenient would undo the whole point of resolving them
 * here.
 */
export function describeProjectCandidates(candidates: ProjectCandidate[]): ClarificationOption[] {
  return candidates.map((c, i) => ({ ref: `cand_${i + 1}`, label: c.name }));
}
