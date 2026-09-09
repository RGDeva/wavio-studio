# Wavi Studio — Desktop Execution State (agent handoff)

**Purpose:** let another Claude/Codex agent resume desktop work with no access to prior
conversation history. Everything below is verified against the repository and the committed
roadmap docs, not recalled.

**Generated:** 2026-08-13 · **Repo:** `/Users/rishig/CascadeProjects/wavio-studio`
**Branch:** `feature/ableton-daw-companion` (development integration)
**HEAD:** `75386a1d20d5bd6b870e3451e9c58b31d84a97a1`
**Origin:** `https://github.com/RGDeva/wavio-studio.git` — branch pushed, 0 ahead / 0 behind, worktree clean.

---

## 1. Read these first (authority order)

1. Verified code, tests, behavior.
2. `docs/WAVI_DECISION_REGISTER.md` — **DR-015 is binding** (DAWproject Option B; never create a
   second musical-session schema).
3. `docs/WAVI_DESKTOP_PHASE_3_INTEROP_MULTIPLAYER_ASSISTANT_UI_PLAN.md` — the **live** Phase 3/4
   plan and P0 risk ledger. This is the current roadmap.
4. `docs/WAVI_MULTIPLAYER_V1_DESKTOP_AUDIT.md` — deepest per-subsystem detail (§12–§23).
5. `docs/CROSS_REPO_CONTRACTS.md` — desktop↔web API boundaries.

> **Stale — do not treat as current:** `docs/WAVI_NEXT_ACTIONS.md` and
> `docs/WAVI_AUTONOMOUS_BLOCKERS.md` describe a July 2 "Phase A–I" loop that Phase 3 superseded.
> Their B-2 (`WAVI_AUTH_TOKEN`) and B-3 (credential rotation) human items may still be live; their
> phase/branch content is not.

## 2. Current milestone

**Phase 3 / P3-4 — Multiplayer v1.** All three workstreams are landed in development integration:

| Workstream | Merge | Server contract consumed |
|---|---|---|
| Contract/IPC adapter | `64ea4230` | `wavio@6a4a9e8` |
| UI + assistant | `f0c7bb74` | `wavio@d95683f` (P3-4-ID identity resolution) |
| Contribution review queue | `ff79dbf8` | `wavio@6236c390` (P3-4-CL contribution listing) |
| Staging smoke harness (tooling) | `9473cac1` | — |
| Production packaging hardening | `8219e95f` | — |

`P3-4-ID` and `P3-4-CL` are both **closed**.

## 3. Verified status (re-run at handoff time)

- **955/955 tests · 51 files · 0 skips**
- `tsc --noEmit` clean for `tsconfig.json` **and** `tsconfig.electron.json`
- production build clean
- `npm run verify:package` → **PASS — production runtime only** (11,597 files inspected)
- `git diff --check` clean, worktree clean, nothing unpushed

Run the gate with Node 22 (`nvm use`); the SQLite test harness requires it.

## 4. What is done

- **Project Links** — server-authoritative create/list/revoke + reconciliation, account-scoped
  SQLite (`account_id`), opaque `acct_…` renderer handles, honest state model.
- **Assistant** — deterministic local tools, out-of-band confirmation (the model cannot
  self-confirm), Project Link tools, and all Multiplayer tools. `BLOCKED_CAPABILITIES` is empty.
- **Multiplayer v1** — collaborator resolve→invite, roster, activity feed, contribution
  publish/review/withdraw, durable contribution queue, compact parent→child lineage.
- **Packaging** — compiled test artifacts and developer paths removed from `app.asar`
  (162.4 MB → 69.5 MB), guarded by `scripts/verify-package.mjs` + 30 config tests.

## 5. Invariants — do not regress

- **One HTTP path.** `postDesktopAction` in `electron/main.ts` via `buildDesktopEndpoint`.
  `electron/multiplayerService.ts` performs **no networking**; it takes an injected `postDesktop`.
- **One publish manifest builder** — `buildPublishManifestBody()` in `main.ts`, shared by plain
  publish, publish-on-create-link, and contribution.
- **Privacy boundary.** The canonical Privy DID, the auth token, raw `invt_…` capabilities and
  canonical server ids stay in the main process. The renderer and the model see only opaque refs:
  `acct_…`, `plink_…`, `pmember_…`, `pcontrib_…`, `pinvite_…`. All fail closed on malformed,
  unknown, wrong-kind, cross-account, cross-project, stale-epoch (and TTL, for invites).
- **Roles** are `owner | view | comment`. **There is no `edit`.** `canContribute` is a separate
  field; the server forces it false unless the role is `comment`.
