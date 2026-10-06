/**
 * Pure presentation logic for the cross-DAW handoff surface.
 *
 * Kept out of the component so it is unit-testable, and kept deliberately
 * small: §11 asks for a concise statement of what the recipient can continue
 * from, not a compatibility dashboard. Six short rows and two lists.
 *
 * Honesty rule, inherited from the adapter contract and the fidelity planner:
 * never present a tier, a count or an asset as available when it is not. The
 * main process has already decided all of that — this formats it and adds
 * nothing.
 */

export type FidelityTier = 'native' | 'structured' | 'stems' | 'render' | 'none';

/** The shape `daw:buildPortableHandoff` returns. */
export interface HandoffResult {
  ok: boolean;
  root?: string;
  tier?: FidelityTier;
  summary?: string;
  losses?: string[];
  warnings?: string[];
  counts?: { stems: number; midi: number; renders: number };
  nativeProjectIncluded?: boolean;
  dawprojectIncluded?: boolean;
  failures?: Array<{ path: string; reason: string }>;
  checksumMismatches?: string[];
  error?: string;
}

/** Wavi's own words for each tier. Reused, not reinvented. */
export const TIER_LABEL: Record<FidelityTier, string> = {
  native: 'Native project',
  structured: 'Structured session',
  stems: 'Stem reconstruction',
  render: 'Render only',
  none: 'Nothing usable',
};

export type HandoffTone = 'ok' | 'muted' | 'warn';

export interface HandoffRow {
  label: string;
  value: string;
  tone: HandoffTone;
}

const DAW_NAMES: Record<string, string> = {
  ableton: 'Ableton Live',
  'fl-studio': 'FL Studio',
  logic: 'Logic Pro',
  'pro-tools': 'Pro Tools',
  reaper: 'Reaper',
};

export function dawDisplayName(id: string | null | undefined): string {
  if (!id) return 'Unknown DAW';
  return DAW_NAMES[id] ?? id;
}

/**
 * The header rows: source, target, compatibility.
 *
 * `native` is the only tier shown as 'ok'. Stem reconstruction genuinely works
 * and is genuinely lossy, so it reads as neutral rather than reassuring — a
 * green tick next to "your plugin settings are gone" would be a lie of tone.
 */
export function deriveHandoffRows(
  sourceDawId: string | null,
  targetDawId: string | null,
  result: HandoffResult | null,
): HandoffRow[] {
  const rows: HandoffRow[] = [
    { label: 'Source', value: dawDisplayName(sourceDawId), tone: sourceDawId ? 'muted' : 'warn' },
    { label: 'Open with', value: targetDawId ? dawDisplayName(targetDawId) : 'Any DAW', tone: 'muted' },
  ];
  if (!result) return rows;
  if (result.error || !result.tier) {
    rows.push({ label: 'Compatibility', value: 'Could not be prepared', tone: 'warn' });
    return rows;
  }
  rows.push({
    label: 'Compatibility',
    value: TIER_LABEL[result.tier],
    tone: result.tier === 'native' ? 'ok' : result.tier === 'none' ? 'warn' : 'muted',
  });
  return rows;
}

/**
 * What the recipient actually has.
 *
 * Zero counts are omitted rather than shown as "0 stems": a list of absences
 * belongs under "not preserved", and the losses list already says it plainly.
 */
export function deriveAvailableLines(result: HandoffResult | null): string[] {
  if (!result || !result.counts) return [];
  const out: string[] = [];
  if (result.nativeProjectIncluded) out.push('Original project file (opens in the source DAW only)');
  if (result.dawprojectIncluded) out.push('DAWproject session file');
  const { stems, midi, renders } = result.counts;
  if (stems) out.push(`${stems} stem${stems === 1 ? '' : 's'}`);
  if (midi) out.push(`${midi} MIDI file${midi === 1 ? '' : 's'}`);
  if (renders) out.push(renders === 1 ? 'Stereo reference mix' : `${renders} reference mixes`);
  if (!out.length) out.push('Nothing usable travelled with this version');
  return out;
}

/**
 * A single sentence for the surface header.
 *
 * Same-DAW is stated as such, because a recipient on the creator's DAW should
 * not be nudged toward a lossy reconstruction they do not need.
 */
export function handoffHeadline(
  sourceDawId: string | null,
  targetDawId: string | null,
  result: HandoffResult | null,
): string {
  if (!result) return 'Prepare a portable handoff to see what another DAW can use.';
  if (result.error) return result.error;
  if (result.tier === 'native') {
    return `Opens natively in ${dawDisplayName(sourceDawId)} — nothing is lost.`;
  }
  return result.summary ?? `Prepared for ${dawDisplayName(targetDawId)}.`;
}

/**
 * Problems worth interrupting the user for, as opposed to expected losses.
 *
 * A missing or corrupt asset is a different category from "automation does not
 * transfer": the first means the handoff is broken, the second means it is
 * working as designed. Keeping them apart is what stops the real failure being
 * read as more boilerplate.
 */
export function deriveHandoffProblems(result: HandoffResult | null): string[] {
  if (!result) return [];
  const problems: string[] = [];
  for (const f of result.failures ?? []) problems.push(`${f.path} — ${f.reason}`);
  for (const m of result.checksumMismatches ?? []) {
    problems.push(`${m} — does not match the checksum Wavi recorded, so it may be corrupt`);
  }
  return problems;
}
