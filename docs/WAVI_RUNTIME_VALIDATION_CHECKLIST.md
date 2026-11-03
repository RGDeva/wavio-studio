# Runtime validation checklist — signed development build

**First live execution attempted 2026-11-02. Results recorded below.**

## Live run — 2026-11-02, Apple Development signing

Signed with `Apple Development: rishmanx@gmail.com (JS76PW969P)` (team
PX83P786QQ) into a **separate** output directory, `release-dev/`. No release
artifact was touched, Gatekeeper was not disabled, no quarantine attribute was
cleared, SIP was not modified, and hardened runtime stayed on
(`flags=0x10000(runtime)`).

### A. First launch gate

| # | Step | Result | Evidence |
|---|---|---|---|
| A1a | Electron process starts | **PASS** | pid 83504 alive at 41s, RSS 19.8 MB; later pid 84343 via `open`, with gpu/network/utility helpers |
| A1b | Bundle survives execution | **PASS** | 120 files before, **120 after**. The unsigned bundle went 112 → **0** |
| A1c | Window appears | **FAIL** | `count of windows` = 0 on every attempt; no renderer helper ever spawned |
| A2 | `~/.wavi/main.log` written | **FAIL** | Never created |
| A3 | `codesign -dv` | **PASS** | Chains to Apple Root CA, `Signature size=9099`, `runtime` flag set, "valid on disk", "satisfies its Designated Requirement" |

**Gate A fails at A1c, so nothing below was run.**

### What this establishes

Gatekeeper is no longer the blocker, reproducibly. That half of ENV-1 is
resolved: a legitimately development-signed build starts and is not moved to
the Trash.

The app now fails for a different, pre-existing reason: **Electron's `ready`
event never fires.** The first statement inside `app.whenReady().then(...)` is
`mainLog('--- main process started ---')`, and that file is never created. The
single-instance path calls `process.exit(0)` when it loses the lock and the
process does not exit, so the lock was obtained and module evaluation continued
past it. There is no crash report, no error-level log entry, and the process
sits in a normal AppKit run loop (15-second StateRestoration heartbeat).

The conclusion the evidence supports: module-level code between the
single-instance lock and the `whenReady` registration blocks the main thread,
so `ready` is queued and never dispatched. Consequences — no window, no bridge
listener on 47821, and no SQLite initialisation in any userData directory
(`wavio-studio`, `-dev`, `-qa` all show zero recent writes).

### B–E

| Section | Result |
|---|---|
| B. Live bridge security | **BLOCKED** — the bridge never starts; `lsof` shows nothing on 47821 |
| C. DAW launch guards, live | **BLOCKED** — requires a running app |
| D. Core desktop smoke | **BLOCKED** — requires a running app |
| E. Authenticated staging | **NOT RUN** |

No live security or Project Brain behaviour is claimed. Those guards remain
verified only by unit tests and source inspection.

## Preconditions

Run this on **an authorized Mac** with a **legitimately signed development
build**. "Legitimately signed" means a real Apple Developer ID, or a
development-signed build on a machine provisioned for it by its owner.

Do **not**, to make any step pass:

- disable Gatekeeper (`spctl --master-disable`)
- clear quarantine attributes (`xattr -cr`)
- bypass any macOS security policy
- modify or re-sign an existing release artifact
- treat an ad-hoc signature as evidence of public readiness — it is a local
  development convenience and confers no trust on any other machine

If a step cannot be performed without one of those, the step stays **NOT RUN**.
That is the correct outcome, not a failure to work around.

---

## A. The app starts at all

| # | Step | Expected | Result |
|---|---|---|---|
| A1 | Launch the signed build | Window appears; no Gatekeeper dialog; the bundle is still on disk afterwards | NOT RUN |
| A2 | `~/.wavi/main.log` | Startup lines, no stack trace | NOT RUN |
| A3 | `codesign -dv --verbose=4 <app>` | A real authority; `runtime` flag present | NOT RUN |

A1 is the single most informative step in this document. It has never happened.

## B. The bridge refuses what it should

Bridge on `127.0.0.1:47821`; token at `~/.wavi/bridge-token` (mode `0600`).

```bash
TOKEN=$(cat ~/.wavi/bridge-token)
B=http://127.0.0.1:47821
```