- **Five handler-pinned wire corrections** (verified against the shipped handler — a fake that
  encodes an assumption proves nothing):
  1. `respond-project-invite` → `response: 'accept' | 'decline'` (not a boolean)
  2. `respond-project-contribution` → `response: 'accept' | 'reject'`, **no** reviewer note
  3. `revoke-project-collaborator` → requires **both** `projectId` and `membershipId`
  4. contribution permission — `view` never contributes; `owner` contributes by ownership
  5. `parseContribution` fails closed unless **exactly one** state flag is set
  Plus: the contribution-list `state` filter is **omitted** when unfiltered (the handler 400s on an
  unrecognised value), and `revision` is a timestamp **string**, not a number.
- **Version lineage is server-authoritative.** No local schema migration; `electron/db.ts` must stay
  untouched for lineage.
- **Operation keys** for contributions are minted once, retained while the outcome is unknown,
  replayed unchanged on retry, and never persisted across sessions.
- **`sourceRestoreId` is never sent** — it is a desktop-local row id, not a server identity.

## 5b. P3-1d — UI systematisation (branch `feat/desktop-ui-systematisation`, UNMERGED)

Presentation only. **No product capability added, no server contract changed, no IPC or schema
touched** — a behaviour-freeze check proves zero `electron/` runtime files changed and re-asserts
all five handler-pinned corrections at source.

What it removes, measured before and after:

| Ad-hoc value | Before | After |
|---|---|---|
| raw `text/bg/border-white/NN` (38 distinct opacities) | 635 | **0** |
| raw Tailwind palette (`emerald-400`, `red-500`, …) | 201 | **0** |
| type below 11px (`text-[8px]`, `[9px]`, `[10px]`) | 223 | **0** |

Replaced by one vocabulary: a five-step text hierarchy (`fg` → `fg-disabled`), a four-step type
scale (`meta/body/title/heading`), a four-step elevation ladder (`bg-layer-1..4`), a three-step
hairline ladder, and the existing semantic status tokens.

**Contrast repair (deliberate, not incidental):** 194 call sites were rendering meaningful labels
at 20–30% white on near-black. They now land on `fg-quaternary` (46%). `fg-disabled` is reserved
for genuinely inert affordances and is never applied by the migration map.

**Two classes of change, kept distinct:** 94 renames are *provably* zero-pixel (`--primary` and
`--accent` were encoded from `#06B6D4`/`#8B5CF6`, i.e. cyan-500/violet-500); 316 are a deliberate
semantic collapse of shade variants onto the considered token value.

**Deliberately NOT abstracted:** "Load more" appears in one file and `role="alert"` in two —
turning those into primitives would be inventing duplication.

The mapping lives in `scripts/ui-token-map.mjs` (reviewable, not buried in a one-off command) and
is pinned by `src/lib/designSystem.test.ts` (10 tests) so the system cannot silently erode.

Gate: **965/965 · 52 files · 0 skips**, tsc ×2 clean, production build clean, `verify:package`
PASS, preview isolation intact.

**Visual validation: DONE (2026-08-13).** `?ui-preview` runs in the renderer under plain Vite, so
ENV-1 never applied — no Electron was launched. Home, Project Detail and Project Links were
inspected at 1024 / 1280 / 1680 px across populated, loading, empty, error and offline states.

**Two real regressions were found that the whole test suite had missed, both branch-caused:**

1. **The primary Button silently lost its foreground colour.** `tailwind-merge` did not know the
   new custom `fontSize` keys, so it classified `text-meta` as a text COLOUR and dropped
   `text-primary-foreground` from the merged class list — white on cyan at **2.42:1**. Fixed by
   teaching the merger the custom scale in `cn()`; now **7.85:1**. This bug existed only at
   class-merge time, which is precisely why every static check stayed green.
2. **Inactive tab labels sat in the wrong tier.** The migration mapped 45% white onto
   `fg-quaternary`, lumping interactive navigation in with inert metadata. Promoted to
   `fg-tertiary`: **4.30 → 6.53**.

**The scale was then retuned from measurement, not taste:** at 58/46 the Project Link explanation
lines still landed at 4.07. `--fg-tertiary` 58→62 and `--fg-quaternary` 46→50 clear 4.5:1 while
keeping five visibly distinct steps.

Final measured state across every surface and width: **0 contrast failures, 0 horizontal overflow,
0 clipped text, minimum font 11px.**

## 5b. Ableton adapter validated against real Live 12 projects (2026-09-09)

