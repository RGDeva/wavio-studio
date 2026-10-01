/**
 * Target-DAW support for the core workflow: detect the native project, know
 * its extension, know which application opens it, report capabilities
 * honestly.
 *
 * Before these adapters existed, every DAW except Ableton resolved to
 * `genericAdapter` with `sameDawOpen: false`, so four of the five target DAWs
 * looked unsupported even though restore worked for them.
 */
import { describe, it, expect } from 'vitest';
import {
  getAdapterForFile, getAdapterForProject, getAdapterById, genericAdapter,
  flStudioAdapter, logicAdapter, proToolsAdapter, reaperAdapter,
  abletonAdapter, resolveApplication, KNOWN_DAW_PROJECT_EXTENSIONS,
} from './index';

const TARGETS = [
  { adapter: abletonAdapter, id: 'ableton', file: '/m/Song.als' },
  { adapter: flStudioAdapter, id: 'fl-studio', file: '/m/Song.flp' },
  { adapter: logicAdapter, id: 'logic', file: '/m/Song.logicx' },
  { adapter: proToolsAdapter, id: 'pro-tools', file: '/m/Song.ptx' },
  { adapter: reaperAdapter, id: 'reaper', file: '/m/Song.rpp' },
];

describe('all five target DAWs are adapted', () => {
  it.each(TARGETS)('$id resolves from its project file', ({ id, file }) => {
    expect(getAdapterForFile(file).id).toBe(id);
  });

  it.each(TARGETS)('$id reports same-DAW open', ({ adapter }) => {
    // This is the capability a recipient needs: the restored native project
    // opens in its own DAW. It requires no session parsing.
    expect(adapter.capabilities().sameDawOpen).toBe(true);
  });

  it.each(TARGETS)('$id does NOT claim cross-DAW reconstruction or plugin scanning', ({ adapter }) => {
    // Honesty rule: never report a capability that is not implemented.
    // Nothing reconstructs a session and nothing scans plugins.
    const c = adapter.capabilities();
    expect(c.crossDawReconstruct).toBe(false);
    expect(c.scanPlugins).toBe(false);
  });

  it.each(TARGETS)('$id reports fidelity, which is implemented, without implying conversion', ({ adapter }) => {
    // crossDaw.ts produces a real tier + provided + losses report. Reporting
    // what a recipient gets is NOT reconstruction — the pair of assertions
    // here is what keeps those two distinct.
    expect(adapter.capabilities().fidelityReport).toBe(true);
    expect(adapter.capabilities().crossDawReconstruct).toBe(false);
  });

  it('Logic does not claim native packaging — .logicx is a package directory', () => {
    // Packing a package directory through the manifest builder is unverified;
    // claiming it would promise a transfer we have not proven.
    expect(logicAdapter.capabilities().packageNative).toBe(false);
    expect(flStudioAdapter.capabilities().packageNative).toBe(true);
  });

  it('an unknown extension still falls through to the generic adapter', () => {
    expect(getAdapterForFile('/m/Song.unknownext').id).toBe('generic');
    expect(genericAdapter.capabilities().sameDawOpen).toBe(false);
  });
});

describe('daw_type resolution tolerates the spellings actually in circulation', () => {
  // These strings arrive from local detection, the watcher's display names and
  // server manifests, so matching only one spelling silently degrades to the
  // generic adapter.
  it.each([
    ['ableton', 'ableton'], ['Ableton Live', 'ableton'],
    ['fl-studio', 'fl-studio'], ['FL Studio', 'fl-studio'],
    ['logic', 'logic'], ['Logic Pro', 'logic'],
    ['pro-tools', 'pro-tools'], ['Pro Tools', 'pro-tools'],
    ['reaper', 'reaper'], ['REAPER', 'reaper'],
  ])('%s → %s', (dawType, expected) => {
    expect(getAdapterForProject(dawType, null).id).toBe(expected);
  });

  it('falls back to the file path when daw_type is unknown', () => {
    expect(getAdapterForProject('nonsense', '/m/Song.flp').id).toBe('fl-studio');
  });

  it('falls back to generic when neither identifies a DAW', () => {
    expect(getAdapterForProject(null, null).id).toBe('generic');
    expect(getAdapterById('not-a-daw').id).toBe('generic');
  });
});

describe('.logicx is recognised as a DAW project extension', () => {
  it('is in the known set used by discovery and the sample-library heuristic', () => {
    // It was missing, so a Logic project counted as zero project files and a
    // Logic folder full of audio could be misread as a sample library.
    expect(KNOWN_DAW_PROJECT_EXTENSIONS.has('.logicx')).toBe(true);
  });
});

describe('resolveApplication', () => {
  const listing: Record<string, string[]> = {
    '/Applications': [
      'Ableton Live 12 Suite.app',
      'Ableton Live 12 Beta.app',
      'FL Studio 2024.app',
      'Safari.app',
    ],
  };
  const list = (dir: string) => listing[dir] ?? [];

  it('matches a versioned bundle name by prefix', () => {
    // An absolute '/Applications/FL Studio.app' would match nothing real.
    expect(resolveApplication(flStudioAdapter.applicationHints, list))
      .toEqual({ path: '/Applications/FL Studio 2024.app', name: 'FL Studio 2024.app' });
  });

  it('prefers a stable release over a beta when both are installed', () => {
    // Opening a collaborator's project in a beta build is a worse default.
    expect(resolveApplication(abletonAdapter.applicationHints, list)?.name)
      .toBe('Ableton Live 12 Suite.app');
  });

  it('returns null when the DAW is not installed, rather than throwing', () => {
    // A recipient not having the source DAW is normal, not an error.
    expect(resolveApplication(reaperAdapter.applicationHints, list)).toBeNull();
  });

  it('survives an unreadable directory', () => {
    const throwing = () => { throw new Error('EACCES'); };
    expect(resolveApplication(logicAdapter.applicationHints, throwing)).toBeNull();
  });

  it('never matches an unrelated application', () => {
    expect(resolveApplication([{ directory: '/Applications', namePrefix: 'Saf' }], list)?.name)
      .toBe('Safari.app');
    expect(resolveApplication(proToolsAdapter.applicationHints, list)).toBeNull();
  });
});
