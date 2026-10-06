# Wavi Studio — release baseline audit

**Established:** 2026-10-06
**Baseline commit:** `c305c7e5` on `feature/ableton-daw-companion`
**Version in `package.json`:** `1.1.0` (not bumped — see §5)

## 1. Integration vs `origin/main`

```
integration   feature/ableton-daw-companion @ c305c7e5
origin/main                                 @ 567e6abc
merge-base(integration, origin/main)        = 567e6abc
```

The merge base **is** `origin/main`, so `origin/main` is a strict ancestor of
the integration branch. `git merge-base --is-ancestor origin/main
feature/ableton-daw-companion` confirms it.

| Direction | Commits |
|---|---|
| in `origin/main`, not in integration | **0** |
| in integration, not in `origin/main` | **207** |

**Nothing from remote main needs incorporating.** No merge, rebase or history
change was performed, and none is required.

Worth stating plainly because I got this wrong earlier in the session: I flagged
a "pending reconciliation with `origin/main`" three times. There was none. The
local `main` ref is stale at `e37e4db0`, and I read that staleness as divergence
without checking the merge base. Local `main` being behind the remote has no
bearing on the release — nothing builds from it.

## 2. What the baseline contains beyond remote main

373 files, +66,148 / −3,007. The three most recent features, each merged
`--no-ff` with its exact diff verified before and after:

| Merge | Feature |
|---|---|
| `c9f9f9fe` | Agent Actions v1 — allowlisted proposals, deterministic validation |
| `9ba37811` | Agent Actions v1 — resolution, bound confirmation, real permissions |
| `c305c7e5` | Cross-DAW portable handoff v1 — derived checkout on disk |

## 3. Regression gate at `c305c7e5`

| Check | Result |
|---|---|
| `tsc -p tsconfig.electron.json` | clean |
| `tsc -p tsconfig.json` | clean |
| Vitest | **1511 passed / 1511**, 83 files, 0 skipped, 0 todo |
| `vite build` + electron tsc | clean |
| `electron-builder --mac --dir` | clean |
| `verify:package` | PASS — production runtime only |
| `git diff --check` | clean |
| Worktree | clean; `stash@{0}` (pre-existing ProjectDetail WIP) intact |

## 4. Signing and notarization — the real distribution blocker

This machine can build the app but **cannot produce a distributable macOS
beta**:

| Requirement | State |
|---|---|
| Developer ID Application certificate | **absent** (only "Apple Development: rishmanx@gmail.com" is installed) |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | unset |
| `CSC_LINK` / `CSC_NAME` | unset |
| `afterSign` notarization hook | not configured in `package.json` or either builder config |

An Apple Development certificate is for local development only; it does not
satisfy Gatekeeper on anyone else's Mac. The RC was therefore built with
`CSC_IDENTITY_AUTO_DISCOVERY=false` — deliberately unsigned rather than signed
with the development identity, because a development signature would look like
a signed build while still failing Gatekeeper, which is the more misleading of
the two outcomes.

Consequence: this artifact runs on this machine and on any Mac where the user
clears quarantine by hand. It is **not** a beta that can be handed to a tester.

Unblocking it needs, in order:
1. A Developer ID Application certificate in the login keychain (or `CSC_LINK`).
2. An app-specific password and team id for notarization.
3. An `afterSign` notarize hook wired into the production build config
   (currently absent, so notarization would be skipped even with credentials).

## 5. Version not bumped

`package.json` stays at `1.1.0`. A bump is a commit, and the goal was to build
the RC from *that exact commit* without changing history — so the version is
reported rather than altered. Whether this ships as `1.1.0`, `1.1.0-beta.1` or
`1.2.0` is the user's call, and it is the one decision still outstanding before
tagging.

## 6. Still unverified at release time

- **`AUTHENTICATED ELECTRON STAGING SMOKE: NOT RUN`** — ENV-1 (endpoint-security
  quarantine SIGKILLs the Electron bundle on exec) has blocked every attempt.
  No authenticated end-to-end run exists against any deployment.
- **Agent Actions v1** has never executed through live Electron; every model
  path is exercised through injected fakes, and no real local model has produced
  a proposal.
- **Cross-DAW handoff** is proven against a real filesystem at source level. No
  DAW has opened a generated package.
- **`electron-builder.staging.json`** points at a deployment where
  `resolve-project-link` returns "Unknown action" — stale, and not used by this
  RC, which uses the production config.

## 7. Host defect found while building the RC: no usable `python`

The first RC build produced both ZIPs and then **failed both DMGs**:

```
Error: Exit code: 1. Command failed: which python
```

