/**
 * Pure, Electron-free validation logic for the wavi://auth/callback deep link.
 * Extracted from main.ts so the scheme/path/replay rules can be unit tested
 * without spinning up a real Electron process.
 */

export type WaviChannel = 'production' | 'qa' | 'development';

export const PROTOCOL_SCHEMES: Record<WaviChannel, string> = {
  production: 'wavi',
  qa: 'wavi-qa',
  development: 'wavi-dev',
};

// Production retains the bundle id already distributed to real users
// (com.wavi.studio, v1.1.0 installed at /Applications/Wavi Studio.app with
// real auth tokens / Keychain entries / wavi:// registration). Changing it
// would not be an in-place update — macOS treats a new bundle id as a
// different app: Keychain-backed safeStorage can't decrypt the old token,
// electron-updater/Squirrel.Mac would install a parallel copy rather than
// upgrade, and Launch Services would need to re-bind wavi://. QA/dev use the
// new stream.wavi.studio.* namespace since they have no installed base.
export const BUNDLE_IDS: Record<WaviChannel, string> = {
  production: 'com.wavi.studio',
  qa: 'stream.wavi.studio.qa',
  development: 'stream.wavi.studio.dev',
};

export function resolveChannel(opts: { isDev: boolean; isDevApi: boolean }): WaviChannel {
  if (opts.isDev) return 'development';
  return opts.isDevApi ? 'qa' : 'production';
}

export type DeepLinkRejectReason =
  | 'scheme-mismatch'
  | 'malformed-path'
  | 'missing-credential'
  | 'replay'
  | 'invalid-url';

export type DeepLinkValidationResult =
  | { ok: true; token: string }
  | { ok: false; reason: DeepLinkRejectReason };

/**
 * Validates a deep-link URL against the scheme this build is allowed to
 * accept. A build only ever accepts its OWN channel's scheme — a QA build
 * receiving a production wavi:// callback (or vice versa) is rejected.
 */
export function validateDeepLink(url: string, expectedScheme: string): DeepLinkValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }

  const expectedProtocol = `${expectedScheme}:`;
  if (parsed.protocol !== expectedProtocol) {
    return { ok: false, reason: 'scheme-mismatch' };
  }

  const isAuthHost = parsed.hostname === 'auth';
  const isCallbackPath = parsed.pathname === '' || parsed.pathname === '/' || parsed.pathname === '/callback';
  if (!isAuthHost || !isCallbackPath) {
    return { ok: false, reason: 'malformed-path' };
  }

  const token = parsed.searchParams.get('token');
  if (!token || token.length < 10) {
    return { ok: false, reason: 'missing-credential' };
  }

  return { ok: true, token };
}

/** Bounded replay guard — caller supplies the Set so call sites control its lifetime/size. */
export function checkAndRecordReplay(token: string, seen: Set<string>, hash: (s: string) => string, maxSize = 50): boolean {
  const key = hash(token).slice(0, 16);
  if (seen.has(key)) return true; // is a replay
  seen.add(key);
  if (seen.size > maxSize) {
    const oldest = seen.values().next().value;
    if (oldest) seen.delete(oldest);
  }
  return false;
}
