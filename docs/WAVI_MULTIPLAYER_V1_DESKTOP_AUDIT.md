# Wavi Desktop — Multiplayer v1 Adapter Audit

Status: **LANDED in development integration — desktop contract/IPC foundation complete;
no UI, no assistant exposure**
Date: 2026-08-08 · Repo: `wavio-studio`
Landed: `feat/multiplayer-v1-desktop-adapter` @ `68584d26` → `feature/ableton-daw-companion`
via `--no-ff` merge `64ea4230` (base `baae3454`; **zero conflicts** — the merge-base *was*
integration HEAD). Server contract consumed at `wavio @ 6a4a9e8`.

**UPDATE (2026-08-08) — `P3-4-ID` IS RESOLVED.** Codex shipped
`resolve-invite-target` at `wavio@d95683f2ff6d64d1442c579153f8a22faad63ce1`
(deployment `dpl_HTcciPB8SjcHrbeADah3qGecKrEK`). Branch
`feat/multiplayer-v1-ui-assistant` consumes it and delivers the first complete user-facing
collaboration workflow. See §12 for what landed, §13 for the four adapter defects that reading the
real server exposed, and §14 for the one remaining contract gap (`P3-4-CL`).

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

## 8. See §11 — blocker P3-4-ID

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
comments. No server contract was modified; `wavio` was read-only throughout.

---

## 11. BLOCKER — `P3-4-ID` · Collaborator identity resolution

**Severity: blocks the Multiplayer v1 collaborator FEATURE (not the foundation).**
**Owner: server (Codex). Desktop cannot resolve this alone.**

### The problem

The desktop needs a privacy-safe way to turn a **human-entered collaborator identifier** into an
**inviteable server-side account reference**, without ever exposing a canonical Privy DID to the
renderer, the model, or the person doing the inviting.

Today that is impossible, because all four of these hold at once:

1. `invite-project-collaborator` requires `inviteeAccountId` — a **canonical Privy DID**.
2. Email invitation is **explicitly rejected** by the contract
   (400 "Email invitations are not supported by this contract").
3. The locked contract has **no account discovery / lookup / handle-resolution action**.
4. The desktop's own privacy boundary forbids canonical DIDs in renderer state, UI, or model
   surfaces — so even if a DID were somehow obtained, it could not be typed in, displayed, or stored.

There is no legitimate path from "the user wants to invite their collaborator" to a value the
server will accept.

### Rejected workarounds — do not implement any of these

| Workaround | Why it is rejected |
|---|---|
| Prompt the user to paste a Privy DID | Puts a canonical identity in the UI and renderer state; users don't have it anyway |
| Show DIDs anywhere in the UI | Violates the renderer privacy boundary |
| Cache DIDs in renderer state | Same, and it persists the leak |
| Send an email address to the existing invite action | Contract-rejected (400); pretending otherwise fabricates a capability |
| Query Privy directly from the renderer | Bypasses the main-process credential boundary entirely |
| Invent local user discovery / a desktop-side directory | Fabricates identity the server never authorised; unverifiable and unsafe |
| Weaken the boundary "just for invites" | The boundary is the feature's security model |

The adapter therefore accepts an explicit account id, **validates its shape**, and rejects an email
locally with the contract's own reason. It does not invent a lookup.

### Recommended contract addition (additive, staging-validated)

A single new desktop action, in the same locked transport
(`POST /api/desktop` + `X-Desktop-Action`), that resolves a **user-typeable** identifier into an
**opaque, server-minted, short-lived invite reference** — never a DID:

```
X-Desktop-Action: resolve-invite-target
request  { projectId, identifier }        // identifier = email or @handle, user-typed
response 200 { accountId,                 // the CALLER's own DID (as every action returns)
               resolved: true,
               inviteTarget: "invt_…",    // opaque, single-project, short-TTL, server-minted
               display: { displayName, avatarUrl } }   // display-only, safe to render
         200 { accountId, resolved: false }            // no account — do NOT reveal existence
         403 non-owner   ·   429 rate-limited
```

Then extend the existing invite action **additively**:

