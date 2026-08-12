# Wavi Desktop — Multiplayer v1 Adapter Audit

Status: **LANDED in development integration — adapter, UI, and assistant all complete**
Date: 2026-08-08 · Repo: `wavio-studio`

Landed in two merges onto `feature/ableton-daw-companion`:
1. `feat/multiplayer-v1-desktop-adapter` @ `68584d26` → `--no-ff` `64ea4230` (base `baae3454`) —
   contract/IPC foundation. Consumed `wavio @ 6a4a9e8`.
2. `feat/multiplayer-v1-ui-assistant` @ `eb591e21` → `--no-ff` `f0c7bb74` (base `8b5129b0`) —
   UI + assistant + the four contract corrections. Consumed `wavio @ d95683f`.

Both merges were conflict-free (each merge-base *was* integration HEAD).

**UPDATE (2026-08-08) — `P3-4-ID` IS RESOLVED, AND THE UI + ASSISTANT ARE LANDED.**
Codex shipped `resolve-invite-target` at `wavio@d95683f2ff6d64d1442c579153f8a22faad63ce1`
(deployment `dpl_HTcciPB8SjcHrbeADah3qGecKrEK`).
`feat/multiplayer-v1-ui-assistant @ eb591e21` merged into `feature/ableton-daw-companion`
as `--no-ff` merge **`f0c7bb74`** (base `8b5129b0`; **zero conflicts**).

**Multiplayer v1 is now landed in development integration.** See §12 for the workflow, §13 for the
four adapter defects that reading the real server exposed and which this merge repairs, and §14 for
the one remaining server-owned gap (`P3-4-CL`).

**UPDATE (2026-08-08) — `P3-4-CL` IS ALSO CLOSED at source level.** Codex shipped
`list-project-contributions` at `wavio@6236c3901966e88bb9a05bef79253463bffa6abd`
(deployment `dpl_3LaE73wZTRZJxFGS1FA25TqQaASx`). Branch `feat/contribution-queue-desktop`
implements the authoritative durable review queue — see **§19**. That branch is UNMERGED.

**Not a release.** Two gates remain open: the **authenticated Electron desktop staging smoke**
(never claimed — now the last functional gate) and the pre-existing `.test.js` packaging issue.
Production is untouched.

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
| Renderer surface | `electron/preload.ts`, `src/lib/api.ts` | `window.wavi.multiplayer.*` + types |
| UI (added in P3-4, §12) | `src/components/CollaboratorsPanel.tsx`, `src/lib/collaborationView.ts` | Collaborators / activity / contributions / lineage, over a pure tested view-model |

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

---

## 17. LANDED in development integration (2026-08-08)

`feat/multiplayer-v1-ui-assistant @ eb591e21` → `feature/ableton-daw-companion`
via `--no-ff` merge **`f0c7bb74`**. Base `8b5129b0`; merge-base *was* integration HEAD, so the
merge was conflict-free by construction. 24 files, no unrelated files.

### The four contract corrections survived the merge (re-verified post-merge)

| Fix | Post-merge state | Cross-checked against `wavio@d95683f` |
|---|---|---|
| respond-invite | sends `response: 'accept' \| 'decline'`; no `accept` on the wire | server reads `text(body.response)` |
| respond-contribution | sends `response: 'accept' \| 'reject'`; **no** `reviewerNote` | server reads `text(body.response)`; no note field exists |
| revoke-collaborator | sends **both** `projectId` and `membershipId` | server reads both and 400s without either |
| contribution permission | `view` can never contribute; `comment` only with explicit `canContribute`; `owner` contributes by ownership | server: `can_contribute = role === 'comment' && body.canContribute === true`, and publish allows `access.owner \|\| membership.can_contribute` |

These are repairs, not preferences: without them every invite response, contribution review and
collaborator revoke would have returned 400, and a `view` invite would have carried a silently
weaker permission than the UI implied.

### Invariants re-verified post-merge

- **Networking** — zero `fetch(`/header/credential code in `multiplayerService.ts`; exactly one
  `DESKTOP_ENDPOINT`; all nine actions use the injected transport.
- **Privacy** — runtime test proves no canonical DID, bearer token, raw `invt_…`, absolute path or
  raw server error in any model-visible result. The only occurrences of `invt_` in renderer/model
  source are doc comments forbidding it.
- **Identity** — one neutral `resolved:false` message, present exactly twice (main + view-model) and
  nowhere else; 429 normalized to its own reason; `pinvite_…` refs scoped by
  account/project/epoch/expiry and spent on success.
- **Lineage** — server-authoritative; **no** local schema migration (`electron/db.ts` untouched by
  this merge). Contribution language never implies overwriting a parent.
- **Manifest** — still exactly one `buildPublishManifestBody`; `sourceRestoreId` present only as the
  field being stripped.
- **Assistant** — `BLOCKED_CAPABILITIES` empty; no multiplayer tool returns
  `server_contract_pending`. (The `BlockedReason` type and its message are retained as machinery for
  a future block, and are still tested.)
- **Project Link** — no regression; PL and assistant-PL suites green.

### Post-merge gate

**874/874 tests · 48 files · 0 skips.** `tsc --noEmit` clean for both projects ·
`git diff --check` clean · production build OK · unsigned packaged `Wavi Studio.app` built ·
secret and absolute-path scans clean.

## 18. `P3-4-CL` — CLOSED (see §19). Original statement retained for history.

