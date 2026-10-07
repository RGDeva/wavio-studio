# macOS distribution pipeline

**Status:** one credential step from a signed, notarized release (2026-10-07).
**Branch:** `release/macos-distribution-pipeline`.

Nothing is published. No credential is fabricated. No tag or GitHub Release was
created. Every live-execution status remains **NOT RUN** (ENV-1).

## 1. Build stack, as installed

| Component | Version | Consequence |
|---|---|---|
| `electron-builder` | **24.13.3** (declared `^24.13.3`, installed exact) | supports **native `mac.notarize`** |
| `app-builder-lib` | 24.13.3 | `macPackager.notarizeIfProvided` |
| `@electron/notarize` | **2.2.1** (already present) | notarizes *and staples the `.app`* |
| `electron` | 31.7.7 | — |

**Nothing was upgraded.** The installed stack already supports the modern
mechanism, so the `afterSign` hook written earlier in this work was **removed** —
it is the historical path, and running both would notarize twice.

Credentials are read **from the environment by electron-builder itself** and
never appear in config, source, docs or history. Three accepted methods, in
electron-builder's own resolution order:

1. `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` — **recommended**
   (electron-builder's own guidance; no personal account, survives a password change).
2. `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
3. `APPLE_KEYCHAIN_PROFILE` (+ optional `APPLE_KEYCHAIN`) — a stored
   `notarytool` profile; keeps the password out of the environment entirely.

### The one-line change that mattered most

`mac.notarize` is now **explicitly `true`**. Read `macPackager.js:410-418`: with
`notarize` unset, electron-builder logs *"`notarize` options were unable to be
generated"* as a **warning** and continues. A fully-credentialed release would
have shipped un-notarized, and the only evidence would have been one line in a
build log nobody reads.

The Apple-ID method additionally needs a team id, which electron-builder reads
from *config* rather than the environment — so `release-mac.mjs` injects
`-c.mac.notarize.teamId=$APPLE_TEAM_ID` at build time. A team id committed for
one developer is wrong for every other, so it is never written down.

## 2. Version decision

```
CURRENT VERSION:            1.1.0
RECOMMENDED RELEASE VERSION: 1.1.0  (unchanged)
```

**REASON — evidence, not preference:**

- `v1.0.0` **was publicly distributed.** A published GitHub Release exists
  (not a draft, not a prerelease, 2026-03-13) with a real asset,
  `Wavi.Studio-1.0.0-arm64.dmg`, **11 downloads**. arm64 only — the host-arch
  trap was already costing a release back then.
- `1.1.0` has **no tag and no release**. `gh release view v1.1.0` → *release not
  found*; the only tag in the repository is `v1.0.0`.

So 1.1.0 has never been publicly distributed and there is nothing to bump away
from. The version is left alone, per the instruction not to move it without
evidence. Whether to add a `-beta.1` suffix is a *preference* about how to label
a first signed build, not something the evidence decides — flagged, not acted on.

## 3. Deterministic commands

```bash
npm run release:preflight        # read-only readiness report
npm run release:mac              # signed + notarized, both architectures
npm run release:mac:unsigned     # local only, explicitly not distributable
npm run verify:release           # the distribution gate
npm run verify:release:unsigned  # structural only; signing reported NOT RUN
```

Each cell of the matrix is invoked with its own explicit `--<arch>`, and the run
**fails if any expected artifact is absent**. One architecture when two were
requested is a failure, not a partial success — `electron-builder --mac dmg`
silently builds host-arch only and exits 0, which is how v1.0.0 shipped arm64
alone and how the 1.1.0 RC lost its x64 DMG.

## 4. Toolchain preflight (read-only)

`scripts/release-preflight.mjs` runs no `sudo`, never touches `xcode-select`,
installs nothing, and does not modify Python or the keychain. Current result on
this machine:

| Status | Item |
|---|---|
| PASS | node, npm, codesign, security, ditto, hdiutil, host arch |
| PASS | `mac.notarize` explicit, `hardenedRuntime`, entitlements file, arch in `artifactName` |
| **FAIL** | `python` — none on PATH; the DMG target requires it |
| **FAIL** | `xcrun / notarytool` — Xcode shim, this machine's Xcode is broken |
| **FAIL** | `xcrun / stapler` — same |
| **FAIL** | Developer ID Application — only an Apple Development cert exists |
| **FAIL** | notarization credentials — none configured |
| WARN | an Apple Development cert is present and will *never* qualify |

→ `RESULT: BLOCKED_FOR_DISTRIBUTION — 5 required item(s) missing.` exit 1.

The PATH-scoped CLT Python shim is documented in the failure message **as a
workaround for one command, explicitly not a machine repair**. The real fix
(`sudo xcode-select --switch …`) needs the user's password and is theirs alone.

## 5. Developer ID status

**Absent.** `security find-identity -v -p codesigning` returns exactly one
identity: `Apple Development: rishmanx@gmail.com (JS76PW969P)`.

An Apple Development certificate **can never qualify** as a distribution
signature, and the pipeline says so by name rather than generically — "I have a
certificate, why is it failing" is the likeliest confusion here. Preflight
reports `BLOCKED_FOR_DISTRIBUTION`; the release script refuses to build;
nothing is ever labelled a "signed release".

Unsigned packaging stays available through the explicitly-named
`release:mac:unsigned`, which forces `CSC_IDENTITY_AUTO_DISCOVERY=false` so a
development certificate cannot sneak in and make an artifact *look* signed while
still failing Gatekeeper.

## 6. Hardened runtime and entitlements — audited against actual use

`hardenedRuntime: true`, `gatekeeperAssess: true`, entitlements at
`build/entitlements.mac.plist`.

| Entitlement | Verdict | Why |
|---|---|---|
| `cs.allow-jit` | **required** | V8 compiles JavaScript at runtime. Standard for every Electron app. |
| `cs.allow-unsigned-executable-memory` | **required** | V8's generated code. Standard for Electron. |
| `cs.disable-library-validation` | **kept, flagged** | see below |
| ~~`cs.allow-dyld-environment-variables`~~ | **REMOVED** | zero evidence of use: `grep -rn "DYLD_"` across `electron/` and `src/` finds nothing, and it is not in the standard Electron template. Removing an entitlement nothing uses cannot break what does not exist. |

Checked and deliberately **absent**: microphone (`getUserMedia`,
`askForMediaAccess` — no match anywhere; there is no voice feature in the
packaged product), camera, Apple Events, address book, calendar, location. No
entitlement was added to make signing work.

Filesystem access, network and deep links (`wavi://`) need **no** entitlement
outside the App Store sandbox, which this app is not in.

### `disable-library-validation` — the honest position

The only native module is `better-sqlite3`, and electron-builder signs the
unpacked `.node` with the same identity, so library validation *should* pass
without this grant. I did not remove it. The only test that distinguishes
"removable" from "the app dies on first database access" is launching a signed,
notarized build and watching `better-sqlite3` load — which cannot happen until
the certificate exists. Shipping an app that crashes on first use is worse than
a documented over-grant. **Revisit at step 6 of §14.**

## 7. Verification

`scripts/verify-release.mjs` reports **PASS / FAIL / NOT RUN** per check and
infers nothing from a build log. NOT RUN is the important state: on this machine
several Xcode tools are broken, so "could not check" is a real and frequent
outcome, and it is never counted as a pass.

Per architecture: Mach-O architecture of the app binary **and of
`better_sqlite3.node`** (the cross-arch trap — an app that launches fine and
dies the moment it touches the database); `codesign --verify --deep --strict`;
leaf certificate is a *Developer ID Application*; the `runtime` flag is present
in the signed CodeDirectory (a different claim from the config requesting it);
`spctl` returns `source=Notarized Developer ID`; a stapled ticket.

Per artifact: existence, size, SHA-256, DMG stapling. Plus `verify-package`
(reused, not reimplemented) and the source commit.

Architecture is read by **parsing the Mach-O header directly** rather than via
`lipo`, which is an Xcode shim and broken here. A verifier that cannot tell
"wrong architecture" from "my toolchain is broken" is worse than none.

## 8. Credentials still required

1. A **Developer ID Application** certificate in the login keychain.
2. Notarization credentials — one of the three sets in §1.

Nothing else. The repository is otherwise ready.

## 9. Artifact naming

`Wavi-Studio-${version}-${arch}.${ext}` → `Wavi-Studio-1.1.0-arm64.dmg`,
`Wavi-Studio-1.1.0-x64.dmg`, and the matching `.zip`s.

Two defects fixed. The old x64 DMG was `Wavi Studio-1.1.0.dmg` — no
architecture at all, indistinguishable from "the default download" in a URL.
And GitHub rewrote the v1.0.0 asset to `Wavi.Studio-1.0.0-arm64.dmg`: a public
download URL should not depend on how a host mangles a space.

## 10. Release manifest — `wavi.release/1`

Written to `release/release-manifest.json` by the verifier, **after** checking,
so it records what was *verified* rather than what was requested. Every
guarantee is coerced to a strict boolean: a field the verifier could not
determine reads `false`, never absent.

```json
{ "schema": "wavi.release/1", "product": "Wavi Studio", "version": "…",
  "sourceCommit": "…", "generatedAt": "…",
  "artifacts": [{ "platform": "darwin", "arch": "arm64", "filename": "…",
    "bytes": 0, "sha256": "…", "signed": false, "signingIdentity": null,
    "notarized": false, "stapled": false, "packageVerified": true,
    "publicDownloadEligible": false }] }
```

`auditManifest()` scans the **serialised** form for absolute paths, home
directories, tokens and credential variable names — the leak that matters is
whatever actually lands in the file, including anything a future field quietly
carries along. It is built as if already published, because it will be.

## 11. Public eligibility gate

One gate, one list, **no override anywhere**. `publicDownloadEligible` is true
only when all eight are *explicitly* true:

`archMatches`, `packageVerified`, `developerIdSigned`, `hardenedRuntime`,
`notarized`, `stapled`, `noSecretsOrDevPaths`, `sourceCommitMatches`.

Unknown is not eligible. There is no state between "we checked and it passed"
and "no", and `assessPublicEligibility` takes findings and nothing else — no
force flag, because the function's whole purpose is to be the thing a tired
person cannot talk themselves past at 2am.

Current verdict for all four artifacts: **NOT ELIGIBLE** — unmet:
`developerIdSigned`, `hardenedRuntime`, `notarized`, `stapled`.

## 12. Existing unsigned artifacts

Preserved in `release-unsigned-rc/` with a README labelling them
**LOCAL RELEASE-CANDIDATE / NOT FOR PUBLIC DISTRIBUTION**. Nothing deleted,
nothing uploaded.

**One correction, because the premise given to me was wrong and I caused it:**
those files were **not** built from `c305c7e5`. A `rm -rf release` during
release-script development destroyed the originals; what survives was built from
`e6e729e8`. No shipping application code differs between the two commits — the
diff is release tooling, docs, one test file, build config and vitest config — so
they are functionally equivalent, but they are not byte-identical to a
`c305c7e5` build and were not produced from one. To regenerate exactly:

```bash
git checkout c305c7e5 && node scripts/release-mac.mjs --unsigned
```

## 13. Website handoff (`wavio`)

No naming convention exists in the web repo yet (grep found none), so these are
proposed. **All URLs are NOT AVAILABLE** — nothing is published, and no URL is
invented here.

| Field | Value |
|---|---|
| `WAVI_STUDIO_VERSION` | `1.1.0` |
| `WAVI_STUDIO_MAC_ARM64_URL` | **NOT AVAILABLE** |
| `WAVI_STUDIO_MAC_X64_URL` | **NOT AVAILABLE** |
| `WAVI_STUDIO_MAC_ARM64_SHA256` | from `release-manifest.json` (unsigned build's value is not the release value) |
| `WAVI_STUDIO_MAC_X64_SHA256` | ditto |

The web workflow should read `release/release-manifest.json` and refuse to
publish any artifact whose `publicDownloadEligible` is not `true`, rather than
trusting a hand-copied checksum.

## 14. GitHub Release — prepared, NOT created

**Nothing below has been executed.** No tag exists, no release was created, no
asset was uploaded. This needs explicit approval.

- **Tag:** `v1.1.0` (on the release baseline commit)
- **Title:** `Wavi Studio v1.1.0 — beta`
- **Upload set:** `Wavi-Studio-1.1.0-arm64.dmg`, `Wavi-Studio-1.1.0-x64.dmg`,
  `SHA256SUMS.txt`, `release-manifest.json`
  (ZIPs only if auto-update is wired — it is not)
- **Mark as prerelease:** yes
- **Notes draft:**

  > First signed beta. Universal coverage: Apple Silicon and Intel builds are
  > both published this time — v1.0.0 shipped arm64 only.
  >
  > Local-first project indexing, Project Links for sharing, restore with
  > integrity verification, same-DAW native open for Ableton, FL Studio, Logic,
  > Pro Tools and Reaper, and a portable cross-DAW handoff package that converts
  > nothing and states plainly what it cannot carry across.
  >
  > An optional local model can phrase answers about your workspace; it is off
  > by default and answers come from the local index either way. The agent can
  > suggest actions and never performs one without your confirmation.
  >
  > Verify your download against `SHA256SUMS.txt`.

## 15. Ordered steps to a signed beta

1. Enrol in the Apple Developer Program and install a **Developer ID
   Application** certificate into the login keychain.
2. Create an App Store Connect API key; export `APPLE_API_KEY`,
   `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
3. `sudo xcode-select --switch /Library/Developer/CommandLineTools` — your
   password; repairs `python3`, `lipo` **and** `xcrun stapler` together.
4. `npm run release:preflight` → must print `READY`.
5. `npm run release:mac`
6. `npm run verify:release` → must print *"signed with a Developer ID, hardened
   runtime on, notarized, stapled"* and mark both DMGs **ELIGIBLE**.
7. Revisit `disable-library-validation` (§6) now that a signed build can be
   launched and `better-sqlite3` observed loading.
8. Decide on a `-beta.1` suffix, then tag and publish — with approval.

## 16. ENV-1 is untouched

Static packaging proves nothing about runtime. All of these remain **NOT RUN**:
first launch, authentication, watcher runtime, local model runtime, Agent Actions
live, Project Link live, cross-DAW live. The authenticated staging smoke is
still `NOT RUN`.
