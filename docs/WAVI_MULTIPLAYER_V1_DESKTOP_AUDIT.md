# Wavi Desktop — Multiplayer v1 Adapter Audit

Status: **desktop contract/IPC foundation implemented; no UI, no assistant exposure**
Date: 2026-08-08 · Repo: `wavio-studio` · Branch: `feat/multiplayer-v1-desktop-adapter`
Base: `feature/ableton-daw-companion` @ `baae3454`

Server authority (read-only, never modified): `wavio` @ `6a4a9e8050902cd9f16cd3d4e067ef56eb6ca584`,
branch `feat/multiplayer-v1-server-contracts`, file `api/desktop/multiplayer.ts`, dispatched from
`api/desktop/index.ts` after the three Project Link actions.

Where the earlier desktop packet
(`docs/handoffs/DESKTOP-TO-CODEX-multiplayer-v1-contracts.md`) disagrees with the shipped server,
**the server wins** — every divergence is listed in §7.

---

## 1. What was built

| Layer | File | Role |
|---|---|---|
| Pure contract adapter | `electron/multiplayerService.ts` | Locked actions/vocabulary, fail-closed parsers, status mapping, pagination, mutation flows, operation-key ledger. **No networking of its own.** |
| Boundary + projections | `electron/multiplayerRefs.ts` | `pmember_…` / `pcontrib_…` opaque refs, renderer-safe views, honest failure copy |
| Wiring | `electron/main.ts` | 8 IPC handlers, session/epoch invalidation, single manifest builder |
| Renderer surface | `electron/preload.ts`, `src/lib/api.ts` | `window.wavi.multiplayer.*` + types. **No component consumes it yet.** |

There is **one** HTTP implementation in the app (`postDesktopAction` in `main.ts`, endpoint from
`buildDesktopEndpoint`). The multiplayer service takes an injected `postDesktop` dependency; a test
asserts the file contains no transport, header, or credential code.

## 2. Locked contract as implemented

**Actions (8, exact):** `list-project-collaborators`, `invite-project-collaborator`,
`respond-project-invite`, `revoke-project-collaborator`, `list-project-activity`,
`publish-project-version`, `respond-project-contribution`, `withdraw-project-contribution`.

**Activity vocabulary (8, closed):** `collaborator_invited`, `collaborator_joined`,
`collaborator_removed`, `version_published`, `contribution_submitted`, `contribution_accepted`,
`contribution_rejected`, `contribution_withdrawn`. An unknown type is **dropped and counted**
(`skippedUnknownEvents`), never rendered as raw server text.

**Pagination:** `limit` clamped to `[1,100]`, default 50; cursor followed until `hasMore` is false;
`pageComplete` is only true when the server said so. A listing whose `accountId` changes between
pages is discarded as `stale-session`.

**Status mapping** — deliberately *not* flattened:

| Status | Reason | Why distinct |
|---|---|---|
| 401 | `unauthorized` | signing in fixes it |
| 403 | `forbidden` | signing in does **not** fix it |
| 404 | `not-found` | |
| 409 | `conflict` | a state race the caller can re-read out of |
| 410 | `invite-expired` | terminal; an expired invite is not a race |
| 400 | `rejected` | |
| ≥500 | `retryable` | |

**Idempotency echoes are preserved, not swallowed:** `alreadyInvited`, `alreadyAccepted`,
`alreadyDeclined`, `alreadyRevoked`, `alreadyAccepted|alreadyRejected|alreadyWithdrawn`, and
`alreadySubmitted` each reach the caller as a distinct boolean so the UI can say "already done"
rather than implying a fresh action occurred.

## 3. Role vocabulary

`owner` | `view` | `comment`. **There is no `edit`.** `normalizeAssignableRole` rejects it *before*
any network call with copy naming the real vocabulary. `canContribute` is a **separate** field on
both the wire and every projection; it is never inferred from `comment`. A membership with an
uninterpretable role fails the whole listing rather than being silently omitted — omitting a
collaborator is a worse failure than showing an error.

## 4. Contribution publishing and operation-key recovery

The contribution path reuses **the existing publish pipeline**. `main.ts` previously contained two
divergent inline manifest builders (in `doPublishVersion` and in `project:createLink`); those were
consolidated into a single `buildPublishManifestBody()` now used by all three publish paths
(plain publish, publish-on-create-link, contribution). A test asserts exactly one definition.

`buildContributionBody()` adds only `contribution: true`, `parentVersionId`, `operationKey`,
`clientCorrelationId`, `contributorNote` on top of that manifest, and **strips `sourceRestoreId`**
defensively — it is a desktop-local restored-row id, not a server identity, and is never sent.

