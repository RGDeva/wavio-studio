# Wavi Studio — Project Links desktop audit (P3-2a)

Audited against integrated code at `feature/ableton-daw-companion` @ `6ff51e5b` (branch
`feat/project-links-desktop-foundation`). Evidence is `file:line` in the current tree; this
supersedes earlier assumptions.

## Traced paths (code evidence)

| Flow | Entry | Server call? | Local write |
|---|---|---|---|
| Create Project Link | `project:createLink` (electron/main.ts ~1264) | **Yes** — `desktopApiPost(token,'publish-project-version')` then `('create-project-link')` | `recordLink(...)` **only after** server returns `trackingId` |
| Create Listen Link | `share:createLink` (~1012) | Yes — `share:createLink` server action | `recordLink(kind:'listen')` on success |
| List links | `links:getAll` (~1368) → `getLinks()` (db.ts 531) | **No** | reads local `links` table only |
| Copy | renderer clipboard (`ProjectDetail`, `LinksPage`) | No | — |
| Open | recipient opens URL in browser (web-owned) | — | — |
| Revoke | `project:revokeLink` (~1355) / `links:revoke` (~1377) | **Yes** — `revoke-project-link` | `markLinkRevoked()` **only after** server success |
| Resolve | `restore:resolve` (~1520) | Yes — `resolve-project-link` (returns `{error}` on failure) | — |
| Download Project Pack | `restore:start` → `GET /api/project-link/{token}/download` | Yes | — |
| Restore Project Pack | `restore:start` (~1554) | Yes (download) + local extract (hash-verified, path-contained) | `insertRestoredProject` |
| Contribution return | via `publish-project-version` (owner path); collaborator child path | Partial | — |
| Project Detail links | `ProjectDetail` load() → `api.links.getAll()` filtered by `project_id` | No | — |
| Links page | `LinksPage` → `api.links.getAll()` | No | — |

`desktopApiPost` (main.ts 1128) hits `POST ${API_BASE}/desktop/index` with `Authorization: Bearer`
+ `X-Desktop-Action`; returns `{error}` on non-2xx, else the server JSON.

## Answers (with evidence)

1. **Does `project:createLink` call a real server endpoint?** **Yes** — two `desktopApiPost` calls
   (`publish-project-version`, `create-project-link`).
2. **Success = server persistence or only local?** **Server persistence.** The local
   `recordLink` is guarded by `if (result && !result.error && result.trackingId)` — a local row is
   written only after the server confirms a `trackingId`. Create is server-authoritative.
3. **Is the desktop link list authoritative, cached, local-only, or mixed?** **Local device-only.**
   `getLinks()` reads the local `links` table; there is **no** server `list-project-links` call and
   **no reconciliation**. The Links page was already scoped "honestly to this-device records"
   (commit f9bdef0b), but records are not verified against the server after creation.
4. **Is revocation confirmed by the server?** **Yes** — `markLinkRevoked` runs only after
   `revoke-project-link` returns without error.
5. **Are expiration and permissions represented?** **Partially.** `expires_at`, `allow_download`,
   and `collaborator_mode` are stored locally and sent to the server. There is no richer permission
   set and no client verification that the server *enforces* them.
6. **Is the shared version immutable and identified?** **Yes** — `publish-project-version` creates
   an immutable version; the link references that `projectVersionId`.
7. **Can a link be attached to the wrong project/version?** Low risk on create (uses the passed
   `projectId`/`versionId`), but the **local list cannot verify** a record still belongs to the
   current project/version server-side (no reconciliation).
8. **Does account switching invalidate/isolate cached links?** **No — GAP.** The `links` table has
   **no creator/account column**, and `auth:clearToken` (logout, main.ts 1006) does **not** clear
   `links`. Records from a previous account remain visible with no attribution.
9. **Can offline produce a false success?** **No.** `desktopApiPost` does not catch a `fetch`
   rejection, so an offline create/revoke throws → the IPC promise rejects → the renderer `catch`
   surfaces an error. No local write occurs (the write is gated on a resolved server result).
10. **Which required contracts are missing?**
    - **Authoritative link listing** (`list-project-links`) — desktop consumes none.
    - **Account-scoped isolation** for cached records.
    - **Permission-enforcement contract** beyond `allowDownload`/`collaboratorMode`.
    - (Standing, from the Codex packet) recipient project-style page, short-lived import-token,
      contribution-submission endpoint.

## Honest desktop link model (introduced in P3-2a)

