/**
 * Wavi launches DAWs, and nothing else.
 *
 * The exposure this closes arrived in two stages, and the second is the
 * instructive one. `shell:openWithApp` originally accepted any existing path,
 * guarded by a check for `; & | \`` — meaningless against `execFile`, which
 * takes an argv array and never invokes a shell. The first fix required an
 * `.app` bundle at the top level of an Applications folder, which sounds
 * strict and is not: `/Applications/Utilities/Terminal.app`,
 * `Script Editor.app` and `Automator.app` all satisfy it, and each is a
 * general-purpose code-execution engine.
 *
 * Shape was never going to be enough. The rule is identity: the path must be
 * one the DAW adapters themselves resolved on this machine.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateLaunchApplication } from './appLaunchGuard';
import { resolveApplication } from './adapters/applications';
import { ALL_DAW_ADAPTERS } from './adapters';

/** What the resolver would return on a machine with these DAWs installed. */
const INSTALLED = [
  '/Applications/Ableton Live 12 Suite.app',
  '/Applications/FL Studio 2024.app',
  '/Applications/Logic Pro.app',
  '/Applications/Pro Tools.app',
  '/Applications/REAPER.app',
];

const mac = (over: Record<string, unknown> = {}) => ({
  platform: 'darwin' as const,
  allowedApplications: INSTALLED,
  ...over,
});

