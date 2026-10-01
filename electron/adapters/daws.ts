/**
 * Thin adapters for the remaining target DAWs: FL Studio, Logic Pro,
 * Pro Tools and Reaper.
 *
 * Scope is deliberately the minimum the core workflow needs (see §12 of the
 * core-workflow milestone): detect the native project, know its extension,
 * know which application opens it, and report capabilities honestly. These
 * adapters do NOT parse session internals — that is not required to receive a
 * project, open it in its own DAW, or send work back, and nothing here should
 * become a release gate.
 *
 * Before this existed, every DAW except Ableton resolved to `genericAdapter`,
 * which reports `sameDawOpen: false`. Restoring an FL or Reaper project worked,
 * but the compatibility surface correctly said same-DAW open was unavailable —
 * so four of the five target DAWs looked unsupported.
 *
 * No Electron imports: vitest exercises these directly.
 */
import type { DawAdapter } from './types';
import { safeRelativePath, classifyFileRole, findPreviewCandidate, locateProjectFile } from './common';
import type { ApplicationHint } from './applications';

/** Shared shape — only identity, extensions and launch target differ. */
function thinAdapter(spec: {
  id: string;
  displayName: string;
  extensions: string[];
  applicationHints: ApplicationHint[];
  /**
   * Whether the native project packs reliably today. False for package
   * DIRECTORY projects: packing those recursively through the manifest builder
   * is unverified, and claiming otherwise would promise a transfer we have not
   * proven.
   */
  packageNative: boolean;
}): DawAdapter {
  const exts = spec.extensions.map((e) => e.toLowerCase());
  return {
    id: spec.id,
    displayName: spec.displayName,
    projectExtensions: exts,
    isProjectFile: (filePath) => {
      const lower = filePath.toLowerCase();
      return exts.some((e) => lower.endsWith(e));
    },
    classifyFileRole,
    safeRelativePath,
    manifestExtras: () => [],
    findPreviewCandidate,
    // Honest: we do not read these formats' internals. Returning zeros is the
    // documented "unknown" contract, not a parse failure.
    extractMetadata: async () => ({ bpm: 0, key: '' }),
    capabilities: () => ({
      detect: true,
      packageNative: spec.packageNative,
      restore: true,
      // The restored native project opens in its own DAW via the OS handler or
      // the resolved application bundle. This is the capability the recipient
      // actually needs, and it works without parsing the session.
      sameDawOpen: true,
      crossDawReconstruct: false,
      scanPlugins: false,
      fidelityReport: false,
    }),
    locateProjectFile,
    applicationHints: spec.applicationHints,
  };
}

export const flStudioAdapter = thinAdapter({
  id: 'fl-studio',
  displayName: 'FL Studio',
  extensions: ['.flp'],
  // Installed names carry the year, e.g. "FL Studio 2024.app".
  applicationHints: [{ directory: '/Applications', namePrefix: 'FL Studio' }],
  packageNative: true,
});

export const logicAdapter = thinAdapter({
  id: 'logic',
  displayName: 'Logic Pro',
  // .logicx is a package DIRECTORY, not a file; discovery records it as one
  // project and never descends into it.
  extensions: ['.logicx', '.logic'],
  applicationHints: [{ directory: '/Applications', namePrefix: 'Logic Pro' }],
  packageNative: false,
});

export const proToolsAdapter = thinAdapter({
  id: 'pro-tools',
  displayName: 'Pro Tools',
  extensions: ['.ptx', '.ptf'],
  applicationHints: [{ directory: '/Applications', namePrefix: 'Pro Tools' }],
  packageNative: true,
});

export const reaperAdapter = thinAdapter({
  id: 'reaper',
  displayName: 'Reaper',
  extensions: ['.rpp'],
  applicationHints: [{ directory: '/Applications', namePrefix: 'REAPER' }],
  packageNative: true,
});

export const THIN_DAW_ADAPTERS: DawAdapter[] = [
  flStudioAdapter,
  logicAdapter,
  proToolsAdapter,
  reaperAdapter,
];
