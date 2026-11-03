/**
 * Trust rules for the localhost bridge.
 *
 * The bridge listens on 127.0.0.1 so a DAW-side client can ask Wavi about the
 * user's projects. "Localhost" is not a security boundary on its own: every
 * program on the machine can reach it, and so — through the user's browser —
 * can a web page. These are the rules that decide whether a request is
 * actually from a legitimate local client.
 *
 * Pure: no I/O, no Electron, so each rule can be tested directly.
 */
import { timingSafeEqual } from 'crypto';

/** Hosts a genuine local client will address us by. */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Is the Host header one of ours?
 *
 * This is the DNS-rebinding defence. An attacker's page can point
 * `evil.example` at 127.0.0.1 and have the victim's browser send requests to
 * this server; the connection really does arrive on loopback, so checking the
 * socket address proves nothing. What distinguishes it is the Host header,
 * which still carries the attacker's domain.
 */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const host = String(hostHeader).trim().toLowerCase();
  // Split off the port, taking care with the bracketed IPv6 form.
  const idx = host.lastIndexOf(':');
  const hasPort = idx > -1 && !host.endsWith(']') && (host.startsWith('[') ? host.indexOf(']') < idx : host.indexOf(':') === idx);
  const name = hasPort ? host.slice(0, idx) : host;
  const portPart = hasPort ? host.slice(idx + 1) : null;
  if (!ALLOWED_HOSTS.has(name)) return false;
  // A port, when present, must be ours.
  return portPart === null || portPart === String(port);
}

/**
 * Did this request come from a web page?
 *
 * No legitimate client — a Max for Live device, a controller script, a native
 * plugin — sends `Origin`. A browser always does for cross-origin requests. So
 * its presence is positive evidence of the one caller class that must never
 * reach these routes, and it is refused regardless of what it claims to be.
 */
export function hasBrowserOrigin(headers: Record<string, unknown>): boolean {
  const origin = headers?.origin ?? headers?.Origin;
  return typeof origin === 'string' && origin.trim() !== '';
}

/** Bridge token shape: a v4 UUID, as `ensureToken` mints. */
export function isValidTokenFormat(token: unknown): boolean {
  return typeof token === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token);
}

/**
 * Constant-time token comparison.
 *
 * `a !== b` leaks how many leading characters matched through its timing. The
 * window is small over loopback, but the fix costs nothing and the token is
 * the only thing standing between a local process and the user's library.
 */
export function tokensMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Length differences are not secret — the token format is public — but
  // timingSafeEqual throws on a mismatch, so it is checked first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type GuardVerdict =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Everything a request must satisfy before any route sees it.
 *
 * Order matters: the host and origin checks run BEFORE the token is examined,
 * so a web page cannot use response timing or status codes to probe whether it
 * guessed the token.
 */
export function guardRequest(opts: {
  headers: Record<string, unknown>;
  port: number;
  expectedToken: string;
  requiresAuth: boolean;
}): GuardVerdict {
  if (!isAllowedHost(opts.headers?.host as string | undefined, opts.port)) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  if (hasBrowserOrigin(opts.headers)) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  if (!opts.requiresAuth) return { ok: true };
  if (!tokensMatch(opts.headers?.['x-wavi-token'], opts.expectedToken)) {
    return { ok: false, status: 401, error: 'Unauthorized — invalid or missing X-Wavi-Token' };
  }
  return { ok: true };
}

/**
 * Routes the bridge serves. Exhaustive, and deliberately so.
 *
 * `/run-command` was removed. It accepted a string, matched it against a
 * prefix allowlist, and then handed the WHOLE string to `/bin/sh -c` — so
 * `echo hi; rm -rf ~/Music` passed the allowlist and the shell ran both parts.
 * `python3 -c` and `node -e` were allowlisted outright. Nothing in Wavi ever
 * called it.
 *
 * The replacement is not a safer shell. There is no shell: a DAW client that
 * needs something asks for that thing by name through a typed route below.
 */
