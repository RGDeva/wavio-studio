import * as path from 'path';
import type { DawAdapter, ManifestEntry } from './types';
import { abletonAdapter } from './ableton';
import { safeRelativePath, classifyFileRole, findPreviewCandidate, locateProjectFile } from './common';

/**
 * DAW adapter registry (Phase F). Ableton is the first real adapter; every
 * other DAW currently falls through to the generic adapter, which applies the
 * shared classification/exclusion rules and no DAW-specific manifest extras —
 * exactly the pre-extraction behavior for non-Ableton projects.
 */

export const genericAdapter: DawAdapter = {
  id: 'generic',
  displayName: 'DAW project',
  projectExtensions: [],
  isProjectFile: () => false,
  classifyFileRole,
  safeRelativePath,
  manifestExtras: () => [],
  findPreviewCandidate,
  extractMetadata: async () => ({ bpm: 0, key: '' }),
  // Generic DAWs: restore works (DAW-agnostic), but no native detection,
  // packaging extras, guaranteed same-DAW open, plugin scan, or fidelity yet.
  capabilities: () => ({
    detect: false, packageNative: false, restore: true, sameDawOpen: false,
    crossDawReconstruct: false, scanPlugins: false, fidelityReport: false,
  }),
  locateProjectFile,
};

const ADAPTERS: DawAdapter[] = [abletonAdapter];

export function getAdapterById(id: string): DawAdapter {
  return ADAPTERS.find((a) => a.id === id) ?? genericAdapter;
}

/** Resolve by project file path; falls back to the generic adapter. */
export function getAdapterForFile(filePath: string | null | undefined): DawAdapter {
  if (!filePath) return genericAdapter;
  return ADAPTERS.find((a) => a.isProjectFile(filePath)) ?? genericAdapter;
}

/** Resolve by the daw_type string stored on local projects, then by path. */
export function getAdapterForProject(dawType: string | null | undefined, filePath: string | null | undefined): DawAdapter {
  if (dawType === 'ableton' || dawType === 'Ableton Live') return abletonAdapter;
  return getAdapterForFile(filePath);
}

/**
 * All DAW project-file extensions the app recognizes during discovery.
 * Union of real adapter claims and DAWs we index but don't yet adapt —
 * identical membership to the previous hardcoded discovery list.
 */
export const KNOWN_DAW_PROJECT_EXTENSIONS: ReadonlySet<string> = new Set([
  ...ADAPTERS.flatMap((a) => a.projectExtensions),
  '.flp', '.ptx', '.ptf', '.rpp', '.logic', '.band', '.npr', '.sesx', '.song', '.reason', '.bwproject', '.cpr',
]);

export type { DawAdapter, ManifestEntry };
export { abletonAdapter };