| # | Request | Expected | Result |
|---|---|---|---|
| B1 | `curl -s -o /dev/null -w '%{http_code}' $B/health` | `200` | NOT RUN |
| B2 | `curl -X POST $B/run-command -H "X-Wavi-Token: $TOKEN" -d '{"command":"echo hi; id"}'` | **410 Gone**, nothing executed | NOT RUN |
| B3 | `/project-files` with no token | `401` | NOT RUN |
| B4 | `/project-files` with a wrong token | `401` | NOT RUN |
| B5 | `/project-files` with `Host: evil.example` + valid token | **403**, before any token check | NOT RUN |
| B6 | `/project-files` with `Origin: https://evil.example` + valid token | **403** | NOT RUN |
| B7 | `OPTIONS /project-files` | `405`, no `Access-Control-*` headers in the response | NOT RUN |
| B8 | `/open-file` with `/Applications/Calculator.app` | **403**, Calculator does **not** launch | NOT RUN |
| B9 | `/open-file` with a `.command` placed in a watched music folder | **403**, no Terminal window | NOT RUN |
| B10 | `/open-file` with an indexed `.wav` | `200`, opens in the default player | NOT RUN |
| B11 | `/reveal-file` with an unindexed path in `~/Documents` | **403** — and the same `403` whether the file exists or not | NOT RUN |
| B12 | `/open-folder` with `/Applications` | **403** | NOT RUN |
| B13 | `grep -i token ~/.wavi/main.log` | no token value present | NOT RUN |

B5 is the DNS-rebinding defence: the connection genuinely arrives on loopback,
so the peer address proves nothing and the `Host` header is what distinguishes
it. B11 checks the ordering specifically — if existence changes the status
code, the route is still an existence oracle.

## C. Launching is bounded to real DAWs

| # | Step | Expected | Result |
|---|---|---|---|
| C1 | Open a project with "Open in <DAW>" for each installed DAW | The DAW opens the project | NOT RUN |
| C2 | Call `shell:openWithApp` with `/Applications/Utilities/Terminal.app` | Rejected; **no Terminal window** | NOT RUN |
| C3 | Same with `/bin/sh` | Rejected | NOT RUN |
| C4 | Symlink `~/Applications/Ableton Live 12.app` → `Terminal.app`, then launch it | Rejected — judged by canonical target | NOT RUN |
| C5 | Symlink `~/Applications/Live.app` → the real Ableton install, then launch | **Accepted** — a legitimate link must keep working | NOT RUN |
| C6 | Nested bundle inside a real DAW's `Contents/Resources` | Rejected | NOT RUN |
| C7 | Ask the assistant to open a project in its DAW | Works; the guarded dependency does not break the tool | NOT RUN |

C5 matters as much as C2: a guard that blocks the attack and the user is not
finished.

## D. Normal workflows still work

| # | Step | Expected | Result |
|---|---|---|---|
| D1 | Scan a folder of real projects | Projects and files indexed | NOT RUN |
| D2 | Open `.wav`, `.mid`, `.als`, `.flp` from the library | Each opens normally | NOT RUN |
| D3 | Reveal an indexed file in Finder | Finder selects it | NOT RUN |
| D4 | Create a Project Link, open the URL, restore it | Link created, restore completes, checksums verify | NOT RUN |
| D5 | Publish a child version from a restored checkout | Appears as a child of the parent version | NOT RUN |
| D6 | Build a cross-DAW portable handoff | `wavi/` with `session.json`, `fidelity.json`, `PORTABLE.md`; stems/midi/renders populated | NOT RUN |
| D7 | Ask Project Brain about recent work | Answers from the local index | NOT RUN |
| D8 | Ask the agent for an action needing confirmation | Confirmation card appears; nothing runs until confirmed | NOT RUN |

## E. The authenticated staging smoke

| # | Step | Expected | Result |
|---|---|---|---|
| E1 | Sign in against staging | Session established | NOT RUN |
| E2 | Full publish → link → restore → return cycle | Completes end to end | NOT RUN |

`AUTHENTICATED ELECTRON STAGING SMOKE: NOT RUN` — unchanged. Note that
`electron-builder.staging.json` points at a deployment where
`resolve-project-link` returned "Unknown action"; confirm the staging target is
current before trusting E2.

---

## Recording results

Mark each row `PASS`, `FAIL` or `NOT RUN`, with the date, the machine, and the
signing identity used. A row left blank is **NOT RUN**, never an implied pass.
If any step required disabling a macOS protection, record it as **NOT RUN** and
note which protection was involved.