export const BRIDGE_ROUTES = Object.freeze([
  '/health', '/active-project', '/project-context', '/project-files',
  '/project-versions', '/latest-bounce', '/search-files', '/open-file',
  '/open-folder', '/reveal-file', '/generate-midi', '/analyze-latest-bounce',
  '/log-action', '/open-copilot-panel', '/pending-associations',
  '/confirm-association', '/classify-file', '/chat',
]);

/** Routes permanently withdrawn. Asked for by name, they return 410. */
export const WITHDRAWN_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  '/run-command': 'Removed in the bridge hardening pass: it executed arbitrary shell commands. There is no replacement by design — ask for what you need through a typed route.',
});

/** Only /health is reachable without a token. */
export function routeRequiresAuth(route: string): boolean {
  return route !== '/health';
}

// ── Opening files is also code execution ────────────────────────────────────

/**
 * Extensions macOS will EXECUTE rather than open in a viewer.
 *
 * `shell.openPath` is not a safe primitive. Handed a `.app` bundle it launches
 * the application; handed a `.command` or `.sh` it runs the script in
 * Terminal. A bridge route that opens an arbitrary path is therefore an
 * arbitrary-code-execution route wearing a friendlier name, which is precisely
 * how the shell got back in after `/run-command` was removed.
 */
const EXECUTABLE_EXTS = new Set([
  '.app', '.command', '.sh', '.bash', '.zsh', '.scpt', '.scptd', '.applescript',
  '.workflow', '.pkg', '.mpkg', '.dmg', '.jar', '.action', '.osascript',
  '.term', '.tool', '.py', '.rb', '.pl', '.php', '.js', '.mjs', '.cjs',
  '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.msi', '.scr',
]);

/** Lowercased extension, including the dot. '' when there is none. */
function extensionOf(p: string): string {
  const base = String(p).split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

export type OpenVerdict = { ok: true } | { ok: false; status: number; error: string };

/**
 * May the bridge open this path?
 *
 * Three independent conditions, each of which has to hold:
 *
 *   1. It exists. Checked by the caller, because that is I/O.
 *   2. It is INDEXED — a file Wavi already knows about from scanning the
 *      user's own library. This is the load-bearing rule: it means a caller
 *      cannot name an arbitrary path, only point at something the user
 *      already had. The main process applies the same rule to its own
 *      `shell:openPath` IPC; the bridge previously did not.
 *   3. It is not a thing macOS executes. A file can be both indexed and
 *      dangerous — dropping `payload.command` into a watched music folder is
 *      not difficult — so the type check is not redundant with the index.
 */
export function assertOpenableFile(opts: {
  filePath: unknown;
  exists: boolean;
  isIndexed: boolean;
}): OpenVerdict {
  const p = typeof opts.filePath === 'string' ? opts.filePath.trim() : '';
  if (!p) return { ok: false, status: 400, error: 'filePath required' };
  // A path with a NUL byte can mean one thing to a validator and another to
  // the syscall underneath it.
  if (p.includes('\0')) return { ok: false, status: 400, error: 'Invalid path' };
  if (!opts.exists) return { ok: false, status: 404, error: 'File not found' };
  if (!opts.isIndexed) {
    return { ok: false, status: 403, error: 'Wavi will only open files from your indexed library.' };
  }
  const ext = extensionOf(p);
  if (EXECUTABLE_EXTS.has(ext) || ext === '') {
    // No extension is refused too: without one there is nothing to decide on,
    // and an executable bit is not visible from here.
    return { ok: false, status: 403, error: 'Wavi will not open that kind of file.' };
  }
  return { ok: true };
}

/** Exposed so tests can state the rule rather than restate the list. */
export function isExecutableExtension(ext: string): boolean {
  return EXECUTABLE_EXTS.has(String(ext).toLowerCase());
}