electron-builder's DMG target shells out to `python`, and this machine has
none that works:

- `xcode-select -p` → `/Applications/Xcode.app/Contents/Developer`, but that
  Xcode is broken: `xcodebuild` aborts with
  `Symbol not found: _XPCTypeBool … Expected in: Mercury.framework`, i.e. a
  partially-updated or mismatched Xcode install.
- `/usr/bin/python3` is a shim that asks `xcodebuild` to locate the real
  interpreter, so it fails for the same reason.
- There is no `python` on PATH at all, and no Homebrew or pyenv Python.

This is the same host breakage that made an earlier `python3` patch script
fail silently in this session — a second symptom of one cause, not a code
problem, and it sits alongside ENV-1 as the second thing about this machine
that blocks release work.

**Worked around, not fixed:** `/Library/Developer/CommandLineTools/usr/bin/python3`
(3.9.6) does work, so the DMG rebuild runs with a `python` symlink to it on
PATH, scoped to that one command. No system setting, no `xcode-select`, no
keychain, nothing outside the build invocation was touched — the real fix needs
the user's password and is theirs to make:

```bash
sudo xcode-select --switch /Library/Developer/CommandLineTools
```

(or repair/reinstall Xcode). Until then, **a DMG cannot be produced by a plain
`npm run build:mac`** on this machine — the shim has to be on PATH, which makes
the build non-reproducible for anyone else who clones the repo and runs the
documented command.

## 8. The release candidate

Built from `c305c7e5` with a clean tree, `--publish never`, and
`CSC_IDENTITY_AUTO_DISCOVERY=false`. Nothing was published anywhere.

| Artifact | Size | SHA-256 |
|---|---|---|
| `Wavi Studio-1.1.0-arm64.dmg` | 106 MB | `60afdb063acb3fab12873d8f4de068b71271edafae7c332c139be79a4c5449c6` |
| `Wavi Studio-1.1.0.dmg` (x64) | 112 MB | `fea384e41a71e9be3b5838819384124bde64af081d0495f1455afc670395743a` |
| `Wavi Studio-1.1.0-arm64-mac.zip` | 102 MB | `2606cc48d9135d7d4a05f557d51df65d52f77720c3fc2e2a1a95e80f982d4de1` |
| `Wavi Studio-1.1.0-mac.zip` (x64) | 108 MB | `27c65369609a2716751feca6596253934df3d212b1e3abdf844f10738b18fba0` |

### Verified, not assumed

- `verify:package` → PASS (`dist-electron/main.js`, `dist-electron/preload.js`,
  `dist/index.html`; production runtime only).
- App binary architecture matches its build: `release/mac` is `x86_64`,
  `release/mac-arm64` is `arm64`.
- **`better_sqlite3.node` matches its host arch in each build** — `x86_64` in
  the x64 app, `arm64` in the arm64 app. This is the cross-arch trap worth
  checking by hand: a native module built for the wrong architecture produces an
  app that launches and then dies the moment it touches the database, and
  nothing earlier in the build would have said so.
- Both DMGs mount and contain `Wavi Studio.app` plus the `Applications` alias.
- `codesign -dv` reports no signing authority — unsigned, as intended.

### A CLI flag that silently halved the matrix

`electron-builder --mac dmg` builds **host arch only**; naming a target on the
command line discards the `arch` list in the config. The first DMG pass produced
arm64 and nothing else, and the build exited 0 — so the only evidence was a
missing file. The x64 DMG needed `--mac dmg --x64` explicitly. Worth knowing
before anyone trusts a green exit code as a complete matrix.

## 9. What this RC is and is not

**It is** a complete, verified, reproducible-on-this-machine build of the exact
baseline commit, with both architectures and checksums.

**It is not a beta anyone else can install.** It is unsigned and un-notarized,
so Gatekeeper will refuse it on another Mac until the user clears quarantine by
hand. Shipping it to testers needs the Developer ID certificate, notarization
credentials and `afterSign` hook from §4 — none of which exist here.

## 10. Outstanding decisions and blockers

| # | Item | Owner |
|---|---|---|
| 1 | Version string for the beta (`1.1.0` as built, or `1.1.0-beta.1`) | user — a bump is a commit, so it was not made |
| 2 | Developer ID certificate + notarization credentials + `afterSign` hook | user |
| 3 | `sudo xcode-select --switch /Library/Developer/CommandLineTools` (or repair Xcode) so a plain `npm run build:mac` can produce a DMG | user — needs a password |
| 4 | ENV-1 Electron allowlist, so the authenticated staging smoke can run at all | user |
| 5 | Tag the baseline once (1) is decided | after (1) |