```
invite-project-collaborator
  accepts EITHER inviteeAccountId (unchanged, server-internal callers)
              OR inviteTarget     (new, desktop path)
```

Required properties:
- `inviteTarget` is **opaque and non-reversible** — it must not encode the DID.
- **Scoped to one project and short-lived**, so a leaked reference has minimal blast radius.
- `resolved: false` must be **indistinguishable from a non-existent account** and rate-limited, so
  the action cannot be used to enumerate who has a Wavi account.
- Only `displayName` / `avatarUrl` are returned for rendering — never the canonical identity.

With that in place the desktop can build the invite UI with no boundary change: the user types an
email or handle, the main process resolves it, the renderer only ever sees `invt_…` plus display
fields, and the DID never leaves the server.

### Until then

- Collaborator **invite UI**: blocked.
- `invite_collaborator` assistant tool: **stays blocked**.
- Everything else in Multiplayer v1 (listing collaborators, responding to invites received,
  self-leave, revoke, activity, contributions, review, withdrawal) is **unblocked and landed** —
  none of it requires resolving a stranger's identity.

---

## 12. P3-4 · User-facing collaboration workflow (branch `feat/multiplayer-v1-ui-assistant`)

Base: `feature/ableton-daw-companion @ 8b5129b0`.
Contracts consumed: Multiplayer v1 `wavio@6a4a9e8` + **P3-4-ID `wavio@d95683f`**.

### Identity resolution
`resolve-invite-target` is served by the SAME injected transport as every other action — still one
HTTP implementation. The desktop validates the identifier locally first (mirroring the server's
own `parseInviteIdentifier`) so a malformed entry never burns one of the user's 10 lookups per
15 minutes. Resolution runs **only** from an explicit user action: never on keystroke, blur, mount,
or as a model-initiated retry.

`resolved: false` is a **single** state with a **single** message
(`INVITE_TARGET_UNRESOLVED_MESSAGE`). The server deliberately makes a hidden account and a
nonexistent one indistinguishable; there is exactly one string in the codebase for this case and a
test asserts it contains no hidden/exists wording.

### The `invt_…` capability never leaves main
The raw server capability is stored only inside a `pinvite_…` ref bound to
`{account, project, epoch, expiresAtMs}`. It fails closed on malformed, unknown, wrong-kind,
cross-account, cross-project, stale-epoch, **and expiry** (checked locally against the server's
10-minute TTL, before a request that would waste a lookup). `forget()` spends the ref on a
successful invite so a consumed capability cannot be replayed. Logout and account switch clear it.

### Roles
`view` | `comment`; no `edit`. The server computes
`can_contribute = role === 'comment' && canContribute`, so a `view` invite **never** claims
contribution — the UI disables the toggle and the assistant refuses the combination explicitly
rather than letting the request be silently downgraded.

### Role editing is NOT offered
The contract has no update-membership action. Rather than shipping a control that would secretly
revoke-and-reinvite, `roleChangeSupport()` returns `supported: false` and the UI states that
changing a role means removing and re-inviting.

### Surfaces
- **Project Detail → Collaborators** — resolve → invite (role + separate contribution toggle),
  roster with role/contribution/state, owner-only remove. Real states for idle / resolving /
  resolved / unresolved / rate-limited / offline / auth-required / error, and for empty / pending /
  expired / revoked / offline / auth-required rosters.
- **Project Detail → Activity** — server collaborator activity (closed enum, safe actor,
  `Load more`, honest "N newer events could not be shown") kept **separate** from this device's
  local sync history so a local event is never mistaken for a collaborator's.
- **Project Detail → Versions** — compact lineage (`Based on v12 · Contribution · Accepted`) plus
  contribution accept / reject / withdraw. No optimistic state: every mutation re-reads server
  truth, and a 409 reconciles instead of reporting success.

Ownership is **server-authoritative** — derived from the roster's own `owner` row, defaulting to
non-owner so owner-only controls never flash on before truth arrives.

