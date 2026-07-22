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
