# Codex → Desktop — Project Link account & reconciliation contract (integration note)

**From:** Wavi Studio desktop lane · **To:** Codex (web/backend lane)
**Date:** 2026-07-22 · **Status:** desktop seam is BUILT and waiting; wire names PENDING
**Desktop seam:** `src/lib/accountContext.ts` + `src/lib/linkReconciliation.ts` +
`ProjectLinkClient.listScoped()/revokeScoped()` (branch `feat/project-links-account-context-prep`).

Codex is implementing canonical account identity, authoritative `list-project-links`,
account-scoped create/revoke responses, typed errors, and RLS/ownership enforcement in the
web repo. This note lists exactly what the desktop consumes from that work. **Every field
name and endpoint path below is a semantic placeholder — the desktop will adapt to whatever
names Codex actually ships. Do not treat these spellings as final.**

## 1. Canonical account identity (hard dependency)

Desktop needs ONE stable, backend-owned principal id for the authenticated account:

| Semantic field | Desktop use | Constraints |
|---|---|---|
| `accountId` *(name pending)* | key for local cache scoping; supplied to `PendingContractAccountResolver.supply()` | stable across logins; opaque (no PII); **not** the token or derivable from it; ideally a UUID. Desktop **rejects** token-shaped/email/path values by validation. |

Delivery point (pick what you ship; desktop adapts): on the `create-desktop-token`
exchange response, and/or a `whoami`-style action, and/or included on link responses.
To scope **offline** reads the desktop must be able to persist it at auth time in the
main process — so auth-time delivery is strongly preferred.

## 2. Authoritative link listing (per authenticated account)

For each Project Link owned by the account, desktop expects the following semantics
(maps 1:1 onto `AuthoritativeLinkRecord` in `src/lib/linkReconciliation.ts`):