The live Ableton P0 gates need a running app, but the **adapter layer does not** — it has no
Electron imports, so it can be driven directly over the real `.als` projects already on this Mac
(Ableton Live 12 Suite is installed at `/Applications`). Doing that found two defects that the
existing test fixture structurally could not catch.

Correct on every real project: adapter routing (`ableton`), `isProjectFile`, folder scan and role
classification, `Ableton Project Info/` manifest extra, `locateProjectFile`, **0 containment leaks**,
and `../../escape.wav` rejected as `null`.

**Two real defects in `parseAbletonLiveSet`, both invisible to the fixture:**

1. **The 16KB read window could never reach the tempo.** MasterTrack tempo sits near the END of a
   real set — measured at byte **293,923 of 334,317** and **154,040 of 194,360** in two real Live 12
   projects. Every genuine `.als` therefore parsed as `bpm: 0`, while the 200-byte synthetic
   fixture (tempo at byte ~150) passed. The runbook's §2/§3 pass criteria require correct BPM.
2. **The regex matched the wrong element even unbounded.** `/<Tempo>(?:<[^>]+>\s*)*<Manual …/`
   matches ANY tag, so it runs to EOF and backtracks to the **last** `<Manual>` in the document.
   Against a real file it returned **1** — an unrelated device value — not the tempo. Defect 1 hid
   defect 2: truncation meant the greedy scan never got the chance to mis-fire.

Fixed by scoping extraction to the `<Tempo>…</Tempo>` element over the full document. Real projects
now parse **64.52→65 BPM** and **160 BPM** (previously 0 and 0).

`<KeySignature>` does not exist in Live 12 at all (**0 occurrences** in both real projects), so
`key: ''` is the honest answer, not a bug. The lookup is now confined to a `KeySignature` element so
a device preset's stray `<Tonic>` cannot be reported as the project key — previously it was, which
the second regression test pins.

Both new tests were **verified to fail against the old implementation** (`bpm 0` instead of 128;
stray tonic reported as `'F'`) before the fix was restored — they are regression tests, not
tautologies. The pre-existing fixture was left untouched and still asserts `{ bpm: 140, key: 'F' }`;
no test was weakened.

This is the same lesson as the multiplayer wire-format defects: **a fixture that encodes our own
assumption proves nothing about the real format.** Both times the bug lived exactly in the gap
between the synthetic shape and the real one.

Gate after the fix: **967/967 · 52 files · 0 skips** (965 + the 2 new regression tests),
tsc ×2 clean, production build clean, `verify:package` **PASS** (11,597 files, production runtime
only). `AUTHENTICATED ELECTRON STAGING SMOKE: NOT RUN` is unchanged by this work.

Note on suite timing: a first run reported 2 failures, both **performance benchmarks**
(`security.test.ts` COUNT 44ms vs 10ms; `fs.benchmark.test.ts` 50k import 46,548ms vs 30,000ms).
That was self-inflicted — a full `find ~` was scanning the home directory concurrently. Re-run
uncontended, the 50k import took **556ms** (83x faster) and the whole suite **25.7s** vs 622s. Both
pass. Run the benchmarks with nothing else touching the disk.

## 5c. Staging transport surface probed unauthenticated (2026-09-09)

The authenticated smoke cannot run (ENV-1), but the part that needs no credentials was verified
directly against staging (`wavi-staging-kvbq16xd5-rgdevas-projects.vercel.app/api/desktop`).

All **10 locked multiplayer actions return 401** unauthenticated. A bogus `Authorization: Bearer`
also returns 401 — it fails closed rather than falling through.

The control matters more than the result: an **unknown** action name (`definitely-not-a-real-action`,
a near-miss `list-project-collaboratorsX`, and an empty header) returns **400**, not 401. So the
endpoint distinguishes "action not recognised" from "auth required", which is what makes the ten
401s real evidence that every locked action is deployed and gated — rather than a blanket reject
that would look identical if an action were missing. This is the check that was skipped the first
time and produced the false "not deployed anywhere" claim.

**What this does NOT prove:** anything past the auth boundary. Request-body correctness against the
real server, identity resolution, pagination, operation-key replay and the confirmation envelope all
remain unexercised end-to-end. Those need a signed-in session and are still `NOT RUN`.

## 6. Blockers

