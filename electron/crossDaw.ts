/**
 * Cross-DAW handoff planning.
 *
 * What this is
 * ------------
 * When a recipient opens a project in a DAW other than the one it was made
 * in, Wavi should not simply fail because the extension differs. This module
 * answers, from the assets that actually travelled with the project:
 *
 *   1. what DAW it came from
 *   2. what DAW it is going to
 *   3. which portable assets exist
 *   4. the highest fidelity honestly achievable
 *   5. what the recipient gets
 *   6. what is lost
 *
 * What this is NOT
 * ----------------
 * It is not a converter. Nothing here rewrites a session, and no second
 * musical-session schema is invented (DR-015: DAWproject is the structured
 * interchange format; we consume it, we do not replace it). The deliverable is
 * an honest plan plus the asset list — never a claim that a session was
 * reconstructed.
 *
 * Pure: no I/O, no Electron. The caller supplies the manifest.
 */

/** Fidelity tiers, highest first. */
export type FidelityTier = 'native' | 'structured' | 'stems' | 'render' | 'none';

export interface PortableAsset {
  /** Project-relative path, e.g. 'Stems/drums.wav'. */
  relativePath: string;
  /** Manifest role: 'project' | 'stem' | 'audio' | 'midi' | 'analysis' | … */
  role: string;
  fileSize?: number;
}

export interface CrossDawInput {
  /** Adapter id of the DAW the project was made in, e.g. 'ableton'. */
  sourceDawId: string | null;
  /** Adapter id of the DAW the recipient wants to use. */
  targetDawId: string | null;
  assets: PortableAsset[];
  /** Tempo carried in the manifest/metadata, when known. 0/null = unknown. */
  bpm?: number | null;
}

export interface CrossDawPlan {
  tier: FidelityTier;
  sourceDawId: string | null;
  targetDawId: string | null;
  /** Human-readable one-liner describing what the recipient is getting. */
  summary: string;
  /** Assets the recipient can actually use in the target DAW. */
  usable: {
    nativeProject: string | null;
    dawproject: string | null;
    stems: string[];
    midi: string[];
    renders: string[];
  };
  /** What is NOT carried across. Always populated below the native tier. */
  losses: string[];
  /**
   * True only when the target DAW can natively import the structured
   * interchange file we hold. See DAWPROJECT_IMPORT_SUPPORT.
   */
  structuredImportSupported: boolean;
}

/**
 * Which target DAWs can natively open a `.dawproject`.
 *
 * All false today, and that is the honest answer rather than a gap in this
 * table: none of Wavi's five target DAWs ship native DAWproject import
 * (Bitwig and Studio One do, and Reaper via a third-party extension — none of
 * which we can assume on a recipient's machine). This is why the realistic
 * cross-DAW tier for these five is stems + MIDI + tempo, not "structured".
 *
 * Flip an entry only when that DAW genuinely imports the format out of the
 * box; the planner's honesty depends entirely on this table being true.
 */
export const DAWPROJECT_IMPORT_SUPPORT: Readonly<Record<string, boolean>> = {
  ableton: false,
  'fl-studio': false,
  logic: false,
  'pro-tools': false,
  reaper: false,
};

const STEM_HINT = /(^|\/)(stems?|tracks?|multitrack)(\/|$)/i;
const RENDER_HINT = /(^|\/)(bounce|bounces|render|renders|master|mixdown|preview)[^/]*$/i;

function isAudio(a: PortableAsset): boolean {
  return a.role === 'stem' || a.role === 'audio';
}

/** Classify what travelled with the project. */
export function collectPortableAssets(assets: PortableAsset[]) {
  const nativeProject = assets.find((a) => a.role === 'project')?.relativePath ?? null;
  const dawproject = assets.find((a) => a.relativePath.toLowerCase().endsWith('.dawproject'))?.relativePath ?? null;
  const midi = assets.filter((a) => a.role === 'midi').map((a) => a.relativePath);

  const audio = assets.filter(isAudio);
  // A stem is an audio file explicitly marked as one, or one living under a
  // stems-like directory. Renders are mixdowns, which are NOT stems — calling
  // a single master "stems" would overstate what the recipient can remix.
  const renders = audio.filter((a) => RENDER_HINT.test(a.relativePath)).map((a) => a.relativePath);
  const stems = audio
    .filter((a) => (a.role === 'stem' || STEM_HINT.test(a.relativePath)) && !RENDER_HINT.test(a.relativePath))
    .map((a) => a.relativePath);

  // Audio that is neither clearly a stem nor clearly a render still gives the
  // recipient separate material to work with, so it counts toward stems when
  // there is more than one of them.
  const unclassified = audio
    .map((a) => a.relativePath)
    .filter((p) => !stems.includes(p) && !renders.includes(p));
  if (stems.length === 0 && unclassified.length > 1) stems.push(...unclassified);

  return { nativeProject, dawproject, stems, midi, renders, unclassified };
}

