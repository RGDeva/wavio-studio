/**
 * The portable handoff package — a derived checkout a recipient can work from.
 *
 * What this is
 * ------------
 * `crossDaw.ts` decides the honest fidelity tier and names what is lost. That
 * verdict lived only in whatever UI rendered it, so it vanished when the
 * window closed, and the assets stayed scattered through the restored folder
 * in whatever layout the creator's DAW happened to use. This module plans a
 * real directory:
 *
 *     <root>/
 *     ├── <original native project>      copied for reference; same-DAW opens it
 *     ├── project.dawproject             ONLY if one genuinely travelled
 *     ├── wavi/
 *     │   ├── session.json               portable metadata (wavi-extension subset)
 *     │   ├── fidelity.json              what was provided, what was lost
 *     │   └── PORTABLE.md                the same, for a person
 *     ├── stems/
 *     ├── midi/
 *     └── renders/
 *
 * What this is NOT
 * ----------------
 * It converts nothing. No `.flp` is generated from an `.als`, and no
 * `project.dawproject` is fabricated so that the file exists — if none
 * travelled, the field is null and fidelity.json says why. DR-015 stands:
 * DAWproject is the structured interchange format, Wavi consumes it, and
 * `session.json` here is the **wavi-extension sidecar** described in
 * WAVI_SESSION_IR_SPEC — identity, tempo if genuinely known, and an asset
 * inventory with hashes. It carries no track, device or plugin state, because
 * Wavi cannot prove any, and a second proprietary session format is exactly
 * what DR-015 forbids.
 *
 * It is also a DERIVED checkout. Nothing is written into the original project
 * directory and no source file is modified; the planner refuses a root that
 * overlaps the source at all.
 *
 * Pure: no I/O. The caller copies what this returns, hashes what it copied,
 * and reports what it could not find.
 */
import * as path from 'path';
import { isSafeRestorePath, isDestinationSafe } from './restoreArchive';
import { planCrossDawHandoff, type CrossDawPlan, type FidelityTier } from './crossDaw';

export const PACKAGE_DIR = 'wavi';
export const SESSION_FILE = `${PACKAGE_DIR}/session.json`;
export const FIDELITY_FILE = `${PACKAGE_DIR}/fidelity.json`;
export const README_FILE = `${PACKAGE_DIR}/PORTABLE.md`;
/**
 * Marker that makes this directory a DERIVED checkout rather than a project.
 *
 * Without it, a handoff built anywhere the user has asked Wavi to watch gets
 * discovered as a brand-new project — a duplicate carrying a stale copy of the
 * creator's project file, which would then sync and publish as if it were
 * original work. Discovery skips any directory holding this file.
 */
export const MARKER_FILE = `${PACKAGE_DIR}/.wavi-portable-handoff`;
export const STEMS_DIR = 'stems';
export const MIDI_DIR = 'midi';
export const RENDERS_DIR = 'renders';

/** An asset belonging to the authoritative project/version. */
export interface SourceAsset {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Path relative to the source project directory. */
  relativePath: string;
  /** Manifest role as Wavi indexed it. */
  role: string;
  fileSize?: number;
  /** Checksum Wavi already recorded. Never computed here. */
  sha256?: string | null;
}

export interface HandoffInput {
  /** Absolute root of the DERIVED checkout. Must not overlap the source. */
  handoffRoot: string;
  /** Absolute source project directory, for overlap checking. */
  sourceProjectDir: string;
  projectName: string;
  sourceDawId: string | null;
  targetDawId: string | null;
  assets: SourceAsset[];
  /** Tempo only when genuinely known. Never inferred from a filename. */
  bpm?: number | null;
  /** Lineage: the canonical version this checkout derives from. */
  sourceVersionLabel?: string | null;
  /** Lineage the return path depends on, carried opaquely for provenance. */
  lineage?: { sourceProjectRef?: string | null; sourceVersionRef?: string | null } | null;
  generatedAt: string;
  extraWarnings?: string[];
}

