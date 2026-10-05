/**
 * Project Brain — derived project memory.
 *
 * Recomputes what deterministic local state already implies about a project,
 * so the brain can answer "which is the master?", "what's missing?", "has this
 * changed since I shared it?" without a model and without storing an opinion.
 *
 * The facts here are DERIVED by definition: every one is a pure function of
 * rows the index owns, so it can be recomputed at any time and must never be
 * allowed to contradict those rows (see memory.ts — the index wins).
 *
 * Separation of FACTS from INFERENCES is explicit. `facts` are things the
 * index states outright (file counts, timestamps, lineage). `inferences` are
 * conventions — "this is probably the master" — and are returned in their own
 * bucket, with the evidence that produced them, so a caller can present them
 * with appropriate hedging and never mistake one for the other.
 *
 * Pure: no I/O, no Electron, no clock.
 */

export interface DeriveFile {
  id: string;
  name: string;
  role: string | null;
  fileType: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  localStatus: string | null;
  syncStatus: string | null;
  checksum: string | null;
}

export interface DeriveVersion {
  id: string;
  versionNumber: number | null;
  createdAt: string | null;
}

export interface DeriveInput {
  projectId: string;
  projectName: string;
  dawType: string | null;
  files: DeriveFile[];
  versions: DeriveVersion[];
  /** Most recent activity timestamp for this project, if any. */
  lastActivityAt?: string | null;
}

/** A fact the index states outright. */
export interface DerivedFact {
  key: string;
  value: string;
}

/** A convention-based guess, always carrying its evidence. */
export interface Inference {
  key: string;
  value: string;
  /** Why the brain thinks so, in plain language. */
  evidence: string;
  /** 'strong' when a single unambiguous signal matched; 'weak' otherwise. */
  strength: 'strong' | 'weak';
}

export interface DerivedMemory {
  facts: DerivedFact[];
  inferences: Inference[];
}

const MASTER_HINT = /(^|[^a-z])(master|final|mixdown|bounce)([^a-z]|$)/i;
const STEM_HINT = /(^|\/)(stems?|tracks?|multitrack)(\/|$)/i;
const VERSION_SUFFIX = /[-_ ]v(\d+)\b/i;

/**
 * Pick the likeliest master/bounce.
 *
 * Deliberately an INFERENCE: nothing in a filesystem marks a file as the
 * master, so this is convention-matching. Returning it as a fact would let a
 * confident wrong guess propagate into everything downstream.
 */
export function inferMaster(files: DeriveFile[]): Inference | null {
  const audio = files.filter((f) => (f.role === 'audio' || f.role === 'stem' || f.fileType === 'wav' || f.fileType === 'aiff')
    && f.localStatus !== 'missing');
  if (!audio.length) return null;

  const named = audio.filter((f) => MASTER_HINT.test(f.name));
  if (named.length === 1) {
    return { key: 'likely-master', value: named[0].name, evidence: `"${named[0].name}" is the only file named like a master or bounce`, strength: 'strong' };
  }
  if (named.length > 1) {
    // Prefer the highest explicit version suffix, then the newest.
    const ranked = [...named].sort((a, b) => {
      const va = parseInt(a.name.match(VERSION_SUFFIX)?.[1] ?? '-1', 10);
      const vb = parseInt(b.name.match(VERSION_SUFFIX)?.[1] ?? '-1', 10);
      return vb - va || (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '') || a.name.localeCompare(b.name);
    });
    const top = ranked[0];
    const hasVersion = VERSION_SUFFIX.test(top.name);
    return {
      key: 'likely-master',
      value: top.name,
      evidence: hasVersion
        ? `highest version among ${named.length} master-like files`
        : `most recently modified of ${named.length} master-like files`,
      strength: hasVersion ? 'strong' : 'weak',
    };
  }
  return null;
}

/** Stems, by role or by living under a stems-like directory. */
export function collectStems(files: DeriveFile[]): DeriveFile[] {
  return files.filter((f) => f.role === 'stem' || STEM_HINT.test(f.name));
}

/**
 * Recompute everything the index implies about a project.
 *
 * Ordering is stable throughout so the same rows always produce byte-identical
 * memory — otherwise every recompute would look like a change and flood the
 * append-only store.
 */
export function deriveProjectMemory(input: DeriveInput): DerivedMemory {
  const files = input.files;
  const present = files.filter((f) => f.localStatus !== 'missing');
  const missing = files.filter((f) => f.localStatus === 'missing');
  const unsynced = present.filter((f) => f.syncStatus !== 'synced');
  const stems = collectStems(present);
  const midi = present.filter((f) => f.fileType === 'mid' || f.fileType === 'midi');
  const artwork = present.filter((f) => f.role === 'artwork');

  const latestVersion = [...input.versions]
    .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0] ?? null;

  const lastFileChange = present
    .map((f) => f.modifiedAt).filter(Boolean)
    .sort().reverse()[0] ?? null;

  const facts: DerivedFact[] = [
    { key: 'file-count', value: String(files.length) },
    { key: 'present-file-count', value: String(present.length) },
    { key: 'missing-file-count', value: String(missing.length) },
    { key: 'unsynced-file-count', value: String(unsynced.length) },
    { key: 'stem-count', value: String(stems.length) },
    { key: 'midi-count', value: String(midi.length) },
    { key: 'artwork-count', value: String(artwork.length) },
    { key: 'version-count', value: String(input.versions.length) },
  ];
  if (input.dawType) facts.push({ key: 'source-daw', value: input.dawType });
  if (latestVersion?.versionNumber != null) facts.push({ key: 'latest-version', value: String(latestVersion.versionNumber) });
  if (latestVersion?.createdAt) facts.push({ key: 'latest-version-at', value: latestVersion.createdAt });
  if (lastFileChange) facts.push({ key: 'last-file-change', value: lastFileChange });
  if (input.lastActivityAt) facts.push({ key: 'last-activity', value: input.lastActivityAt });

  // Changed-since-publish is a FACT: both timestamps are the index's own.
  if (latestVersion?.createdAt && lastFileChange) {
    facts.push({
      key: 'changed-since-publish',
      value: lastFileChange > latestVersion.createdAt ? 'yes' : 'no',
    });
  }

  const inferences: Inference[] = [];
  const master = inferMaster(present);
  if (master) inferences.push(master);
  if (stems.length >= 2) {
    inferences.push({
      key: 'has-stem-set', value: 'yes',
      evidence: `${stems.length} files look like stems`,
      strength: stems.length >= 3 ? 'strong' : 'weak',
    });
  }

  facts.sort((a, b) => a.key.localeCompare(b.key));
  inferences.sort((a, b) => a.key.localeCompare(b.key));
  return { facts, inferences };
}
