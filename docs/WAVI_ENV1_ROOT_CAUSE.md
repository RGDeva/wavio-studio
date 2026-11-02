# ENV-1 root cause — it was never endpoint security

**Diagnosed:** 2026-11-02. **Status:** cause identified, fix identified, not yet applied.

## What this project believed

Since the first attempt to launch the app, ENV-1 has been recorded as an
endpoint-security quarantine: *"Electron bundle survives 12+ s idle, then
SIGKILL + 252 files → 0 on exec — actionable as 'allowlist Electron'."* Every
runtime claim in this repository has been marked `NOT RUN` on that basis, and
the suggested remedy has been to allowlist the app in a security product.

**That diagnosis is wrong.** I repeated it many times; this corrects it.

## What is actually happening

There is **no third-party endpoint security on this machine**. No EDR agent in
`/Library/Application Support`, no MDM enrolment (`Enrolled via DEP: No`,
`MDM enrollment: No`), and exactly one system extension — ProtonVPN's network
extension, which has nothing to do with process execution.

The system log, captured during a deliberate launch:

```
kernel (AppleMobileFileIntegrity) AMFI: 'Wavi Studio' has no CMS blob?
kernel (AppleMobileFileIntegrity) AMFI: 'Wavi Studio': Unrecoverable CT signature issue, bailing out.
syspolicyd  GK evaluateScanResult: 2, (team: (null)), (id: Electron), (bundle_id: com.wavi.studio)
syspolicyd  Attempting to move malware to trash
syspolicyd  Prompt shown (2, 0), waiting for response
kernel (AppleSystemPolicy) ASP: Security policy would not allow process: 50882
syspolicyd  Evaluating blocked code
```

This is **macOS Gatekeeper**, doing exactly what it is designed to do:

1. AMFI inspects the binary and finds **no CMS blob** — the app is unsigned.
   `team: (null)` confirms it.
2. Gatekeeper evaluates it, and on current macOS an unsigned application that
   fails this check is treated as malware.
3. `syspolicyd` **moves the bundle to the Trash** and shows the user the
   "Apple could not verify… this app may contain malware" dialog, whose default
   action is *Move to Trash*.

The "252 files → 0" that looked like a quarantine wipe is macOS **trashing the
application**. Nothing malfunctioned; the OS did what it says it does to
unsigned apps.

## The controlled measurement

| Bundle | Launched? | Files before | Files after |
|---|---|---|---|
| `release/mac-arm64/Wavi Studio.app` | **yes** | 112 | **0** |
| `release/mac/Wavi Studio.app` | no | 112 | 112 |

Same build, same machine, same minute. Execution is the trigger, and only the
executed bundle is destroyed. `node_modules/electron/dist/` shows the same
history: it now holds 3 files (LICENSE, LICENSES.chromium.html, version) — the
text files survived and the entire `Electron.app` was removed, timestamped
Sep 9 15:20, matching the original incident.

This also explains the long-standing puzzle that **packaging always worked while
launching never did**: electron-builder packages from its own download cache
(`~/Library/Caches/electron/`), which is never executed and therefore never
trashed.

## Why this matters

**ENV-1 and the code-signing blocker are the same problem, not two.** Every
`NOT RUN` in this repository — first launch, authentication, watcher runtime,
local model runtime, Agent Actions live, Project Link live, cross-DAW live, the
authenticated staging smoke — has a single cause, and a Developer ID signature
plus notarization removes it. The release pipeline built in
`WAVI_MACOS_DISTRIBUTION_PIPELINE.md` is therefore not only the distribution
path; it is the **runtime verification** path.

It also means no "allowlist Electron" action exists to be taken. Anyone who
went looking for a security product to configure would have found nothing,
because there is nothing there.

## Two ways out

### 1. The real fix — Developer ID + notarization

Signed and notarized, Gatekeeper admits the app and it launches normally. This
is the already-documented path and needs the certificate and credentials from
`WAVI_MACOS_DISTRIBUTION_PIPELINE.md` §15.

### 2. The local fix — ad-hoc signing

For running a build on the machine that produced it, a Developer ID is not
required. An ad-hoc signature satisfies AMFI's missing-CMS-blob complaint:

```bash
codesign --force --deep --sign - "release/mac-arm64/Wavi Studio.app"
```

This is the ordinary way developers run local Electron builds. It is **not** a
distribution signature, confers no Gatekeeper trust on any other machine, and
must never be mistaken for one — `verify-release.mjs` correctly reports an
ad-hoc signature as *"ad-hoc signature — not a real identity"* and refuses it.

I attempted this and the sandbox declined it as a security-weakening action,
which is a reasonable default: the same command shape is used to strip
protections. It needs explicit human approval. Running it would unblock live
verification of the desktop app today, without waiting on the certificate.

## Status after this diagnosis

Still `NOT RUN`, every one of them. Knowing the cause changes nothing about
what has been verified — it changes what it costs to verify. One `codesign`
command stands between this project and its first real end-to-end run.