function sameDaw(a: string | null, b: string | null): boolean {
  return !!a && !!b && a === b;
}

/**
 * Decide the highest fidelity honestly achievable, and say plainly what is
 * lost. Never returns a tier the assets do not support.
 */
export function planCrossDawHandoff(input: CrossDawInput): CrossDawPlan {
  const { sourceDawId, targetDawId, bpm } = input;
  const found = collectPortableAssets(input.assets);
  const structuredImportSupported =
    !!found.dawproject && !!targetDawId && DAWPROJECT_IMPORT_SUPPORT[targetDawId] === true;

  const usable = {
    nativeProject: found.nativeProject,
    dawproject: found.dawproject,
    stems: found.stems,
    midi: found.midi,
    renders: found.renders,
  };

  // ── Native: same DAW, native project present ──────────────────────────────
  if (sameDaw(sourceDawId, targetDawId) && found.nativeProject) {
    return {
      tier: 'native', sourceDawId, targetDawId, usable, structuredImportSupported,
      summary: `Opens natively — same DAW as the creator. Nothing is lost.`,
      losses: [],
    };
  }

  const losses: string[] = [];
  if (found.nativeProject && !sameDaw(sourceDawId, targetDawId)) {
    losses.push('The original project file cannot be opened by a different DAW — it is included for reference only.');
  }
  // These never survive a stem/MIDI handoff, and saying so is the point.
  const structuralLosses = [
    'Plugin instances and their settings',
    'Automation curves',
    'Mixer routing, sends and bus structure',
    'Clip/arrangement edits beyond the rendered audio',
  ];

  // ── Structured: a DAWproject the target can actually import ───────────────
  if (structuredImportSupported && found.dawproject) {
    return {
      tier: 'structured', sourceDawId, targetDawId, usable, structuredImportSupported,
      summary: `Structured handoff: ${targetDawId} can import the included DAWproject (tracks, tempo and arrangement), plus the audio that travelled with it.`,
      losses: [...losses, 'Plugin instances and their settings', 'Anything the DAWproject format does not describe'],
    };
  }
  if (found.dawproject && !structuredImportSupported) {
    losses.push(`A DAWproject file is included, but ${targetDawId ?? 'this DAW'} cannot import it natively — it is provided for tools that can.`);
  }

  // ── Stem reconstruction: separate material the recipient can rebuild from ─
  if (found.stems.length > 0 || found.midi.length > 0) {
    const parts: string[] = [];
    if (found.stems.length) parts.push(`${found.stems.length} stem${found.stems.length === 1 ? '' : 's'}`);
    if (found.midi.length) parts.push(`${found.midi.length} MIDI file${found.midi.length === 1 ? '' : 's'}`);
    if (bpm) parts.push(`tempo ${bpm} BPM`);
    return {
      tier: 'stems', sourceDawId, targetDawId, usable, structuredImportSupported,
      summary: `Stem handoff: ${parts.join(', ')}. Import these into ${targetDawId ?? 'your DAW'} and rebuild from there.`,
      losses: [...losses, ...structuralLosses],
    };
  }

  // ── Render fallback: a mixdown only ───────────────────────────────────────
  if (found.renders.length > 0 || found.unclassified.length === 1) {
    const render = found.renders[0] ?? found.unclassified[0];
    return {
      tier: 'render', sourceDawId, targetDawId, usable: { ...usable, renders: found.renders.length ? found.renders : found.unclassified }, structuredImportSupported,
      summary: `Render only: a single mixdown (${render}). You can reference or sample it, but it cannot be taken apart.`,
      losses: [...losses, ...structuralLosses, 'Individual tracks — only the combined mix is available'],
    };
  }

  // ── Nothing usable ────────────────────────────────────────────────────────
  return {
    tier: 'none', sourceDawId, targetDawId, usable, structuredImportSupported,
    summary: sameDaw(sourceDawId, targetDawId)
      ? 'No project file or audio travelled with this version.'
      : `Nothing in this version can be used in ${targetDawId ?? 'a different DAW'}.`,
    losses: [...losses, 'No stems, MIDI or render were included'],
  };
}

/**
 * The `wavi/fidelity.json` payload — a written record of what the recipient
 * was actually given, so the claim survives outside the UI that rendered it.
 */
export function buildFidelityReport(plan: CrossDawPlan, generatedAt: string) {
  return {
    schema: 'wavi.fidelity/1',
    generatedAt,
    sourceDaw: plan.sourceDawId,
    targetDaw: plan.targetDawId,
    tier: plan.tier,
    summary: plan.summary,
    provided: plan.usable,
    losses: plan.losses,
    structuredImportSupported: plan.structuredImportSupported,
  };
}