export interface PlannedCopy {
  /** Absolute source. */
  from: string;
  /** Package-relative destination. */
  to: string;
  /** Where it landed in the layout. */
  bucket: 'root' | 'stems' | 'midi' | 'renders';
  role: string;
  fileSize?: number;
  /** Hash Wavi recorded for the source, for the caller to verify against. */
  expectedSha256?: string | null;
}

export interface HandoffPlan {
  root: string;
  tier: FidelityTier;
  crossDawPlan: CrossDawPlan;
  /** Directories to create, package-relative, in order. */
  dirs: string[];
  copies: PlannedCopy[];
  /** Metadata files, written after the copies so hashes can be real. */
  buildMetadata: (verified: VerifiedCopy[]) => PackageFile[];
  rejected: Array<{ relativePath: string; reason: string }>;
  warnings: string[];
  /** True when the root is unusable; nothing should be written. */
  refusal?: string;
}

export interface PackageFile {
  relativePath: string;
  contents: string;
}

/** What the caller actually wrote, with the hash it measured. */
export interface VerifiedCopy {
  to: string;
  bucket: PlannedCopy['bucket'];
  role: string;
  bytes: number;
  sha256: string;
  /** Set when a recorded hash disagreed with the bytes on disk. */
  mismatch?: boolean;
}

const AUDIO_ROLES = new Set(['stem', 'audio']);

/** Does `inner` sit inside `outer` (or vice versa)? */
function overlaps(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return ra === rb || ra.startsWith(rb + path.sep) || rb.startsWith(ra + path.sep);
}

/**
 * Give every destination a distinct name.
 *
 * Two stems called `vocal.wav` in different source folders would otherwise
 * silently become one file, and the recipient would never know which survived.
 * A numeric suffix is ugly and honest.
 */
