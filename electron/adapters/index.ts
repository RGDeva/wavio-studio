import * as path from 'path';
import type { DawAdapter, ManifestEntry } from './types';
import { abletonAdapter } from './ableton';
import { THIN_DAW_ADAPTERS, flStudioAdapter, logicAdapter, proToolsAdapter, reaperAdapter } from './daws';
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
  // No single application — the generic adapter covers DAWs we index but do
  // not know how to launch.
  applicationHints: [],
};

const ADAPTERS: DawAdapter[] = [abletonAdapter, ...THIN_DAW_ADAPTERS];

export function getAdapterById(id: string): DawAdapter {
  return ADAPTERS.find((a) => a.id === id) ?? genericAdapter;
}

/** Resolve by project file path; falls back to the generic adapter. */
export function getAdapterForFile(filePath: string | null | undefined): DawAdapter {
  if (!filePath) return genericAdapter;
  return ADAPTERS.find((a) => a.isProjectFile(filePath)) ?? genericAdapter;
}

/** Resolve by the daw_type string stored on local projects, then by path. */
/**
 * daw_type strings reaching us come from several places (local detection, the
 * watcher's display names, and server manifests), so match on both the adapter
 * id and the display name rather than assuming one spelling.
 */
const DAW_TYPE_ALIASES: Record<string, DawAdapter> = {
  'ableton': abletonAdapter, 'ableton live': abletonAdapter,
  'fl-studio': flStudioAdapter, 'fl studio': flStudioAdapter, 'flstudio': flStudioAdapter,
  'logic': logicAdapter, 'logic pro': logicAdapter, 'logicx': logicAdapter,
  'pro-tools': proToolsAdapter, 'pro tools': proToolsAdapter, 'protools': proToolsAdapter,
  'reaper': reaperAdapter,
};

export function getAdapterForProject(dawType: string | null | undefined, filePath: string | null | undefined): DawAdapter {
  if (dawType) {
    const hit = DAW_TYPE_ALIASES[dawType.trim().toLowerCase()];
    if (hit) return hit;
  }
  return getAdapterForFile(filePath);
}

/**
 * All DAW project-file extensions the app recognizes during discovery.
 * Union of real adapter claims and DAWs we index but don't yet adapt —
 * identical membership to the previous hardcoded discovery list.
 */
export const KNOWN_DAW_PROJECT_EXTENSIONS: ReadonlySet<string> = new Set([
  ...ADAPTERS.flatMap((a) => a.projectExtensions),
  '.flp', '.ptx', '.ptf', '.rpp', '.logic', '.logicx', '.band', '.npr', '.sesx', '.song', '.reason', '.bwproject', '.cpr',
]);

export type { DawAdapter, ManifestEntry };
export { abletonAdapter, flStudioAdapter, logicAdapter, proToolsAdapter, reaperAdapter };
export { resolveApplication } from './applications';
export type { ApplicationHint, ResolvedApplication } from './applications';