**Operation-key strategy (where it lives and why):**
- Minted **once**, before the mutation, by `ContributionOperationLedger.acquire()`, keyed on
  `(cloud project, parent version, local project)`.
- **Retained** while the outcome is unknown. A thrown/aborted request returns
  `contribution-outcome-unknown` — never `offline`, never a fabricated success, never an auto-retry.
- A retry within the session **reuses the same key**, so the server replays it and returns
  `alreadySubmitted: true` with the **original** `child_version_id` instead of creating a second
  contribution.
- **Released** once the outcome is known (confirmed, or terminally rejected so a corrected submit is
  a genuinely new operation).
- **In memory only, never persisted.** A key surviving the process could be replayed under a
  different account or session; the server listing is already the authoritative recovery path.
- **Cleared** on logout and on account switch.

## 5. Privacy and account boundary

Never crosses to the renderer: the auth token, the canonical Privy DID, canonical membership /
contribution / activity / version ids, raw server error text, or any filesystem path. The renderer
receives opaque `pmember_…` / `pcontrib_…` refs, display-only actor fields, state booleans plus a
derived display state, and a typed reason mapped to fixed honest copy.

Refs fail closed on: malformed, unknown, wrong kind (member ref used as contribution), cross-account,
cross-project, and stale epoch. Logout and account switch clear the ref registry **and** the
operation ledger, alongside the existing Project Link invalidation.

## 6. Version lineage — no local schema change

**Decision: server-authoritative; no migration.** Lineage (`parentVersionId` → `childVersionId`) is
carried on the contribution record the server returns, and membership/activity/contribution state
all have server `revision` markers. Nothing in this task needed a local row that SQLite does not
already have, so no migration was written — consistent with the standing rule that a migration must
be additive, nullable, idempotent, and proven against a real database, and that none should be
invented speculatively (and with DR-015: no second musical-session schema).

## 7. Divergences from the earlier desktop packet — server wins

| Packet proposed | Shipped server | Adapter follows |
|---|---|---|
| Invite by email as a convenience | **Email invitations unsupported** (400) | Local rejection with the contract-accurate message; no email is ever sent |
| Contribution ambiguity ≈ create-outcome-unknown (no retry) | `operationKey` replay is supported | `contribution-outcome-unknown` **plus** same-key replay as the recovery path |
| Single membership `state` enum | Booleans | Booleans authoritative; display state derived on top |
| `sourceRestoreId` as parent hint | Not part of the contract | Never sent; stripped defensively |

## 8. Open contract gap (recorded, not worked around)

**There is no account-discovery action.** `invite-project-collaborator` requires a canonical
`inviteeAccountId` (Privy DID), email is explicitly unsupported, and the locked contract has no
lookup/search/handle-resolution action. The desktop therefore has **no way to obtain an invitee's
account id**, so a collaborator-invite UI cannot be completed by the desktop alone. The adapter
accepts an explicit account id and validates its shape; it does not invent a lookup. Resolving this
needs a server-side contract addition (a directory/handle-resolution action, or an invite-by-email
capability) — to be raised with Codex as a follow-up packet.

## 9. Verification

- **Tests: 782 passed / 45 files / 0 skips** (baseline `baae3454` was 670; **+112 new**, none
  weakened or deleted). New suites: `multiplayerContract` (33), `multiplayerMembership` (24),
  `multiplayerContribution` (31), `multiplayerPrivacy` (24).
- `tsc --noEmit` clean for both `tsconfig.json` and `tsconfig.electron.json`.
- **Dev-only staging contract check** against
  `https://wavi-staging-iyusbdaz4-rgdevas-projects.vercel.app/api` (deployment
  `dpl_AWqDPVanoX6sa1z7Q5jxS3CPY9Nd`): all 8 multiplayer actions return **401 `{"error":"Unauthorized"}`**
  while an unregistered action returns **400 `{"error":"Unknown or missing X-Desktop-Action"}`** —
  proving the actions are genuinely registered in the deployed router and that endpoint resolution
  (`buildDesktopEndpoint` → `/api/desktop`, no `/api/api`) is correct against the real host.
  **No authenticated pass was performed** (interactive Privy login); none is claimed.

## 10. Explicitly NOT done in this task

The three multiplayer assistant tools (`invite_collaborator`, `inspect_collaborator_activity`,
`publish_child_version`) **remain blocked** — a test asserts no assistant tool references any
`multiplayer:` channel. No collaborator UI, no Project Detail redesign, no recipient pages, no
import-token/package flows, no realtime presence, no simultaneous DAW editing, no WebSockets, no
comments. No server contract was modified; `wavio` was read-only throughout. Not merged.