Server stays the source of truth. Local records are **cached, unverified until reconciled** — never
presented as live server truth. States: `creating · server-confirmed · cached · reconciliation-needed
· offline · failed · revoked · expired · permission-denied · legacy-local-only · unsupported-contract`.
Because no server list endpoint is consumed, a record loaded from SQLite in a later session is
`cached`/`reconciliation-needed` (not `server-confirmed`); a link just created this session is
`server-confirmed`; records that cannot be attributed to the current account are surfaced as
`legacy-local-only`. No second cloud model is created in SQLite.

## Verified vs unsupported permissions (desktop UI must reflect this)
- **Verified today:** `allow_download` (listen/project), `collaborator_mode` (view/comment/edit) —
  sent to and stored by the server via `create-project-link`.
- **Unsupported (show disabled + honest note):** download Project Pack, open in Wavi Studio import,
  contribute, comment enforcement — no verified enforcement contract from the desktop's view.

---

# P3-2b-local — account-scoped cache isolation: **BLOCKED, no stable account identity available**

## A. Active-account identity audit (evidence)

Goal: find a **stable, non-derived** account identifier the desktop process can use to scope
cached Project Link rows to their owning account. Traced the full auth path:

| Stage | Location | Carries a stable account id? |
|---|---|---|
| Deep-link auth token in | `handleDeepLink` / token receive (electron/main.ts ~770-795) | **No** — raw Privy JWT or `wv_` token only |
| Token exchange | `exchangePrivyJwt` → `create-desktop-token` (electron/main.ts 695-731) | **No** — response is `{ token, expiresAt }` |
| Token at rest | `store.set('authToken', …)` encrypted via safeStorage (main.ts 786-789) | opaque `wv_` token only |
| Token decrypt/use | `getDecryptedToken` (main.ts ~991) | opaque token only |
| Create Project Link | `create-project-link` response (main.ts 1326) | **No** — `{ trackingId, linkUrl }` |
| Plan/usage | `X-Desktop-Action: plan` (SettingsPage.tsx 62-65) | **No** — `{ plan, usage, limits }`, and network-only (absent offline) |
| Renderer auth state | `App.tsx` `authed` | **No** — tri-state **boolean** (`null`/`false`/`true`); there is no user object |
| Logout | `auth:clearToken` (main.ts 1006) + `SettingsPage.handleLogout` → `onLogout()` → `setAuthed(false)` | clears token; unmounts the entire authed tree |
| DB schema | `links` table (electron/db.ts 223) | **No** creator/account column (`owner_user_id` at db.ts 258 is on `restored_projects` — the *sharer's* id from a resolved recipient link, not the current user) |

**Conclusion: there is no stable account identifier available to the desktop today.** The only
persisted identity artifact is the opaque `wv_` token. The forbidden derivations (email text, token
substring, token fingerprint, device id, mutable username, local path) are the *only* things that
could be manufactured from what exists — so per the P3-2b instruction, **implementation stops here.
No identifier is invented.**

## Prior (still-current) unscoped behavior
- The `links` table is written by any authenticated session and read globally (`links:getAll`,
  db.ts `getLinks`). There is no account column and logout does not clear the rows.
- Cross-account **mutation** is nonetheless prevented server-side: `revoke-project-link` is sent with
  the current token and the server enforces ownership (a foreign trackingId returns an error, which the
  desktop normalizes to `unauthorized`/`rejected` and never writes `markLinkRevoked`). The gap is
  **local visibility** of a previous account's cached rows, not unauthorized revoke.

## Why the migration is safe to defer (current honest posture)
P3-2a already prevents the worst outcome without an identity: a row loaded from SQLite is `cached`
(**never** `server-confirmed`) — only links created *this session with the current token* are shown as
confirmed. On logout/account-switch the authed React tree unmounts (`authed=false`), discarding the
`ProjectLinkClient` instances and their session-confirmed sets; the next login starts with an empty
confirmed set, so trust never bleeds across sessions. Account switch is logout+login (no in-app
switch path exists), so it shares this clearing.

## Legacy-row policy (unchanged until identity lands)
Every persisted Project Link row is, strictly, **ownership-unknown** on this device: without an account
id we cannot prove it belongs to the active account. It is therefore honestly presented as `cached`
("not re-verified this session") and legacy/listen records as `legacy-local-only`. No row is labelled
`server-confirmed` on load, and no row is auto-attributed to the active account. This is the
conservative reading of the P3-2b legacy policy given the missing contract.

## Remaining server reconciliation gap
Unchanged from P3-2a §7-9: no `list-project-links`, no per-account attribution, no permission
enforcement contract. P3-2b-local adds one hard dependency (below) that gates the account_id migration.

## Missing contract (written to the Codex handoff, §10)
The desktop needs a **stable, opaque, offline-available account identifier** delivered at
authentication time (not derived from the token). See handoff §10 for the exact shape.
---

# P3-2b-prep — account-context boundary implemented (contract-boundary path)

Codex is now implementing the canonical identity + authoritative listing contracts in the web
repo. The decision gate re-ran against the same evidence as above: **still no stable canonical
account id on the desktop**, so the schema migration remains intentionally deferred (no
`account_id` column written, no id invented). Instead the desktop now carries the full contract
boundary, so Codex's contract wires in without a second refactor:

| Piece | Where | Behavior today |
|---|---|---|
| `AuthenticatedAccountContext` + `AccountContextResolver` | `src/lib/accountContext.ts` | the single seam the canonical id will be supplied through (`PendingContractAccountResolver.supply()`); until then every resolve is `missing-account-context` |
| Canonical-id acceptance guard | `isAcceptableCanonicalAccountId` | rejects tokens (`wv_…`), JWT shapes, emails, paths, long hashes — a secret can never become an account key; client re-checks even against a rogue resolver |
| Session epoch | `SessionEpoch` (shared instance in `projectLinkClientFactory`) | monotonic; bumped by `onLogout()`/`onAccountSwitch()`; any async result resolving under an older epoch is reported `stale-epoch` and discarded |
| Scoped client ops | `ProjectLinkClient.listScoped()/revokeScoped()` | fail closed without context; list returns only rows with `record.account_id === active` (none exist today); revoke verifies local attribution BEFORE any server call — unattributed/legacy rows are never mutable through this path |
| Type-only ownership field | `LinkRecord.account_id?` | no schema change, nothing writes it; every current row is honestly `undefined` = ownership-unknown |
| Reconciliation seam | `src/lib/linkReconciliation.ts` | pure transition rules: cached→confirmed/revoked/expired, missing→reconciliation-needed, legacy→ownership-unknown, wrong account→hidden non-mutable, wrong project/version/tracking binding→`binding-conflict` (fail closed). No network code, no fake endpoint. |
| UI | LinksPage | honest "account attribution unavailable" note while the contract is pending; no redesign |
| Tests | `src/lib/accountContext.test.ts` | 12 deterministic race/isolation scenarios (cross-account visibility/revoke, switch-back, logout, epoch stale-discard, offline scoping, legacy segregation, fail-closed context, no-token-as-key, per-account revoked/expired, binding conflicts) |

**Logout / account-switch behavior:** both bump the shared epoch and clear the client's
session-confirmed + reconcile sets (in addition to the existing full React-tree unmount on
`authed=false`). **Stale-response protection:** epoch check before AND after every await in the
scoped paths. **Legacy policy:** unchanged — preserved, segregated, ownership-unknown, never
auto-assigned, never mutable via the scoped path; copy/open stay available through the existing
honest device-scoped view.

**Pending Codex dependency (exact):** canonical account id at auth time + authoritative
`list-project-links` (see `docs/handoffs/CODEX-TO-DESKTOP-project-link-reconciliation.md` for the
fields the desktop expects; wire names pending Codex's implemented contract).

---

# P3-2c-inspect — actual Codex server contract inspected (read-only)

The Codex Project Link server contracts now exist LOCALLY in the sibling `wavio` repo
(branch `test/project-links-authoritative-staging`, HEAD `c8fefb24`), but the relevant
changes to `api/desktop/index.ts` + `docs/WAVI_PROJECT_LINKS_SERVER_AUDIT.md` and the new
`api/desktop/__tests__/project-links-mutation.test.ts` were **uncommitted and unpushed** at
inspection time. Contract is real but **not yet locked**. `wavio` was inspected read-only only;
nothing there was modified.

## What the inspection changed on the desktop (bounded, fail-closed, no endpoint called)

- **Canonical identity is the Privy DID** (`did:privy:…`), returned server-side as top-level
  `accountId` on every list/create/revoke response — NOT delivered at token-exchange time.
  `isAcceptableCanonicalAccountId` previously accepted only UUID/short-id shapes and would have
  **rejected the real id**; it now accepts `did:privy:…` while still refusing tokens/JWTs/
  emails/paths/hashes.
- `src/lib/codexLinkContractAdapter.ts` — pure adapter from the observed wire shape to
  `AuthoritativeLinkRecord`: state-booleans→status enum, fail-closed on missing/contradictory
  fields, and a `pageComplete` gate encoding the server's rule that a cached link may only
  become `reconciliation-needed` after ALL pages are exhausted. No network code.
- Collaborator mode UI no longer offers `edit` — the server's `create-project-link` supports
  only `view|comment` and rejects `edit` with 400 (was previously offered = an unenforced
  permission claim).

## Delta vs the placeholder contract this doc previously assumed
- create/revoke return `{ accountId, created|revoked|alreadyRevoked, item{…} }` — **no
  `linkUrl`, no bare `trackingId`** at the top level. The legacy desktop `project:createLink`
  handler reads `result.trackingId`/`result.linkUrl`; it will need the adapter when these
  actions ship on the production endpoint.
- status is **state booleans** (`state.active/revoked/expired`), not a string enum; there is no
  `revokedAt` timestamp (revocation = `state.revoked` + `updatedAt`).

## Still blocking live wiring (see CODEX-TO-DESKTOP note §Still required)
Codex must commit+push the staging changes (lock the contract SHAs), confirm whether `accountId`
is also delivered at `create-desktop-token` (needed for offline-scoped reads, else the desktop
persists it from the first authenticated response), and confirm rollout ordering so the current
production create/revoke shape holds until the desktop ships the adapter. **No merge into
integration until the contract is committed and pushed.**

---

# P3-2c — authoritative networking + account-scoped persistence IMPLEMENTED

Locked Codex contract: `wavio` @ `d34d5218eb0b992920a43939eb5c892f69aed030`,
`POST {API_BASE}/desktop`, actions `list-project-links | create-project-link |
revoke-project-link`, identity = server Privy DID in `accountId`.

## What landed (desktop, main-process authority)
- `electron/projectLinkService.ts` — pure, injectable networking + parsing +
  reconciliation planning against the locked shapes: `parseItem` (state booleans→
  status, fail-closed), `classifyHttpFailure` (401/403→unauthorized, 404→not-found,
  409→conflict, 400→rejected, 5xx→retryable, thrown→offline), paginated
  `listProjectLinksAll` (accumulates every page; `pageComplete` only when the
  server says `hasMore:false`), `createProjectLinkFlow`/`revokeProjectLinkFlow`
  (confirmed only with `accountId` + `created/revoked/alreadyRevoked` + a
  parseable `item` — never a fabricated success), and `planReconciliation`
  (owner-only apply; reconciliation-needed only when page-complete; legacy/foreign
  rows never touched).
- `electron/main.ts` — `postDesktopAction` hits `${API_BASE}/desktop` (token in
  main only); IPC `projectLinks:reconcile|getScoped|create|revoke`; captures the
  server DID into `currentAccountId` and pushes `auth:account` to the renderer;
  `auth:clearToken` clears the DID and signals logout.
- `electron/db.ts` — bounded `ALTER TABLE links ADD COLUMN account_id` (nullable,
  additive, legacy rows preserved); `recordLink` stamps `account_id` on
  server-confirmed creates; `getLinksForAccount` / `getLegacyUnscopedLinks` /
  `applyAuthoritativeLink` (owner-scoped reconcile) / `markLinkRevokedForAccount`.
- Renderer (`src/lib/api.ts`, `projectLinkClientFactory.ts`) — typed
  `api.projectLinks.*`; the factory routes create/revoke/list through the
  authoritative IPC and bridges `auth:account` → `sharedAccountResolver`
  (supply on login, `onAccountSwitch` on DID change, `onLogout` on null). Token
  and DID never reach the renderer.

## Identity & isolation
Active account = server Privy DID (never derived from the token). Cache rows are
account-scoped; account A never sees account B's rows; legacy NULL-account rows
are segregated as ownership-unknown and never auto-assigned; logout clears the
in-memory DID + resolver; a DID change reloads the new account's scope.

## Still requiring live verification (not unit-testable here)
The real `fetch` against the deployed `/api/desktop` endpoint, and the end-to-end
renderer reconcile/switch flow, need a live signed-in staging pass. The pure
contract logic (parsing, pagination, reconciliation, account scoping, fail-closed
create/revoke) is covered by `electron/projectLinkService.test.ts` (15) and the
account-scoping SQL by `electron/links.test.ts` (P3-2c block).

---

# P3-2c pre-merge hardening (correctness audit)

## Endpoint resolution — PROVEN locally
`buildDesktopEndpoint(API_BASE)` is THE single endpoint builder (`electron/projectLinkService.ts`).
It guarantees exactly `/api/desktop` for every environment shape: production default
(`https://wavi.stream/api`), preview/QA (`…vercel.app/api`, per `electron-builder.qa.json`
`waviQaDefaults.apiBase`), dev localhost with or without `/api`, a misconfigured bare origin
(gains `/api`), trailing slashes, and an accidental `/api/api` (collapsed). It can never emit
`/desktop`, `/api/api/desktop`, or the obsolete `/desktop/index`. Deterministic tests:
`projectLinkHardening.test.ts` §endpoint. `main.ts` uses `DESKTOP_ENDPOINT = buildDesktopEndpoint(API_BASE)`;
no inline `${API_BASE}/desktop` fetch remains (source-guard test).

## Obsolete paths — disposition
- `project:createLink` step-2 and `project:revokeLink` are ROUTED through the authoritative
  flows (dedup + typed results), keeping their legacy response shapes for existing callers.
- `links:revoke` routes `kind='project'` through the authoritative flow; `kind='listen'`
  stays on the legacy `revoke-share-link` action — UNRELATED to the PL contract (documented).
- `desktopApiPost` (`/desktop/index`) remains ONLY for non-PL legacy production actions
  (publish-project-version, get-project-files, share links, create-desktop-token, resolve) —
  a source-guard test asserts the PL trio can never pass through it.
- LinksPage dispatches revoke by kind (listen → legacy share path; project → authoritative).

## Account-identity boundary — CORRECTED to be honest
Previous state contradicted itself (`auth:account` carried the DID while docs said the DID
never left main). Now: the canonical Privy DID is MAIN-PROCESS ONLY. The renderer receives an
opaque, non-reversible handle `acct_<sha256(did)[0..20]>` (`toRendererAccountHandle`) over
`auth:account` and inside DID-stripped scoped/legacy rows (`toRendererRows`). The handle is a
stable scoping key, not a secret. Source-guard tests prove every `auth:account` send is the
handle or the null logout signal, and that assistant surfaces (`agentLoop.ts` system prompt,
`copilotTypes.ts` ProjectContext) contain no account identity or token fields.

## Real SQLite migration — PROVEN (drift-proof)
`electron/dbMigration.real.test.ts` EXTRACTS the actual SQL from `db.ts` (CREATE TABLE links,
the `account_id` ALTER, scoped select/apply/revoke statements) and executes those exact strings
against a real better-sqlite3 database (repo Node-ABI fixture): legacy rows survive; column is
nullable; existing rows stay NULL; repeated init is idempotent; A/B reads isolated; foreign-
account revoke/apply are no-ops; a failing second ALTER leaves data intact. This is no longer a
mirrored copy — it fails if db.ts's shipped SQL changes.

## Reconcile-on-load lifecycle
No token → no network request (guard precedes any fetch). `createLinkOpsCoordinator` gives ONE
in-flight reconcile per filter (repeated mounts share the promise) and a session-generation
counter bumped on logout/account switch — an in-flight response resolves `stale` and is
DISCARDED (nothing persisted; typed `stale-session`). Offline/HTTP failures return typed errors
with no db writes (cache never erased/reattributed). `planReconciliation` is filter-scoped: a
project/version-filtered listing can never flag out-of-scope rows, and nothing is flagged
unless the listing was page-complete.

## Non-idempotent create
One in-flight create per `normalizeCreateKey` configuration (double-click shares the promise);
no automatic retry ever; a thrown/aborted request is `create-outcome-unknown` with recovery
pointed at the authoritative listing (reconcile); a session change mid-flight discards the
response without persisting (`stale-session`); persistence still requires the full
server-confirmed response. Revoke is exempt (server-side idempotent via `alreadyRevoked`).

## Status ladder (honest)
- **Source contract:** LOCKED (`wavio` @ d34d5218). ✅
- **Local desktop behavior:** PROVEN (596/596 tests, 0 skips). ✅
- **Real SQLite migration:** PROVEN (actual-SQL extraction against real DB). ✅
- **Staging authenticated smoke:** PENDING (Codex is provisioning isolated staging). ⏳
- **Production deployment:** BLOCKED until staging smoke passes. ⛔