| Semantic field | Notes |
|---|---|
| `accountId` | owning canonical account (must equal §1's id) |
| `linkId` | authoritative server row id (may equal trackingId) |
| `trackingId` | public id in recipient URLs — desktop's join key to cached rows |
| `projectId` | cloud project the link belongs to |
| `projectVersionId` | immutable published version the link references |
| `status` | `active \| revoked \| expired` (server truth) |
| `permissions` | enforced permission keys + values (desktop only trusts keys it knows) |
| `createdAt` / `expiresAt` / `revokedAt` | ISO timestamps (`null` where n/a) |
| `updatedAt` and/or `revision` | monotonic change marker for cheap re-sync |

## 3. Account-scoped create / revoke responses

- `create-project-link` response should include the owning `accountId` (lets desktop stamp
  the local row the moment the migration lands).
- `revoke-project-link` errors should be **typed/distinguishable**: not-owner vs
  unauthorized vs not-found vs expired — desktop maps them onto its typed `LinkResult`
  (`rejected` / `unauthorized` / `unsupported` / `retryable`) and never guesses.

## 4. What the desktop does the moment Codex reports the contract

1. Thin adapter: wire names → `AuthoritativeLinkRecord`; `supply(accountId)` at auth.
2. Bounded SQLite migration: nullable `account_id` on `links`; legacy rows preserved as
   ownership-unknown; new server-confirmed creates stamped.
3. Reconciliation pass via the already-tested `reconcileLink()` rules: cached→confirmed/
   revoked/expired; missing→reconciliation-needed; wrong account→hidden non-mutable;
   binding conflicts fail closed (a link can never re-attach to a different project/version).
4. Main-process read/revoke scoping by `account_id` (today enforced at the client boundary;
   the persistence layer takes over once rows are attributable).

Nothing in the desktop repo fakes any of this today: no fake endpoint, no invented id, no
ownership writes. Reply with the implemented action names + response shapes and the desktop
wiring is a single bounded task.

---

# UPDATE 2026-07-22 — actual Codex implementation inspected (read-only)

Inspected in the sibling `wavio` repo, branch `test/project-links-authoritative-staging`
(HEAD `c8fefb24`, base `831d071f` vs origin/main). **The relevant changes were UNCOMMITTED
and the branch had no upstream at inspection time — contract is real but not yet locked.**
Full server-side spec: `wavio/docs/WAVI_PROJECT_LINKS_SERVER_AUDIT.md` (also uncommitted).

## Observed contract (supersedes the semantic placeholders above)

- **Identity:** canonical account id = **Privy DID** (`did:privy:…`), resolved server-side from
  the Bearer token (`validateDesktopToken().userId`, else `verifyPrivyToken`). Returned as
  top-level `accountId` on every list/create/revoke response. NOT delivered at token-exchange
  time — the desktop learns it from the first authenticated link call.
- **Endpoint:** `POST {API_BASE}/desktop/index`, `X-Desktop-Action:
  list-project-links | create-project-link | revoke-project-link`.
- **List:** `{ accountId, items[], pageInfo{ limit, hasMore, nextCursor, order:'updatedAtDesc,idDesc',
  scope:'owner' } }`; cursor-paged (max 100/page). **Reconciliation rule:** a cached link may be
  marked reconciliation-needed ONLY after every page is exhausted.
- **Item shape:** `{ id, trackingId, publicIdentifier, projectId, versionId, ownerAccountId,
  createdAt, updatedAt, revision(=updatedAt), expiresAt, state{active,revoked,expired},
  permissions{allowDownload, collaboratorMode, previewEnabled, requiresPassword} }` — status is
  **state booleans**, no enum; no `revokedAt` timestamp.
- **Create:** validates ownership (404 not-owner), version (409 none), collaboratorMode
  (`view|comment` ONLY — `edit` is rejected 400); response `{ accountId, created:true, item }`.
  ⚠ No `linkUrl` and no bare `trackingId` — the legacy desktop path that reads
  `result.trackingId`/`result.linkUrl` must adapt when this ships.
- **Revoke:** `{ trackingId }` → `{ accountId, revoked:true, item }`, idempotent
  (`alreadyRevoked:true`), 404 when not found/not owned.

## Desktop code updated against this (branch feat/project-links-authoritative-reconciliation)

- `isAcceptableCanonicalAccountId` now accepts `did:privy:…` (was UUID-only — would have
  rejected the real id).
- `src/lib/codexLinkContractAdapter.ts`: pure fail-closed adapter (item + list parsing,
  state-boolean→status mapping, `pageComplete` gate for reconciliation-needed) + tests using
  the exact documented sample payloads. No endpoint is called yet.
- UI stops offering collaborator mode `edit` (server rejects it).

## Still required from Codex before live wiring

1. **Commit + push** the staging changes (or report the final SHAs) so the contract is locked.
2. Confirm whether `accountId` will ALSO be delivered at `create-desktop-token` time —
   without that, offline-scoped reads need the desktop to persist the id from the first
   authenticated response instead (workable, but say which).
3. Confirm the legacy `create-project-link`/`revoke-project-link` actions on the CURRENT
   production endpoint keep their old response shape until the desktop ships the adapter
   (rollout ordering).

---

# UPDATE — desktop hardened against the LOCKED contract (pre-merge audit)

Contract SHA `d34d5218` is committed on `test/project-links-authoritative-staging`. Desktop
now: builds the endpoint through one authoritative builder (`/api/desktop`, never
`/desktop/index` for the PL trio); routes ALL project-link mutations through the single
service (legacy IPC handlers included); keeps the Privy DID main-process-only (renderer gets
an opaque `acct_…` handle); dedups in-flight reconcile/create; treats ambiguous create as
`create-outcome-unknown` (no auto-retry, recovery = listing); and proves the `account_id`
migration against a real SQLite database using db.ts's own extracted SQL.

**Remaining ask:** the provably isolated staging deployment + one authenticated smoke
(list/create/revoke with a real token) — the only blocker before merge/production.

---

# RESOLVED — staging smoke PASSED; desktop merged into development integration

Codex's authenticated isolated staging smoke passed at server SHA
`a561dee62806fe9d1fc99365121dda9c5799ddb0` (deployment `dpl_E2HFE5xsYS7tTKwy23pJBHMxAeYC`,
alias `https://wavi-staging.vercel.app`, isolated Supabase `qjhzrxgiomctzxdzywhu`, production
untouched, server PL tests 19/19). Verified locally: that SHA is a descendant of the locked
contract `d34d5218…` and `api/desktop/index.ts` is byte-identical — **no adapter change needed**.

Desktop reconciliation `9bb5b574` is merged into `feature/ableton-daw-companion` as `ec38ebba`
(development integration, not a production release; 596/596 tests, 0 skips, packaged build OK).

**Nothing further is required from Codex for this milestone.** Remaining desktop-side items:
one manual authenticated staging smoke inside the running app (interactive Privy sign-in), then
P3-3b to unblock the assistant's Project Link tools. Recipient page / import token / contribution
APIs remain out of scope and are still the open cross-repo asks.
