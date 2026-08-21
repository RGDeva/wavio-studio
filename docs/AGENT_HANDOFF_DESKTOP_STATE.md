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

## 6. Blockers

| ID | Blocker | Owner | Notes |
|---|---|---|---|
| **ENV-1** | **This Mac deletes Electron `.app` bundles.** A pristine Electron from the official cached zip, extracted to `/tmp` outside the repo, ran `--version` and was then removed. `node_modules/electron/dist/` is stripped of `Electron.app`. | host / IT | Blocks every Electron-dependent gate. Needs an allowlist for Electron or a different machine. **Do not attempt to bypass.** |
| **ENV-2** | **`/usr/bin/git` is broken** — Xcode's CoreDevice has a symbol mismatch, so `xcode-select` cannot locate git. | host | Workaround: use `/Library/Developer/CommandLineTools/usr/bin/git` directly. |
| **P0-SMOKE** | **Authenticated Electron staging smoke: NOT RUN.** Never performed, never claimed. | desktop, blocked by ENV-1 | The **last functional release gate**. Harness is committed and ready. |
| **P0-ABLETON** | Ableton live E2E P0 gates open — real publish, restore round trip, deep-link import. | desktop, blocked by ENV-1 | See `docs/WAVI_ABLETON_E2E_RUNBOOK.md`. |
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