function uniqueName(taken: Set<string>, dir: string, base: string): string {
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  let candidate = dir ? `${dir}/${base}` : base;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = dir ? `${dir}/${stem}-${n}${ext}` : `${stem}-${n}${ext}`;
    n += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Plan the derived checkout.
 *
 * The cross-DAW planner decides the tier from the same asset list, so the
 * layout and the fidelity claim can never disagree — there is one source of
 * truth for "what did they actually get", and this reads it rather than
 * recomputing it.
 */
export function planPortableHandoff(input: HandoffInput): HandoffPlan {
  const warnings: string[] = [...(input.extraWarnings ?? [])];
  const rejected: HandoffPlan['rejected'] = [];

  // A handoff that writes into the project it derives from could overwrite the
  // original. Refuse before planning anything.
  if (!input.handoffRoot || !path.isAbsolute(input.handoffRoot)) {
    return emptyPlan(input, 'The handoff folder must be an absolute path.');
  }
  if (overlaps(input.handoffRoot, input.sourceProjectDir)) {
    return emptyPlan(input, 'The handoff folder must be outside the original project folder, so the original cannot be overwritten.');
  }

  // ── Asset admission ───────────────────────────────────────────────────────
  // Only assets belonging to the authoritative project may enter, each checked
  // for containment twice: by pattern and by resolution, because the two fail
  // differently.
  const admitted: SourceAsset[] = [];
  for (const a of input.assets) {
    const rel = a.relativePath;
    if (!rel || path.isAbsolute(rel) || rel.startsWith('..')) {
      rejected.push({ relativePath: String(rel), reason: 'not inside the project folder' });
      continue;
    }
    if (!isSafeRestorePath(rel)) {
      rejected.push({ relativePath: rel, reason: 'unsafe path' });
      continue;
    }
    if (!isDestinationSafe(input.sourceProjectDir, rel)) {
      rejected.push({ relativePath: rel, reason: 'resolves outside the project folder' });
      continue;
    }
    if (rel === PACKAGE_DIR || rel.startsWith(`${PACKAGE_DIR}/`)) continue;  // a previous package
    admitted.push(a);
  }

  const crossDawPlan = planCrossDawHandoff({
    sourceDawId: input.sourceDawId,
    targetDawId: input.targetDawId,
    assets: admitted.map((a) => ({ relativePath: a.relativePath, role: a.role, fileSize: a.fileSize })),
    bpm: input.bpm ?? null,
  });

  // ── Layout ────────────────────────────────────────────────────────────────
  const taken = new Set<string>();
  const copies: PlannedCopy[] = [];
  const usable = crossDawPlan.usable;
  const place = (a: SourceAsset, bucket: PlannedCopy['bucket'], dir: string) => {
    copies.push({
      from: a.absolutePath,
      to: uniqueName(taken, dir, path.basename(a.relativePath)),
      bucket, role: a.role,
      ...(a.fileSize !== undefined ? { fileSize: a.fileSize } : {}),
      expectedSha256: a.sha256 ?? null,
    });
  };

  // The native project first: same-DAW recipients open this and nothing else
  // matters to them, so it must be present and obvious at the root.
  const native = admitted.find((a) => a.relativePath === usable.nativeProject);
  if (native) place(native, 'root', '');

  // A DAWproject only if one genuinely travelled. Never synthesised.
  const dawproject = admitted.find((a) => a.relativePath === usable.dawproject);
  if (dawproject) place(dawproject, 'root', '');

  for (const rel of usable.midi) {
    const a = admitted.find((x) => x.relativePath === rel);
    if (a) place(a, 'midi', MIDI_DIR);
  }
  for (const rel of usable.stems) {
    const a = admitted.find((x) => x.relativePath === rel);
    if (a) place(a, 'stems', STEMS_DIR);
  }
  for (const rel of usable.renders) {
    const a = admitted.find((x) => x.relativePath === rel);
    if (a) place(a, 'renders', RENDERS_DIR);
  }

  // Audio the planner classified as neither stem nor render still gives the
  // recipient material; it goes to stems/ because that is what it is usable
  // as, not because we have decided it IS a stem — the tier is unchanged.
  const alreadyPlaced = new Set(copies.map((c) => c.from));
  for (const a of admitted) {
    if (alreadyPlaced.has(a.absolutePath)) continue;
    if (AUDIO_ROLES.has(a.role)) place(a, 'stems', STEMS_DIR);
  }

  const dirs = [PACKAGE_DIR];
  for (const [dir, bucket] of [[MIDI_DIR, 'midi'], [STEMS_DIR, 'stems'], [RENDERS_DIR, 'renders']] as const) {
    if (copies.some((c) => c.bucket === bucket)) dirs.push(dir);
  }

  // ── Honest warnings ───────────────────────────────────────────────────────
  if (!copies.length) warnings.push('No usable assets travelled with this project.');
  if (!input.sourceDawId) warnings.push('The DAW this project was made in is unknown, so compatibility could not be checked against it.');
  if (!dawproject) warnings.push('No DAWproject file travelled with this project, so there is no structured session to import. Wavi does not generate one.');
  if (crossDawPlan.tier === 'stems' && !input.bpm) {
    warnings.push('No tempo is recorded, so the stems will need to be aligned by ear.');
  }
  if (crossDawPlan.tier === 'render') {
    warnings.push('Only a mixdown is available — the individual tracks were not included.');
  }
  if (!usable.midi.length && crossDawPlan.tier !== 'native') {
    warnings.push('No MIDI travelled with this project, so note data cannot be edited.');
  }

  return {
    root: input.handoffRoot,
    tier: crossDawPlan.tier,
    crossDawPlan,
    dirs,
    copies,
    rejected,
    warnings,
    buildMetadata: (verified) => buildMetadataFiles(input, crossDawPlan, verified, warnings, rejected),
  };
}

function emptyPlan(input: HandoffInput, refusal: string): HandoffPlan {
  const crossDawPlan = planCrossDawHandoff({
    sourceDawId: input.sourceDawId, targetDawId: input.targetDawId, assets: [], bpm: input.bpm ?? null,
  });
  return {
    root: input.handoffRoot, tier: crossDawPlan.tier, crossDawPlan,
    dirs: [], copies: [], rejected: [], warnings: [refusal], refusal,
    buildMetadata: () => [],
  };
}

/**
 * The metadata, generated AFTER the copies.
 *
 * Deliberately built from what the caller measured rather than from the plan:
 * a manifest describing bytes that were never written is the failure this
 * whole module exists to avoid.
 */
function buildMetadataFiles(
  input: HandoffInput,
  plan: CrossDawPlan,
  verified: VerifiedCopy[],
  warnings: string[],
  rejected: HandoffPlan['rejected'],
): PackageFile[] {
  const byBucket = (b: PlannedCopy['bucket']) => verified.filter((v) => v.bucket === b);
  const stems = byBucket('stems');
  const midi = byBucket('midi');
  const renders = byBucket('renders');
  const nativeProject = plan.usable.nativeProject
    ? verified.find((v) => v.bucket === 'root' && !v.to.toLowerCase().endsWith('.dawproject'))?.to ?? null
    : null;
  const dawproject = verified.find((v) => v.to.toLowerCase().endsWith('.dawproject'))?.to ?? null;
  const mismatches = verified.filter((v) => v.mismatch).map((v) => v.to);
  const allWarnings = mismatches.length
    ? [...warnings, `${mismatches.length} file(s) did not match the checksum Wavi recorded: ${mismatches.join(', ')}. Treat them as unreliable.`]
    : warnings;

  // The wavi-extension sidecar (WAVI_SESSION_IR_SPEC). Identity, tempo if
  // genuinely known, and an asset inventory with hashes — no track, device or
  // plugin state, because none can be proven, and inventing it would make this
  // the second session format DR-015 forbids.
  const session = {
    schema: 'wavi.session/1',
    note: 'Wavi extension sidecar. Not a session format: carries identity, tempo and an asset inventory only. DAWproject remains the structured interchange format.',
    generatedAt: input.generatedAt,
    project: { name: input.projectName, sourceDaw: input.sourceDawId },
    // Only when genuinely known. Never inferred from a filename.
    tempo: input.bpm ? { bpm: input.bpm, source: 'wavi-index' } : null,
    markers: null as null,
    lineage: {
      sourceVersion: input.sourceVersionLabel ?? null,
      sourceProjectRef: input.lineage?.sourceProjectRef ?? null,
      sourceVersionRef: input.lineage?.sourceVersionRef ?? null,
    },
    assets: verified.map((v) => ({
      path: v.to, bucket: v.bucket, role: v.role, bytes: v.bytes, sha256: v.sha256,
      ...(v.mismatch ? { checksumMismatch: true } : {}),
    })),
  };

  const fidelity = {
    schema: 'wavi.fidelity/2',
    generatedAt: input.generatedAt,
    sourceDaw: input.sourceDawId,
    targetDaw: input.targetDawId,
    tier: plan.tier,
    summary: plan.summary,
    sourceVersion: input.sourceVersionLabel ?? null,
    available: {
      nativeProject,
      // Honest about WHY, not merely that it is absent.
      dawproject,
      dawprojectAbsentReason: dawproject
        ? null
        : 'No DAWproject travelled with this project. Wavi does not generate one.',
      structuredImportSupported: plan.structuredImportSupported,
      stems: stems.length,
      midi: midi.length,
      renders: renders.length,
    },
    dependencies: {
      // Plugin scanning is not implemented for any adapter, so the only honest
      // answer is that nothing was scanned — not that nothing is needed.
      scanned: false,
      known: [] as string[],
      missing: [] as string[],
      note: 'Wavi does not yet read plugin dependencies from project files, so this list is empty rather than complete.',
    },
    losses: plan.losses,
    warnings: allWarnings,
    checksumMismatches: mismatches,
    rejected,
  };

  return [
    {
      relativePath: MARKER_FILE,
      contents: [
        'This folder is a Wavi portable handoff: a DERIVED checkout, not an original project.',
        'Wavi skips it when scanning for projects, so it is never indexed or synced as new work.',
        'Deleting this file would cause Wavi to treat the copied project file here as original.',
        '',
      ].join('\n'),
    },
    { relativePath: SESSION_FILE, contents: `${JSON.stringify(session, null, 2)}\n` },
    { relativePath: FIDELITY_FILE, contents: `${JSON.stringify(fidelity, null, 2)}\n` },
    { relativePath: README_FILE, contents: renderPortableReadme(input, plan, verified, allWarnings) },
  ];
}

const TIER_HEADLINE: Record<FidelityTier, string> = {
  native: 'Opens natively in the DAW it was made in.',
  structured: 'Structured handoff — your DAW can import the included DAWproject.',
  stems: 'Stem reconstruction — rebuild the arrangement from separate audio and MIDI.',
  render: 'Mixdown only — the finished mix, not the parts.',
  none: 'Nothing in this version can be used.',
};

/**
 * The same verdict, for a person.
 *
 * Readable without Wavi installed: a recipient opening the folder in Finder
 * should understand what they have from this file alone, including what they
 * do NOT have — a handoff that oversells itself wastes somebody's afternoon.
 */
export function renderPortableReadme(
  input: HandoffInput,
  plan: CrossDawPlan,
  verified: VerifiedCopy[],
  warnings: string[],
): string {
  const L: string[] = [];
  L.push(`# ${input.projectName} — portable handoff`);
  L.push('');
  L.push(TIER_HEADLINE[plan.tier]);
  L.push('');
  L.push(plan.summary);
  L.push('');
  L.push(`- Made in: ${input.sourceDawId ?? 'unknown DAW'}`);
  L.push(`- Prepared for: ${input.targetDawId ?? 'any DAW'}`);
  L.push(input.bpm ? `- Tempo: ${input.bpm} BPM` : '- Tempo: not recorded');
  if (input.sourceVersionLabel) L.push(`- From version: ${input.sourceVersionLabel}`);
  L.push(`- Prepared: ${input.generatedAt}`);
  L.push('');

  const buckets: Array<[string, PlannedCopy['bucket']]> = [
    ['Import first — MIDI', 'midi'],
    ['Then the stems', 'stems'],
    ['Reference mix (do NOT import alongside the stems — it would double the mix)', 'renders'],
    ['For reference only', 'root'],
  ];
  const any = verified.length > 0;
  L.push(any ? '## What is here' : '## Contents');
  L.push('');
  if (!any) L.push('No usable assets travelled with this project.');
  for (const [label, bucket] of buckets) {
    const items = verified.filter((v) => v.bucket === bucket);
    if (!items.length) continue;
    L.push(`### ${label}`);
    L.push('');
    for (const v of items) L.push(`- \`${v.to}\`${v.mismatch ? ' — **checksum mismatch, unreliable**' : ''}`);
    L.push('');
  }

  if (plan.losses.length) {
    L.push('## What is NOT here');
    L.push('');
    L.push('These do not survive a handoff between different DAWs. Nothing was');
    L.push('converted, and none of the below can be recovered from the files above.');
    L.push('');
    for (const loss of plan.losses) L.push(`- ${loss}`);
    L.push('');
  }

  if (warnings.length) {
    L.push('## Worth knowing');
    L.push('');
    for (const w of warnings) L.push(`- ${w}`);
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('`wavi/fidelity.json` and `wavi/session.json` carry this information for');
  L.push('tools. Neither describes the musical session: `session.json` is a Wavi');
  L.push('metadata sidecar holding identity, tempo and an asset inventory, and');
  L.push('DAWproject remains the structured interchange format. The original');
  L.push('project file, where present, can only be opened by the DAW that made it.');
  L.push('');
  return L.join('\n');
}
