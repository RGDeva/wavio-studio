/**
 * Pure presentation logic for the Project Detail compatibility surface.
 * Turns a DAW capability report (from the main-process adapter via
 * `daw:getCapabilities`) into honest display rows. Kept out of the component so
 * it is unit-testable under node vitest.
 *
 * Honesty rule (mirrors the adapter contract): never show "Available" for a
 * capability the app does not actually implement yet.
 */

export interface DawCapabilities {
  detect: boolean;
  packageNative: boolean;
  restore: boolean;
  sameDawOpen: boolean;
  crossDawReconstruct: boolean;
  scanPlugins: boolean;
  fidelityReport: boolean;
}

export interface DawCapabilityReport {
  id: string;
  displayName: string;
  capabilities: DawCapabilities;
}

export type CompatTone = 'ok' | 'muted' | 'warn';

export interface CompatRow {
  label: string;
  value: string;
  tone: CompatTone;
}

/**
 * Derive the compatibility rows for the source project's own DAW. This is the
 * "what can Wavi do with THIS project today" view — not a speculative
 * every-target matrix. Cross-DAW / plugin scan / fidelity are surfaced as
 * "Planned" / "Not yet" until implemented, never as available.
 */
export function deriveCompatibilityRows(report: DawCapabilityReport | null): CompatRow[] {
  if (!report) return [];
  const c = report.capabilities;

  const sameDaw: CompatRow = c.sameDawOpen
    ? { label: `Open in ${report.displayName}`, value: 'Available', tone: 'ok' }
    : c.restore
      ? { label: 'Open in DAW', value: 'Project Pack only', tone: 'muted' }
      : { label: 'Open in DAW', value: 'Unsupported', tone: 'warn' };

  return [
    sameDaw,
    { label: 'Native packaging', value: c.packageNative ? 'Included' : 'Generic pack', tone: c.packageNative ? 'ok' : 'muted' },
    { label: 'Restore', value: c.restore ? 'Supported' : 'Unsupported', tone: c.restore ? 'ok' : 'warn' },
    { label: 'Cross-DAW reconstruction', value: c.crossDawReconstruct ? 'Supported' : 'Planned', tone: 'muted' },
    { label: 'Plugin scan', value: c.scanPlugins ? 'Yes' : 'Not yet', tone: 'muted' },
    { label: 'Fidelity report', value: c.fidelityReport ? 'Yes' : 'Not yet', tone: 'muted' },
  ];
}

/** One-line headline for the card header. */
export function compatibilityHeadline(report: DawCapabilityReport | null): string {
  if (!report) return 'Compatibility unavailable';
  return report.capabilities.sameDawOpen
    ? `Native open in ${report.displayName}`
    : `Universal Project Pack (${report.displayName})`;
}
