/**
 * Which applications Wavi may launch.
 *
 * `shell:openWithApp` exists so "Open in Ableton" works, and it ends in
 * `execFile(appPath, [file])` on Windows and `open -a appPath file` on macOS.
 * Its original guard checked for `; & | \`` in the path, which defends against
 * an injection that cannot happen — `execFile` takes an argv array and never
 * invokes a shell — while the real exposure, *which binary runs*, accepted any
 * existing path.
 *
 * The first fix required an `.app` bundle at the top level of an Applications
 * folder. That is still far too wide: `/Applications/Terminal.app`,
 * `Script Editor.app` and `Automator.app` all satisfy it, and each is a
 * general-purpose code-execution engine. So does any bundle an attacker drops
 * into `/Applications`.
 *
 * The rule now is identity, not shape: **the path must be one of the DAW
 * applications the adapters themselves resolved on this machine.** That is the
 * same mechanism that populates "Open in <DAW>", so the launch allowlist
 * cannot drift from the feature it serves.
 *
 * Two things this deliberately does NOT do:
 *
 *   - Trust a bundle NAME. "Ableton Live 12.app" proves nothing; anyone can
 *     name a bundle that. Only a path the resolver returned is accepted.
 *   - Trust an `Info.plist` identifier, for the same reason — it is attacker-
 *     controlled data inside the very bundle being judged.
 *
 * Symlinks are resolved before comparison, so a link in an Applications folder
 * pointing at `/Applications/Utilities/Terminal.app` is compared as Terminal.
 *
 * Pure: the caller supplies the resolved DAW set and the canonical paths.
 */

export type LaunchVerdict = { ok: true; appPath: string } | { ok: false; error: string };

function normalise(p: string): string {
  return p.replace(/\/+/g, '/').replace(/\/+$/, '');
}

/** Case-insensitive on macOS and Windows, both of which have case-insensitive filesystems by default. */
function sameePath(a: string, b: string): boolean {
  return normalise(a).toLowerCase() === normalise(b).toLowerCase();
}

export interface LaunchGuardInput {
  /** What the caller asked to launch. Untrusted. */
  appPath: unknown;
  platform: NodeJS.Platform | string;
  /**
   * `appPath` with every symlink resolved, or null when it could not be
   * resolved (which includes "does not exist").
   */
  canonicalPath: string | null;
  /**
   * Canonical paths of the DAW applications the adapters resolved on this
   * machine. Empty means no supported DAW is installed, and nothing launches.
   */
  allowedApplications: readonly string[];
}

/**
 * May Wavi launch this?
 *
 * Shape is checked first so the error a user sees names the obvious problem,
 * but the decision is the identity match — shape alone can never admit
 * anything.
 */
export function validateLaunchApplication(input: LaunchGuardInput): LaunchVerdict {
  const raw = typeof input.appPath === 'string' ? input.appPath.trim() : '';
  if (!raw) return { ok: false, error: 'appPath must be a non-empty string' };
  if (raw.includes('\0')) return { ok: false, error: 'Invalid application path' };
  // A genuine DAW path never contains '..'; its presence is a signal, not an
  // inconvenience to be resolved away.
  if (raw.split(/[\\/]/).includes('..')) return { ok: false, error: 'Invalid application path' };

  if (input.platform === 'darwin' && !normalise(raw).toLowerCase().endsWith('.app')) {
    return { ok: false, error: 'Wavi can only launch a DAW application bundle (.app).' };
  }
  if (input.platform === 'win32' && !normalise(raw).toLowerCase().endsWith('.exe')) {
    return { ok: false, error: 'Wavi can only launch a DAW application (.exe).' };
  }
  if (input.platform !== 'darwin' && input.platform !== 'win32') {
    // Wavi ships no DAW integration elsewhere, and "execute this path" is not
    // a capability to grant by default.
    return { ok: false, error: 'Launching a DAW is not supported on this platform.' };
  }

  if (!input.canonicalPath) {
    return { ok: false, error: 'DAW application not found. Update the path in Settings → DAW Applications.' };
  }

  if (!input.allowedApplications.length) {
    return {
      ok: false,
      error: 'Wavi could not find a supported DAW installed (Ableton Live, FL Studio, Logic Pro, Pro Tools or REAPER).',
    };
  }

  // The decision. Compared on CANONICAL paths, so a symlink pointing at
  // Terminal is judged as Terminal rather than as whatever it was named.
  const matched = input.allowedApplications.some((allowed) => sameePath(allowed, input.canonicalPath!));
  if (!matched) {
    return {
      ok: false,
      error: 'Wavi only launches the DAW applications it detected on this machine: Ableton Live, FL Studio, Logic Pro, Pro Tools or REAPER.',
    };
  }

  // Return the canonical path: whatever is executed should be the thing that
  // was judged, not the string that was supplied.
  return { ok: true, appPath: input.canonicalPath };
}