### Assistant
`BLOCKED_CAPABILITIES` is now **empty**. Four tools: `find_collaborator` (read-only),
`invite_collaborator` (gated), `inspect_collaborator_activity` (read-only),
`publish_child_version` (gated). The model receives only `pinvite_…` / display names; it can never
self-confirm, and the publish card says **NEW CHILD VERSION** and explicitly denies overwriting.
An unresolved lookup instructs the model **not** to retry spellings — that would probe for who has
a Wavi account.

## 13. Four adapter defects found by reading the real server

The Multiplayer adapter landed at `64ea4230` had four wire-format bugs. They were not caught
earlier because the tests asserted the shapes I had assumed, not the server's. All four are fixed
here and the tests now assert the server's actual contract.

| # | Defect | Reality | Effect if shipped |
|---|---|---|---|
| 1 | `respond-project-invite` sent `accept: boolean` | wants `response: 'accept' \| 'decline'` | every invite response 400s |
| 2 | `respond-project-contribution` sent `accept: boolean` (+ a `reviewerNote` the server ignores) | wants `response: 'accept' \| 'reject'`, no note | every review 400s |
| 3 | `revoke-project-collaborator` sent only `membershipId` | requires `projectId` **and** `membershipId` | every revoke 400s |
| 4 | invite sent `canContribute` for `view` | server forces false unless `comment` | silently weaker permission than the UI implied |

**Lesson recorded:** a fake that encodes our own assumption proves nothing about the contract. The
new suites assert request bodies field-by-field against the locked handler.

## 14. Remaining contract gap — `P3-4-CL` · Contribution listing

There is **no `list-project-contributions` action**. Contributions are only returned by
`publish-project-version`, `respond-project-contribution`, and `withdraw-project-contribution`,
and the activity feed's safe projection deliberately drops subject ids.

Consequence: the Contributions section can only show contributions **this device submitted or acted
on in the current session**. The UI says exactly that and points at the Activity tab; no listing is
faked. An owner cannot currently see a full queue of pending contributions in one place.

**Requested (additive):** `list-project-contributions { projectId, state?, limit, cursor }` →
`{ accountId, items: [mapContribution…], pageInfo }` with the same cursor contract as the other
listings. The desktop already has the parser, the `pcontrib_…` refs, and the review controls; only
the listing is missing.

## 15. Verification (P3-4)

- **874/874 tests · 48 files · 0 skips** (baseline `8b5129b0` was 782 → **+92**). No test weakened;
  7 pre-existing assertions were **corrected** to the server's real contract (§13).
- `tsc --noEmit` clean for both projects · `git diff --check` clean · production build OK ·
  unsigned packaged `Wavi Studio.app` built.
- Secret scan and absolute-path scan clean across the new source.
- **Staging contract check** against `https://wavi-staging-62hpiqw9z-rgdevas-projects.vercel.app/api`
  (`dpl_HTcciPB8SjcHrbeADah3qGecKrEK`): all **nine** actions — including
  `resolve-invite-target` — return `401 {"error":"Unauthorized"}`, while an unregistered action
  returns `400 {"error":"Unknown or missing X-Desktop-Action"}`, proving all nine are registered.
- **No authenticated desktop smoke was performed and none is claimed.** The desktop token is
  written by an interactive Privy login into Electron `safeStorage`; there is no non-interactive way
  to mint one here. **Remaining manual step:** sign in to a staging build, then exercise
  resolve → invite → roster → activity → contribution submit → accept/reject/withdraw against
  `dpl_HTcciPB8SjcHrbeADah3qGecKrEK`.
- **Packaging issue still open, deliberately untouched:** 11 compiled `.test.js` files ship inside
  `app.asar` (3 containing a developer home path). Pre-existing, no runtime path leak, tracked as a
  separate packaging-hardening task.

## 16. Remaining release gates

1. Authenticated desktop staging smoke (above) — the only functional gate left.
2. `P3-4-CL` contribution listing, for a complete owner review queue.
3. Packaging hardening (compiled test files in `app.asar`).
4. Merge into development integration (this branch is intentionally **unmerged**).
5. No production release; no production deployment.