| ID | Blocker | Owner | Notes |
|---|---|---|---|
| **ENV-1** | **This Mac will not let Electron execute.** `node_modules/electron/dist/` is stripped of `Electron.app`. A pristine Electron re-extracted from the official cached zip is now **SIGKILLed on exec (exit 137)** — verified complete first (252 files, 227MB, all Frameworks present; the zip legitimately ships no `_CodeSignature`, raw Electron is adhoc linker-signed). Re-confirmed 2026-09-09 with the Bash sandbox disabled: **same SIGKILL**, so this is host policy, not agent tooling. | host / IT | Blocks every Electron-dependent gate. Needs an allowlist for Electron or a different machine. **Do not attempt to bypass.** |
| **ENV-2** | **`/usr/bin/git` is broken** — Xcode's CoreDevice has a symbol mismatch, so `xcode-select` cannot locate git. | host | Workaround: use `/Library/Developer/CommandLineTools/usr/bin/git` directly. |
| **P0-SMOKE** | **Authenticated Electron staging smoke: NOT RUN.** Never performed, never claimed. | desktop, blocked by ENV-1 | The **last functional release gate**. Harness is committed and ready. |
| **P0-ABLETON** | Ableton live E2E P0 gates open — real publish, restore round trip, deep-link import. The **adapter layer is now validated against real Live 12 projects** (§5b); what remains blocked is only the part needing a running app. | desktop, blocked by ENV-1 | See `docs/WAVI_ABLETON_E2E_RUNBOOK.md` and §5b. |
| **B-2** | Real-network upload metrics need a user-supplied `WAVI_AUTH_TOKEN`. | human | Non-blocking for merges. |
| **B-3** | Credential rotation for previously leaked keys. | human | Should gate any public beta. |
| **REL** | Production deployment is a separate gate and remains **blocked**. | human | — |

## 7. Dependencies on the Wavi web app (`wavio`)

`wavio` is a **sibling repo that desktop tasks must not modify** — read-only, and only to verify a
contract. Consumed contracts, all locked and staging-validated:

- Multiplayer v1 — `wavio@6a4a9e8050902cd9f16cd3d4e067ef56eb6ca584`
- P3-4-ID identity resolution — `wavio@d95683f2ff6d64d1442c579153f8a22faad63ce1`
- P3-4-CL contribution listing — `wavio@6236c3901966e88bb9a05bef79253463bffa6abd`

Transport: `POST {API_BASE}/api/desktop` + `X-Desktop-Action` + bearer token. Ten actions.
Staging: `https://wavi-staging-kvbq16xd5-rgdevas-projects.vercel.app/api`
(`dpl_3LaE73wZTRZJxFGS1FA25TqQaASx`, Supabase `qjhzrxgiomctzxdzywhu`).

**Web-owned, still excluded from desktop scope:** recipient page, import token, ZIP/Project Pack.

**Known web-side bug, unassigned:** the desktop download link on wavi.stream (pre-login) points at
an empty GitHub repo. It lives in `wavio`, so no desktop task has been allowed to touch it.

## 8. Next highest-ROI task

**Unblock and run the authenticated Electron staging smoke** — it is the single remaining
functional gate, and it is the first time the real request bodies would meet the real server with a
real token. That matters more than usual here: the five wire corrections above are proven against
handler *source*, never against a live authenticated round trip.

It cannot be done on this host (ENV-1). Two paths:
- **(a)** get Electron excluded from whatever agent reaps `.app` bundles on this Mac, or
- **(b)** run it on another machine.

Then:
```bash
npm run build:mac:staging
WAVI_SMOKE=1 WAVI_SMOKE_ROLE=owner WAVI_SMOKE_OUT=/tmp/owner.json \
WAVI_SMOKE_WAIT_MS=1800000 \
  "release-staging/mac-arm64/Wavi Studio Staging.app/Contents/MacOS/Wavi Studio Staging"
```
Sign in as the owner account when the window appears; the harness waits, then writes redacted
evidence. Repeat with `WAVI_SMOKE_ROLE=collaborator` and `=foreign`. Mutations (invite, publish,
accept/reject/withdraw) still need driving through the UI. Full runbook: audit §22.

**If ENV-1 cannot be cleared,** the next best desktop work that needs no Electron launch is
**P3-1d UI/UX systematisation** (shared loading/empty/error/offline patterns — `docs/…PHASE_3…md`
§2 lists this as a P1 audit finding, currently ad-hoc per screen). It is pure renderer work,
provable by the existing vitest + preview-harness setup.

## 9. Working agreements observed in this lane

- Branch off `feature/ableton-daw-companion`; merge back with `--no-ff`; never merge `main`.
- Never modify `wavio`.
- **Read the shipped handler before coding against a contract.** Four wire defects reached
  integration once because tests asserted assumed shapes; the fix was handler-pinned tests.
- Never fabricate a pass. Unverifiable means unverified, and it gets written down as such.
- Prove packaging claims against the **artifact**, not the config.