describe('only a resolved DAW application launches', () => {
  it('accepts each installed DAW, version suffixes and all', () => {
    for (const app of INSTALLED) {
      const r = validateLaunchApplication({ appPath: app, canonicalPath: app, ...mac() });
      expect(r.ok, app).toBe(true);
    }
  });

  it('REJECTS Terminal, Script Editor and Automator', () => {
    // Each is a top-level .app in an Applications folder, so the previous
    // shape-based rule admitted all three.
    for (const app of [
      '/Applications/Utilities/Terminal.app',
      '/Applications/Utilities/Script Editor.app',
      '/Applications/Automator.app',
      '/System/Applications/Utilities/Terminal.app',
    ]) {
      const r = validateLaunchApplication({ appPath: app, canonicalPath: app, ...mac() });
      expect(r.ok, app).toBe(false);
      expect(!r.ok && r.error).toMatch(/only launches the DAW applications/);
    }
  });

  it('REJECTS an attacker bundle dropped into /Applications', () => {
    const r = validateLaunchApplication({
      appPath: '/Applications/Evil.app', canonicalPath: '/Applications/Evil.app', ...mac(),
    });
    expect(r.ok).toBe(false);
  });

  it('a convincing NAME proves nothing', () => {
    // Anyone can name a bundle "Ableton Live 99.app". Only a path the resolver
    // returned is accepted.
    const fake = '/Applications/Ableton Live 99 Suite.app';
    expect(validateLaunchApplication({ appPath: fake, canonicalPath: fake, ...mac() }).ok).toBe(false);
  });

  it('REJECTS a symlink escaping to Terminal', () => {
    // The link sits in /Applications and is named like a DAW; its canonical
    // target is what gets judged.
    const r = validateLaunchApplication({
      appPath: '/Applications/Ableton Live 12 Suite.app',
      canonicalPath: '/Applications/Utilities/Terminal.app',
      ...mac(),
    });
    expect(r.ok).toBe(false);
  });

  it('accepts a symlink whose target IS a resolved DAW', () => {
    // Legitimate: a link in ~/Applications pointing at the real install.
    const r = validateLaunchApplication({
      appPath: '/Users/x/Applications/Ableton.app',
      canonicalPath: '/Applications/Ableton Live 12 Suite.app',
      ...mac(),
    });
    expect(r.ok).toBe(true);
    // And what executes is the canonical path that was judged, not the input.
    expect(r.ok && r.appPath).toBe('/Applications/Ableton Live 12 Suite.app');
  });

  it('REJECTS a nested bundle inside a real DAW', () => {
    const nested = '/Applications/Ableton Live 12 Suite.app/Contents/Resources/evil.app';
    expect(validateLaunchApplication({ appPath: nested, canonicalPath: nested, ...mac() }).ok).toBe(false);
  });

  it('REJECTS arbitrary binaries', () => {
    for (const bin of ['/bin/sh', '/usr/bin/osascript', '/usr/bin/python3', '/usr/bin/curl']) {
      expect(validateLaunchApplication({ appPath: bin, canonicalPath: bin, ...mac() }).ok, bin).toBe(false);
    }
  });

  it('REJECTS traversal, NUL, empty and unresolvable paths', () => {
    expect(validateLaunchApplication({ appPath: '/Applications/../bin/sh', canonicalPath: '/bin/sh', ...mac() }).ok).toBe(false);
    expect(validateLaunchApplication({ appPath: '/Applications/x.app\u0000', canonicalPath: '/bin/sh', ...mac() }).ok).toBe(false);
    expect(validateLaunchApplication({ appPath: '', canonicalPath: null, ...mac() }).ok).toBe(false);
    expect(validateLaunchApplication({ appPath: '/Applications/Gone.app', canonicalPath: null, ...mac() }).ok).toBe(false);
    expect(validateLaunchApplication({ appPath: null, canonicalPath: null, ...mac() }).ok).toBe(false);
  });

  it('launches nothing when no supported DAW is installed', () => {
    // Fails closed: an empty allowlist admits nothing, rather than falling
    // back to "any .app".
    const r = validateLaunchApplication({
      appPath: '/Applications/Ableton Live 12 Suite.app',
      canonicalPath: '/Applications/Ableton Live 12 Suite.app',
      platform: 'darwin', allowedApplications: [],
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/could not find a supported DAW/);
  });

  it('applies the same identity rule on Windows, and refuses other platforms', () => {
    const win = { platform: 'win32' as const, allowedApplications: ['C:/Program Files/Image-Line/FL Studio 2024/FL64.exe'] };
    expect(validateLaunchApplication({
      appPath: 'C:/Program Files/Image-Line/FL Studio 2024/FL64.exe',
      canonicalPath: 'C:/Program Files/Image-Line/FL Studio 2024/FL64.exe', ...win,
    }).ok).toBe(true);
    // cmd.exe is shape-valid and not a resolved DAW. The earlier version of
    // this guard allowed it.
    expect(validateLaunchApplication({
      appPath: 'C:/Windows/System32/cmd.exe', canonicalPath: 'C:/Windows/System32/cmd.exe', ...win,
    }).ok).toBe(false);
    expect(validateLaunchApplication({
      appPath: '/usr/bin/ardour', canonicalPath: '/usr/bin/ardour',
      platform: 'linux', allowedApplications: [],
    }).ok).toBe(false);
  });
});

describe('the allowlist comes from the real resolver', () => {
  it('resolves DAW bundles from a directory listing, preserving version suffixes', () => {
    // Same mechanism that powers "Open in <DAW>", so the launch allowlist
    // cannot drift from the feature it serves.
    const listing = () => [
      'Ableton Live 12 Suite.app', 'Ableton Live 12 Beta.app',
      'FL Studio 2024.app', 'Terminal.app', 'Evil.app',
    ];
    const ableton = ALL_DAW_ADAPTERS.find((a) => a.id === 'ableton')!;
    const resolved = resolveApplication(ableton.applicationHints, listing);
    expect(resolved?.name).toBe('Ableton Live 12 Suite.app');   // stable preferred over beta
    expect(resolved?.path).toBe('/Applications/Ableton Live 12 Suite.app');
  });

  it('the resolver never returns an unrelated application', () => {
    const listing = () => ['Terminal.app', 'Automator.app', 'Script Editor.app'];
    for (const adapter of ALL_DAW_ADAPTERS) {
      expect(resolveApplication(adapter.applicationHints, listing), adapter.id).toBeNull();
    }
  });

  it('covers all five supported DAWs', () => {
    expect(ALL_DAW_ADAPTERS.map((a) => a.id).sort())
      .toEqual(['ableton', 'fl-studio', 'logic', 'pro-tools', 'reaper']);
  });
});

// ── Main-process wiring ────────────────────────────────────────────────────
// The guards above are pure, so they can be wrong in exactly one way that
// matters: by not being called. These assert the real handlers in main.ts use
// them, which is the half a pure test cannot reach.

const MAIN = readFileSync(join(__dirname, 'main.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** The body of an ipcMain.handle(...) block, by channel name. */
function handlerBody(channel: string): string {
  const i = MAIN.indexOf(`ipcMain.handle('${channel}'`);
  expect(i, `handler ${channel} not found`).toBeGreaterThan(-1);
  return MAIN.slice(i, MAIN.indexOf("ipcMain.handle('", i + 10));
}

describe('main-process handlers actually call the guards', () => {
  it('shell:openWithApp decides by resolved-DAW identity', () => {
    const body = handlerBody('shell:openWithApp');
    expect(body).toContain('validateLaunchApplication');
    expect(body).toContain('allowedApplications: resolvedDawApplications()');
    expect(body).toContain('canonicalPath: canonicalPathOrNull(appPath)');
    // It must execute the path it judged, not the one it was handed.
    expect(body).toContain('launch.appPath');
    expect(body).not.toMatch(/execFile\(\s*appPath/);
    expect(body).not.toMatch(/'-a',\s*appPath/);
    // And the obsolete metacharacter theatre is gone.
    expect(body).not.toContain('Shell metacharacters');
  });

  it('shell:openPath requires an indexed file AND refuses executable types', () => {
    const body = handlerBody('shell:openPath');
    expect(body).toContain('requireIndexed: true');
    expect(body).toContain('isOpenableByType');
  });

  it('the assistant’s openPath dependency is guarded, not raw', () => {
    // It is reachable from a tool, so an unvalidated openPath here would be a
    // model-authored launch.
    expect(MAIN).not.toMatch(/openPath:\s*\(p:\s*string\)\s*=>\s*\{\s*void shell\.openPath\(p\);\s*\}/);
    const i = MAIN.indexOf('openPath: (p: string) =>');
    const dep = MAIN.slice(i, i + 400);
    expect(dep).toContain('requireIndexed: true');
    expect(dep).toContain('isOpenableByType');
    expect(dep).toContain('shell.openPath(v.resolved)');
  });

  it('type checking resolves symlinks before judging the extension', () => {
    // A link named track.wav pointing at a .command would otherwise pass.
    const i = MAIN.indexOf('function isOpenableByType');
    const fn = MAIN.slice(i, i + 500);
    expect(fn).toContain('canonicalPathOrNull');
    expect(fn).toContain('isExecutableExtension');
  });

  it('legitimate creative files remain openable', () => {
    // The rule is a denylist of executable types, not an allowlist of audio —
    // so .wav, .als, .flp, .mid, .logicx and the rest keep working.
    const i = MAIN.indexOf('function isOpenableByType');
    const fn = MAIN.slice(i, i + 500);
    expect(fn).not.toMatch(/\.wav|\.mp3|\.als|\.flp|\.mid/);
  });
});
