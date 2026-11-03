/**
 * Which applications Wavi may launch.
 *
 * `shell:openWithApp` exists so "Open in Ableton" works, and it ends in
 * `execFile(appPath, [file])` on Windows and `open -a appPath file` on macOS.
 * Its only guard was a check for `; & | \`` in the path — which does nothing,
 * because `execFile` takes an argv array and never involves a shell. The
 * metacharacter filter was defending against an injection that could not
 * happen while the real exposure — *which binary gets executed* — was
 * unchecked. Any executable on disk qualified.
 *
 * The rule here is the one that matches how DAWs are actually installed: a
 * launchable application is an `.app` bundle in an applications directory (or
 * an `.exe` on Windows). That keeps every DAW Wavi supports working — all five
 * adapters resolve to `/Applications/<Name>.app` — while `/bin/sh`,
 * `/usr/bin/python3` and a dropped binary in Downloads stop qualifying.
 *
 * Pure: the caller supplies the filesystem facts.
 */

/** Directories a real application lives in. */
const MAC_APP_ROOTS = [
  '/Applications',
  '/System/Applications',
  '/Developer/Applications',
  '/Network/Applications',
];

export type LaunchVerdict = { ok: true; appPath: string } | { ok: false; error: string };

function normalise(p: string): string {
  // Collapse duplicate separators and strip a trailing one so '/Applications//X.app/'
  // and '/Applications/X.app' are the same path to the rules below.
  return p.replace(/\/+/g, '/').replace(/\/+$/, '');
}

/** Is `candidate` inside `root` (and not merely prefixed by its name)? */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + '/');
}

/**
 * May Wavi launch this application?
 *
 * `homeDir` admits `~/Applications`, where users legitimately install DAWs
 * without admin rights.
 */
export function validateLaunchApplication(opts: {
  appPath: unknown;
  platform: NodeJS.Platform | string;
  homeDir: string;
  /** Does the path exist? */
  exists: boolean;
  /** Is it a directory? A macOS .app bundle is one; a bare binary is not. */
  isDirectory: boolean;
}): LaunchVerdict {
  const raw = typeof opts.appPath === 'string' ? opts.appPath.trim() : '';
  if (!raw) return { ok: false, error: 'appPath must be a non-empty string' };
  // A NUL can mean one thing to this check and another to the syscall under it.
  if (raw.includes('\0')) return { ok: false, error: 'Invalid application path' };
  // Traversal is rejected outright rather than resolved: a legitimate DAW path
  // never contains '..', so its presence is a signal, not an inconvenience.
  if (raw.split('/').includes('..')) return { ok: false, error: 'Invalid application path' };
  if (!raw.startsWith('/') && opts.platform === 'darwin') {
    return { ok: false, error: 'Application path must be absolute' };
  }

  const appPath = normalise(raw);
  if (!opts.exists) {
    return { ok: false, error: 'DAW application not found. Update the path in Settings → DAW Applications.' };
  }

  if (opts.platform === 'darwin') {
    // The shape check is what stops an arbitrary binary: /bin/sh exists and is
    // executable, and it is not an application bundle.
    if (!appPath.toLowerCase().endsWith('.app')) {
      return { ok: false, error: 'Wavi can only launch an application bundle (.app).' };
    }
    if (!opts.isDirectory) {
      return { ok: false, error: 'That .app is not an application bundle.' };
    }
    const roots = [...MAC_APP_ROOTS, `${normalise(opts.homeDir)}/Applications`];
    if (!roots.some((r) => isInside(r, appPath))) {
      return { ok: false, error: 'Wavi only launches applications installed in an Applications folder.' };
    }
    // Nested bundles are how a payload hides inside something that looks
    // installed: /Applications/Real.app/Contents/Resources/evil.app.
    const depthInsideRoot = appPath.split('/').filter(Boolean).length;
    const rootDepth = roots
      .filter((r) => isInside(r, appPath))
      .map((r) => r.split('/').filter(Boolean).length)[0] ?? 0;
    if (depthInsideRoot !== rootDepth + 1) {
      return { ok: false, error: 'Wavi only launches applications at the top level of an Applications folder.' };
    }
    return { ok: true, appPath };
  }

  if (opts.platform === 'win32') {
    if (!appPath.toLowerCase().endsWith('.exe')) {
      return { ok: false, error: 'Wavi can only launch an .exe application.' };
    }
    return { ok: true, appPath };
  }

  // Linux and anything else: Wavi ships no DAW integration there, and
  // "execute this path" is not a capability to grant by default.
  return { ok: false, error: 'Launching a DAW is not supported on this platform.' };
}