**Landing this feature did not close it.** There is still no `list-project-contributions` action.

What the desktop deliberately does **not** do:
- it does not fabricate a contribution-review queue;
- it does not derive canonical contribution ids from the activity feed (the safe projection drops
  subject ids on purpose);
- it does not persist an invented local contribution list;
- it does not present session-local contribution state as complete project history.

What it does: shows only contributions known to this session, and **says so in the UI**.

**Consequence:** a project owner still cannot see a durable queue of pending contributions awaiting
review. That is a feature-completeness and release gate — not a development-integration blocker.

Proposed additive contract and acceptance criteria:
`docs/handoffs/DESKTOP-TO-CODEX-P3-4-CL-contribution-listing.md`.

---

## 19. `P3-4-CL` CLOSED — authoritative contribution queue (branch `feat/contribution-queue-desktop`)

Base `feature/ableton-daw-companion @ bb6ae0eb`.
Server contract consumed: **`wavio @ 6236c3901966e88bb9a05bef79253463bffa6abd`**
(deployment `dpl_3LaE73wZTRZJxFGS1FA25TqQaASx`, staging URL
`https://wavi-staging-kvbq16xd5-rgdevas-projects.vercel.app`, 60 live checks PASS reported by Codex).

### Adapter
`list-project-contributions` was added to the **existing** service — same injected `/api/desktop`
transport, same `listAll` pagination helper, same `parseContribution`, same `pcontrib_…` registry.
No second HTTP implementation and no new mapper. `state` is **omitted** when unfiltered (the handler
400s on any present-but-unrecognised value) and validated locally against the server's own
`CONTRIBUTION_STATES` before the request.

### Fail-closed state parsing (hardened here)
The handler derives the four booleans from ONE `state` column, so exactly one is always true.
`parseContribution` now **rejects** any item where the count of true flags is not exactly 1, and a
malformed row fails the whole listing. Previously it coerced by precedence — which in a review queue
would have meant silently rendering an "unknown" item or omitting a real one. A shortened review
queue is a worse failure than a visible error.

### Contributor identity — intentionally absent
The locked item carries **no** contributor DID, email, handle, display name, avatar, or membership
id. The desktop therefore shows contributions **without a contributor name**, and does not:
- display any raw account identifier;
- guess a name from anything;
- heuristically join contributions to activity events by timestamp, order, note, or version.

No new blocker was filed for this — per the task, `P3-4-CL` is sufficient for the durable queue.

### Visibility
Server-decided: the owner sees every contribution; a non-owner sees only their own
(`contributor_account_id = caller`). The desktop **never re-filters or widens** this. Because of
that rule, "viewer is not the owner" is sufficient to render **Withdraw** on a row they can see —
no contributor identity is inferred, and the server re-checks on the mutation regardless.

### Queue UI
Project Detail → Versions → Contributions now loads the authoritative listing, with filters
(**Awaiting review** first, then Accepted / Rejected / Withdrawn / All), `Load more`, and real
loading / empty / offline / auth-required / forbidden / error states. Empty copy distinguishes an
owner with a clear queue from a contributor who has submitted nothing. The session-only wording is
**gone**. Review controls act on listed rows; nothing is applied optimistically; every mutation
re-reads the listing, and a 409 reconciles.

### Two more prompt-vs-handler divergences caught by reading the source
| Written spec said | Handler actually does | Followed |
|---|---|---|
| `"revision": 1` (number) | `revision: row.updated_at` — a timestamp **string** | handler |
| item shape implied a contributor could be shown | no identity field exists at all | handler |

### Verification
- **912/912 tests · 49 files · 0 skips** (baseline `bb6ae0eb` was 874 → **+38**). No test weakened;
  one assertion was **tightened** (absent contribution state now asserts rejection rather than
  coercion).
- New suite `electron/multiplayerContributionQueue.test.ts` is **handler-pinned**: it records the
  consumed server SHA and asserts request field names and response shape against the shipped
  handler, not against desktop assumptions.
- `tsc --noEmit` clean ×2 · `git diff --check` clean · production build OK · unsigned packaged
  `Wavi Studio.app` built · secret and absolute-path scans clean.
- **Staging contract check** against `dpl_3LaE73wZTRZJxFGS1FA25TqQaASx`: all **ten** actions —
  including `list-project-contributions` — return `401 {"error":"Unauthorized"}`, while an
  unregistered action returns `400 {"error":"Unknown or missing X-Desktop-Action"}`. Endpoint
  resolves to exactly `/api/desktop`.
- **Authenticated Electron desktop smoke remains PENDING** — interactive Privy login is required to
  mint a desktop token; no authenticated pass is performed or claimed.

### Correction to the previous report
An earlier probe in this session concluded `list-project-contributions` was "not deployed anywhere".
That probe targeted the two **older** staging deployments; the action is present and auth-gated on
`dpl_3LaE73wZTRZJxFGS1FA25TqQaASx`. The contract was fine — the target URL was stale.

## 20. Status after P3-4-CL

| Gate | State |
|---|---|
| Multiplayer v1 adapter / UI / assistant | landed in integration |
| `P3-4-ID` identity resolution | closed |
| `P3-4-CL` contribution queue | **closed at source level** (this branch, unmerged) |
| Authenticated Electron staging smoke | **PENDING** — the last functional gate |
| Compiled `.test.js` in `app.asar` | open, separate packaging task |
| Production release | blocked |
