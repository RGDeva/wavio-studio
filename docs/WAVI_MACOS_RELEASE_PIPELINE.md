# macOS release pipeline

**Status:** configured and verified as far as this machine allows (2026-10-07).
**Branch:** `feat/mac-release-signing`.

Nothing in here fabricates a credential, and nothing publishes. The pipeline is
complete and *provably refuses* to produce a misleading artifact; what it has
never done is run a real signing or notarization pass, because this machine has
no Developer ID. That gap is stated at §7 rather than papered over.

## 1. What was missing

| Piece | Before | Now |
|---|---|---|
| `afterSign` notarization hook | **absent** — a build with full credentials would still have shipped un-notarized | `scripts/notarize.mjs` |
| Credential preflight | none — failure surfaced after packaging | `scripts/release-mac.mjs`, before any work |
| Dual-arch matrix | `--mac dmg` silently built host arch only | explicit `--<arch>` per cell |
| Artifact verification | `verify-package.mjs` (bundle contents only) | `scripts/verify-release.mjs` (what the bundle *is*) |
| Decision logic | — | `scripts/macSigning.mjs`, pure and tested (43 tests) |

The hook's absence was the serious one: `hardenedRuntime: true` and a Developer
ID in the config, with nothing ever submitted to Apple. Gatekeeper would have
blocked the result on every machine except the build machine.

## 2. Design: decisions separated from doing

`scripts/macSigning.mjs` is pure — it takes environment variables and tool
output and returns verdicts. The scripts that shell out contain no logic.

This split exists because the signing path cannot be exercised here: with no
certificate, every code path that matters would be skipped. A pipeline whose
correctness can only be observed by shipping is one nobody can fix under
pressure. So the parsers are tested against **real output captured from this
machine**, including the cases that only showed up by running the tools.

## 3. Two rules the code is built around

**A missing credential is never permission to continue.** A distribution build
without a Developer ID fails, loudly, naming what is absent. Partial
notarization credentials (three of four variables) are treated as *unavailable*
rather than nearly-working, because the alternative is a build that fails after
the expensive part.

**A guarantee is never reported stronger than it was verified.** Signed is not
notarized; notarized is not stapled; and a check that *could not run* is never
counted as a pass. `summarizeVerification` has no "unknown is fine" path.

## 4. Commands

```bash
npm run release:mac          # distribution — REQUIRES full credentials
npm run release:mac:local    # local, unsigned, clearly labelled
npm run verify:release       # distribution gate
npm run verify:release:local # structural only; reports signing as unverified
```

## 5. What the verifier checks

**Structural** (fails in every mode): all four matrix artifacts exist; each app
binary matches its advertised architecture; **`better_sqlite3.node` matches its
host arch** — the cross-arch trap that produces an app which launches fine and
dies the moment it touches the database.

**Signing** (fails a distribution build): `codesign --verify --deep --strict`;
the leaf certificate is a *Developer ID Application*, not a development cert;
the `runtime` flag is present in the signed CodeDirectory, which is a different
claim from the config requesting it; `spctl` returns `source=Notarized
Developer ID`; a stapled ticket on both the `.app` and each `.dmg`.

Plus a SHA-256 manifest of whatever is present.

## 6. Three real defects found by running the tools

**`lipo` is broken here**, by the same Xcode dyld fault that breaks `python3`.
Worse: the previous release report said architectures were verified, and that
line actually came from a `|| file -b` fallback, not from `lipo`. The verifier
now parses the Mach-O header itself — no Xcode dependency, no ambiguity.

**`xcrun stapler` is broken here too**, so "no ticket" and "could not check"
were indistinguishable. Without the distinction, a perfectly notarized build
would be reported as unstapled. When `stapler` cannot run, the verifier falls
back to looking for `Contents/CodeResources` — the stapled ticket, distinct
from `Contents/_CodeSignature/CodeResources` — and labels it **heuristic, not
proof**. Verified against Google Chrome (has it) and this repo's unsigned build
(does not).

**`spctl` has a third outcome.** On one artifact it printed `notarization
indicates this code has been revoked` — exit 0, neither "accepted" nor
"rejected". A two-state parser reports the most serious state Gatekeeper has as
the mildest thing it could say. Now surfaced explicitly.

A fourth, found by a test rather than a tool: `classifyIdentity` matched
`3rd Party Mac Developer Application` against `/Mac Developer/` and called an
App Store certificate a development one — handing the user a diagnostic about
the wrong problem.

## 7. What has NOT been verified, and cannot be here

- **No signing pass has ever run.** Only an *Apple Development* certificate is
  installed. The signing, notarization and stapling code is tested at the
  decision level and has never driven the real tools.
- **No notarization submission has been made.** `xcrun notarytool` has never
  been called; Apple has never seen this app.
- **`xcrun stapler` and `lipo` cannot run at all** until the Xcode selection is
  repaired, so the verifier's stapling check degrades to a heuristic on this
  machine.
- **A DMG cannot be built by the documented command** without a `python` shim
  on PATH. The orchestrator detects this and prints the fix rather than failing
  late.

## 8. Reviewable: the entitlements weaken hardened runtime

`build/entitlements.mac.plist` grants `allow-jit`,
`allow-unsigned-executable-memory`, `disable-library-validation` and
`allow-dyld-environment-variables`. The first two are genuinely required by
V8. The other two are the ones worth a second look:

- `disable-library-validation` lets the app load libraries signed by another
  team. Electron apps often need it for native modules, but electron-builder
  *does* sign the unpacked `better_sqlite3.node` with the same identity, so it
  may be removable.
- `allow-dyld-environment-variables` is rarely needed and widens the attack
  surface.

I have **not** changed either. Removing them is a one-line edit whose only
honest test is launching a signed, notarized build and watching whether
`better-sqlite3` loads — which cannot happen here. Changing them blind would
risk shipping an app that fails on first database access, and that is a worse
outcome than a documented over-grant. Flagged for whoever has the certificate.

## 9. Ordered checklist to a real signed beta

1. Install a **Developer ID Application** certificate (Apple Developer Program,
   $99/yr; the existing Apple Development cert is not sufficient).
2. Create an App Store Connect API key and export `APPLE_API_KEY`,
   `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
3. `sudo xcode-select --switch /Library/Developer/CommandLineTools` — needs your
   password; repairs `python3`, `lipo` and `xcrun stapler` together.
4. `npm run release:mac` — preflight passes, four artifacts build, the hook
   notarizes and staples.
5. `npm run verify:release` — must print
   *"signed with a Developer ID, hardened runtime on, notarized and stapled"*.
6. Revisit §8 once step 5 passes and a signed build is known to launch.
7. Only then decide the version string and tag.
