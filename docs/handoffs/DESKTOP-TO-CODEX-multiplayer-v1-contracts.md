# Desktop → Codex — Multiplayer v1 contract packet (P3-4)

**From:** Wavi Studio (desktop lane) · **To:** Codex (web/backend lane)
**Date:** 2026-08-08 · **Status:** contract REQUEST — desktop-authored, web-implemented
**Desktop base:** `feature/ableton-daw-companion` @ `baae3454`
**SPEC ONLY.** This branch changes **zero runtime files**. Nothing in `wavio-studio` calls
any action below; the three multiplayer assistant tools remain `server_contract_pending`.

> ⚠️ **Legend used throughout — read this first.**
> - **[COMMITTED]** — already implemented and staging-validated. Binding on both sides.
> - **[DESKTOP-ASSUMPTION]** — exists only in desktop code/local SQLite today. NOT a server contract.
> - **[PROPOSED]** — desktop's request. **Names and shapes are PENDING** until Codex confirms.
> - **[DECISION]** — genuinely open; Codex must choose. Desktop will wire whichever is locked.

---

## 0. Product boundary (binding)

Multiplayer v1 is **checkpoint-based collaboration**. It is explicitly **NOT**: simultaneous
DAW-state synchronization, realtime cross-DAW editing, live plugin-state replication, shared
low-latency audio transport, a CRDT over the DAW session, or a second proprietary Wavi
musical-session format.

**DR-015 remains binding.** The portable project model is unchanged by everything below:
native DAW project where available · `project.dawproject` · `wavi/session.json` ·
`wavi/fidelity.json` · stems · MIDI · renders · dependencies · hashes.

Multiplayer v1 delivers: collaborator membership · roles/permissions · invite lifecycle ·
collaborator activity · contribution (child-version) submission · immutable version lineage ·
review/accept semantics · comments only where contract-adjacent · presence only if lightweight
and separable (deferred here).

---

## 1. Audit of existing server-adjacent assumptions

Performed against the desktop tree at `baae3454` before any shape was proposed, so the packet
reuses existing terminology rather than inventing a parallel vocabulary.

### 1.1 [COMMITTED] — the locked, staging-validated surface
Server SHA `d34d5218` (smoke `a561dee6`, deployment `dpl_E2HFE5xsYS7tTKwy23pJBHMxAeYC`,
isolated Supabase `qjhzrxgiomctzxdzywhu`).

| Element | Committed form |
|---|---|
| Transport | `POST {API_BASE}/desktop` + `X-Desktop-Action`, `Authorization: Bearer <desktop token>` |
| Identity | canonical **Privy DID**, resolved server-side (`validateDesktopToken().userId` → `verifyPrivyToken`); echoed as top-level `accountId` on every 200 |
| Actions | `list-project-links`, `create-project-link`, `revoke-project-link` |
| Pagination | `pageInfo { limit, hasMore, nextCursor, order:"updatedAtDesc,idDesc", scope:"owner" }`, cursor opaque, DEFAULT 50 / MAX 100 |
| State encoding | **booleans** `state { active, revoked, expired }` — no status enum |
| Change marker | `revision` (= `updatedAt`) |
| Permissions | `permissions { allowDownload, collaboratorMode, previewEnabled, requiresPassword }` |
| Roles today | `collaboratorMode ∈ {view, comment}` — **`edit` is rejected 400** |
| Idempotency | revoke idempotent (`alreadyRevoked: true`); create **non-idempotent** |
| Errors | HTTP status + `{ "error": string }` |
| Ownership | enforced server-side (`created_by` / `projects.user_id`); 404 for not-owned |

### 1.2 [COMMITTED] — `publish-project-version` (already carries lineage)
The desktop **already sends `parentVersionId`** on every publish
(`electron/main.ts`, from `projects.cloud_version_id`), alongside:
`projectId` (cloud), `daw`, `bpm`, `sha256`, `fileSize`, `deviceLabel`, `versionNotes`,
`files[]` (relativePath, fileName, fileSize, sha256, role, mimeType, assetId), and the
`preview*` fields. **This is the single most important input to §6** — a parent-linked publish
pipeline exists and is proven.

### 1.3 [DESKTOP-ASSUMPTION] — local-only structures (no server contract)
| Structure | Reality |
|---|---|
| `restored_projects` (SQLite) | `id`, `source_project_id`, `source_version_id`, `share_id`, `owner_user_id`, `local_checkout_id`, `collaborator_permission`, `parent_version_id`, path/name/daw/counts/hash | **`restored_projects.id` is a LOCAL desktop row id.** The "`sourceRestoreId`" discussed in earlier packets is **this local id** — the server has never seen it. It is only useful as a **client correlation token**, not as a server identifier. Requesting it as if the server knew it would be wrong. |
| `restored_projects.owner_user_id` | the **sharer's** DID, learned from `resolve-project-link` — not the caller's |
| `versions` (SQLite) | `id, project_id, file_path, file_size, checksum, cloud_url, created_at` — **no `parent_version_id`, no author column**. Local lineage is thin; the server must be authoritative (§8). |
| `activity_log` (SQLite) | `type, message, project_id, file_id, metadata, created_at` — **local audit only**, not a server feed and not a substitute for §4 |
| `CloudProjectSnapshot.collaborators: string[]` | an unstructured placeholder from `/api/assistant/context`; **not** a membership contract. Do not build on it. |
| Comments | **none anywhere** in desktop code — no table, no IPC, no UI (§5) |

### 1.4 Terminology reconciliation (use these, not synonyms)
`accountId` (Privy DID) · `projectId` (cloud project id) · `versionId` (immutable published
version) · `parentVersionId` · `trackingId` (public Project Link id) · `collaboratorMode`
(`view|comment`) · `pageInfo`/`nextCursor`/`revision` · `state{…}` booleans.
Do **not** introduce `userId`, `status` enums, `page`/`offset`, or a second id for a concept
that already has one.

---

## 2. Contract design principles (binding on every action below)

Server-authoritative state · authenticated Privy DID as canonical identity · **DID never
model-visible** and never required from the client · owner/project scope enforced **server-side**
· deterministic cursor pagination with a completeness signal · immutable version history · no
fabricated client success · explicit typed state · documented idempotency · honest offline ·
stale account/session responses discarded · no cross-account cache auto-attribution · mutations
fail closed. HTTP status + `{error:string}` stays acceptable; stable machine codes only if Codex
wants them.

**Prefer extending the existing `/api/desktop` action router.** Do not create standalone
endpoints without cause.

---

## 3. Membership contract  [PROPOSED]

### 3.1 Action set (minimal coherent set)
```
X-Desktop-Action: list-project-collaborators
                | invite-project-collaborator
                | revoke-project-collaborator
                | respond-project-invite      // recipient-side accept/decline
```

### 3.2 `list-project-collaborators`
Request: `{ projectId, cursor?, limit? }`
Response — **mirrors the committed `pageInfo`/`state` style exactly**:
```jsonc
{
  "accountId": "did:privy:…",            // caller
  "items": [{
    "membershipId": "string",            // opaque SERVER id — desktop's handle for all mutations
    "projectId": "string",
    "role": "owner" | "view" | "comment", // §3.4
    "state": { "active": false, "pending": true, "declined": false,
               "revoked": false, "expired": false },
    "actor": { "displayName": "string|null", "avatarUrl": "string|null" }, // §10 safe projection
    "createdAt": "ISO-8601",
    "updatedAt": "ISO-8601",
    "acceptedAt": "ISO-8601|null",
    "expiresAt":  "ISO-8601|null",
    "revision": "ISO-8601|number"
  }],
  "pageInfo": { "limit": 50, "hasMore": false, "nextCursor": null,
                "order": "updatedAtDesc,idDesc", "scope": "project" }
}
```
- Scope: owners see all memberships; a non-owner member sees **at most** what product allows
  (**[DECISION 3a]** — desktop suggests: members see the roster without invite metadata).
- **Email must NOT be returned** unless a product requirement forces it (§10). `displayName` is enough.
- Deterministic ordering + opaque cursor so the desktop's accumulate-until-`hasMore:false`
  reconciliation is sound.

### 3.3 `invite-project-collaborator`
Request: `{ projectId, role, inviteeAccountId? | inviteeEmail?, expiresAt?, operationKey? }`
- **Exactly one** invitee identifier. Desktop prefers `inviteeAccountId`;
  **[DECISION 3b]** if email is the only viable mechanism, the desktop will keep the address
  main-process-only and never expose it to the model or persist it in the assistant path.
- Response: `{ accountId, invited: true, item: <membership> }`.
- **Duplicate pending invite** → **[DECISION 3c]** desktop requests idempotent behavior:
  `{ alreadyInvited: true, item }` (200), not a 409 — mirrors `alreadyRevoked`.
- **Already an active member** → `409` (or `{ alreadyMember: true, item }`; Codex's call — **[DECISION 3d]**).
- Only an **owner** may invite.
- Expiry: **[DECISION 3e]** does an invite expire by default? Desktop suggests a server-side
  default TTL with `expiresAt` always returned so the UI can be honest.

### 3.4 Roles for v1 — reconcile with the committed vocabulary
Keep the committed `view` / `comment` vocabulary and add `owner`:

| Role | View/listen | Download | Comment | Contribute |
|---|---|---|---|---|
| `owner` | ✅ | ✅ | ✅ | ✅ |
| `comment` | ✅ | per link permission | ✅ | **[DECISION 3f]** |
| `view` | ✅ | per link permission | ❌ | ❌ |

**[DECISION 3f] — contribution permission. This is the key role question.** Three options;
**do not silently overload `edit`** (it is a rejected value today):
- **(i) capability on membership** — `canContribute: boolean` attached to a `comment` membership.
  *Desktop's recommendation:* smallest change, no new role, no fork of the link vocabulary, and
  it composes with the existing `collaboratorMode`.
- **(ii) a new `contribute` role** — clearer to reason about, but adds a third tier that
  `create-project-link` would eventually need to mirror.
- **(iii) separate contribution authorization** — decoupled grant per contribution; most
  flexible, most machinery.

### 3.5 `respond-project-invite` (recipient side)
Request: `{ membershipId, response: "accept" | "decline" }`
- Only the **invitee** may respond; any other caller → `403` (this is the "B cannot accept A's
  invite" acceptance case in §15).
- Expired invite → `410`/`409` (**[DECISION 3g]**, desktop just needs it distinguishable).
- Idempotent: accepting twice → `{ alreadyAccepted: true, item }`.

### 3.6 `revoke-project-collaborator`
Request: `{ projectId, membershipId }`
- Owner removes an active collaborator **or** revokes a pending invite — same action, state
  decides. Idempotent → `{ alreadyRevoked: true, item }`.
- **[DECISION 3h]** may a collaborator remove **themselves** (leave)? Desktop suggests yes, via
  the same action when `membershipId` belongs to the caller.
- Revoking the **last owner** must be rejected, never orphaning the project.

---

## 4. Collaborator activity contract  [PROPOSED]

Action: `list-project-activity`
Request: `{ projectId, versionId?, cursor?, limit?, types?[] }` (`types` only if cheap).

Response — same page contract as §3/Project Links:
```jsonc
{
  "accountId": "did:privy:…",
  "items": [{
    "activityId": "string",
    "projectId": "string",
    "type": "collaborator_invited" | "collaborator_joined" | "collaborator_removed"
          | "project_link_created" | "project_link_revoked"
          | "version_published" | "contribution_submitted"
          | "contribution_accepted" | "contribution_rejected"
          | "comment_created" | "comment_resolved",
    "actor": { "displayName": "string|null", "avatarUrl": "string|null" },  // NO DID
    "subject": { "versionId": null, "contributionId": null,
                 "membershipId": null, "trackingId": null, "commentId": null },
    "occurredAt": "ISO-8601",
    "revision": "ISO-8601|number"
  }],
  "pageInfo": { "limit": 50, "hasMore": false, "nextCursor": null,
                "order": "occurredAtDesc,idDesc", "scope": "project" }
}
```
Requirements: **read-only** (the assistant tool will be ungated) · **server-side permission
filtering** (a viewer must not receive events they may not read; the desktop will not fake
authority) · a **closed, stable `type` enum** — the desktop renders its own copy and must never
parse prose for semantics · malformed cursor → `400` · **no DID, tokens, storage paths or raw DB
state** in any payload.

---

## 5. Comments boundary

**Audit result: there is no comments implementation anywhere in the desktop** (no table, no IPC,
no UI) and no committed server comments contract known to this lane.

Therefore: **comments are NOT a blocker for membership or contribution.** Desktop requests only
the minimum, and only if Codex is already building comments:
- attach to `projectId`, optional `versionId`, optional `timestampSeconds` (audio-timestamped);
- actions `list-project-comments` / `create-project-comment` / `resolve-project-comment` with the
  same `pageInfo` + safe `actor` projection;
- `comment_created` / `comment_resolved` appear in §4 regardless of who stores them.

If a comments system already exists elsewhere in `wavio`, **reference it and ignore this section** —
do not build a second one. Otherwise treat comments as **separate Codex scope**, sequenced after
membership + contribution.

---

## 6. Child-version contribution contract  [DECISION — most important section]

### 6.1 Recommendation: **Option A — extend `publish-project-version`**
Based on current code, not prior discussion:

- `publish-project-version` **already accepts `parentVersionId`** and already carries the full
  transactional manifest, hashes, preview selection and DAW metadata (§1.2). A contribution *is*
  a parent-linked publish; Option B would duplicate that entire pipeline and its manifest format.
- The desktop has exactly one publish path today. Two paths would mean two manifest builders and
  two failure vocabularies to keep aligned — the precise problem the Project Link consolidation
  just removed.
- Authorization is the one real argument for Option B, and it is satisfiable inside Option A by
  branching on an explicit flag (below) rather than by inferring intent.

**Proposed Option A shape:**
```jsonc
// X-Desktop-Action: publish-project-version   (existing action, additive fields)
{
  "projectId": "…", "parentVersionId": "…",     // both already sent today
  "contribution": true,                          // NEW — explicit, never inferred
  "contributorNote": "string|null",              // NEW — maps to existing versionNotes if preferred
  "clientCorrelationId": "string|null",          // NEW — see 6.2; NOT the old "sourceRestoreId"
  "operationKey": "string|null",                 // NEW — idempotency (§11)
  "fidelity": { /* optional, DR-015 fidelity summary */ },
  "…": "all existing publish fields unchanged (files[], sha256, preview*, daw, bpm, deviceLabel)"
}
```
Response (additive; a normal publish is unchanged):
```jsonc
{ "accountId": "did:privy:…", "published": true,
  "contribution": { "contributionId": "…", "projectId": "…",
                    "parentVersionId": "…", "childVersionId": "…",
                    "state": { "submitted": true, "accepted": false,
                               "rejected": false, "withdrawn": false },
                    "createdAt": "ISO-8601", "revision": "ISO-8601|number" } }
```
**If Codex prefers Option B** (`submit-project-contribution`), the desktop will wire it — please
then keep the request/response field names above so the adapter is a rename, not a redesign.

### 6.2 Correcting `sourceRestoreId`
`restored_projects.id` is a **local desktop id the server has never seen** (§1.3). Desktop
therefore does **not** request `sourceRestoreId` as a server field. If correlation is useful,
the desktop will send it as an opaque `clientCorrelationId` the server may store and echo but
must never treat as authoritative. **[DECISION 6a]** — want it, or drop it?

### 6.3 Invariants the desktop requires (BINDING, release-gate assertions)
1. **The parent version is immutable** — a contribution never mutates, replaces, or deletes it.
2. The child records `parentVersionId` and attaches to the **same project**; no unrelated project.
3. Permission enforced **server-side** per §3.4/**[3f]**; unauthorized → `403`.
4. Contributor identity recorded server-side (DID), surfaced to clients only as safe projection.
5. Submission is **non-idempotent** unless `operationKey` is honoured (§11).
6. **Restoring an old version creates a NEW descendant** — it never rewrites history.

---

## 7. Contribution lifecycle

States (only those with concrete meaning): `submitted → accepted | rejected | withdrawn`.

| Action | Who |
|---|---|
| submit | member with contribution permission (§3f) |
| inspect | owner + the contributor (own submissions) |
| accept / reject | **owner only** |
| withdraw | **contributor only**, and only while `submitted` |

**Accept semantics — desktop strongly prefers (B): record an accepted child and retain immutable
history.** If a "current version" pointer is also required for the web UI, please make it a
**separate, explicit, additive** field (e.g. `project.currentVersionId`) that the desktop can
read — never an implicit mutation of version rows. **[DECISION 7a]**

Rejected/stale contributions must be incapable of mutating history afterwards.

---

## 8. Version lineage

The **server is authoritative; the desktop caches**. Desktop will not build a competing lineage
database — today `versions` has no parent/author columns (§1.3) and the desktop will add only
nullable, additive cache columns.

Minimum per version, ideally on the existing version listing:
`versionId` · `parentVersionId` · `projectId` · `createdAt` · safe `actor` (display projection,
no DID) · `contributionId?` · `contributionState?` · `revision`.

**[DECISION 8a]** — is there (or will there be) a `list-project-versions` desktop action? Without
one the desktop cannot reconstruct the graph authoritatively and will keep showing local-only
version data.

---

## 9. Permission matrix  [PROPOSED — not enforced until Codex implements]

Marked ❓ where Codex/product must confirm. **Nothing here is claimed as enforced today.**

| Action | owner | comment | view | contributor (if 3f-ii) |
|---|---|---|---|---|
| view project | ✅ | ✅ | ✅ | ✅ |
| listen | ✅ | ✅ | ✅ | ✅ |
| download | ✅ | per link `allowDownload` | per link `allowDownload` | per link |
| comment | ✅ | ✅ | ❌ | ✅ |
| list collaborators | ✅ | ❓ roster only (3a) | ❓ roster only (3a) | ❓ |
| invite collaborator | ✅ | ❌ | ❌ | ❌ |
| remove collaborator | ✅ | ❌ (self-leave? 3h) | ❌ (self-leave? 3h) | ❌ |
| inspect activity | ✅ | ✅ filtered | ✅ filtered | ✅ filtered |
| submit child version | ✅ | ❓ **[3f]** | ❌ | ✅ |
| accept contribution | ✅ | ❌ | ❌ | ❌ |
| reject contribution | ✅ | ❌ | ❌ | ❌ |
| create Project Link | ✅ | ❓ | ❌ | ❓ |
| revoke Project Link | ✅ (owner-scoped today) | ❌ | ❌ | ❌ |

---

## 10. Account + privacy boundary (binding)

Canonical identity is `did:privy:…`, but:
- the **DID stays server-side / main-process only** — it is never sent to the renderer and never
  reaches model-visible assistant context (the desktop already projects it to an opaque
  `acct_…` handle);
- collaborator and activity references must be **opaque server ids** (`membershipId`,
  `activityId`, `contributionId`) — the desktop will additionally mint session-scoped
  `pmember_…` / `pact_…` handles for the assistant, exactly as it does `plink_…` for links;
- **actor identity in payloads must be a safe display projection** (`displayName`, `avatarUrl`) —
  never a DID, never an email;
- email returned **only** if §3b forces it, and then main-process-only.

**Fail-closed behavior (desktop side, all already implemented for links):** logout · account
switch · stale response (session-epoch mismatch) · revoked membership · expired invitation ·
foreign project · foreign contribution → **all fail closed**, nothing persisted, no
auto-attribution across accounts.

---

## 11. Idempotency matrix

| Mutation | Requested semantics |
|---|---|
| invite | **idempotent for a duplicate pending invite** → `alreadyInvited` (**[3c]**); otherwise non-idempotent |
| invite accept | idempotent → `alreadyAccepted` |
| invite decline | idempotent → `alreadyDeclined` |
| collaborator revoke | **idempotent** → `alreadyRevoked` (mirrors revoke-project-link) |
| contribution submit | **NON-idempotent**, unless `operationKey` is honoured → then idempotent per key |
| contribution accept | idempotent → `alreadyAccepted` |
| contribution reject | idempotent → `alreadyRejected` |

**Desktop guarantee:** a non-idempotent mutation whose outcome is ambiguous (thrown/aborted
request) is **never automatically retried**. It surfaces as `…-outcome-unknown` and recovery is
the authoritative listing — exactly as `create_project_link` behaves today. Honouring
`operationKey` removes this ambiguity entirely and is the single highest-value nicety Codex can
add.

---

## 12. Error contract

Keep HTTP status + `{ "error": string }` (the committed style). Requested mapping:

| Condition | Status |
|---|---|
| malformed request / unknown role / bad cursor | `400` |
| unauthenticated | `401` |
| unauthorized (not member / not owner) | `403` |
| project / membership / invite / contribution not found or not visible | `404` |
| invite expired | `410` (or `409` — just make it distinguishable, **[3g]**) |
| already member / duplicate / parent superseded / stale contribution state | `409` |
| server failure | `5xx` |

**Desktop normalization:** these map into a fixed assistant-safe vocabulary
(`authentication_required`, `not_owned`, `not_found`, `conflict`, `rejected`, `retryable`,
`offline`, `malformed_response`, `stale_session`, …). Raw server strings are **never** surfaced
to the model. Stable machine codes are optional — only add them if Codex wants them.

---

## 13. Assistant tool mapping (design only — NOT implemented in this task)

| Tool | Server action(s) | Confirmation | Safe model-visible result |
|---|---|---|---|
| `invite_collaborator` | `invite-project-collaborator` | **GATED** (out-of-band card names invitee display + role + project) | `pmember_…` ref, role, invite state, expiry — no DID, no email |
| `inspect_collaborator_activity` | `list-project-activity` | **none** (read-only) | `pact_…` refs, closed-enum `type`, `displayName` actor, timestamps, `pageComplete` honesty |
| `publish_child_version` | Option A `publish-project-version` (`contribution:true`) or Option B | **GATED** (card names project + parent version + note) | `pcontrib_…` ref, parent/child version ids, lifecycle state; ambiguous → `contribution-outcome-unknown`, **no auto-retry**, recovery = listing |

All three keep the existing envelope invariants: model-emitted confirmation ignored; only the
renderer's card sets `confirmedOutOfBand`; explicit project context required; stale
project/session discarded; no DID/token/path in results.

---

## 14. Codex implementation checklist

### Contract-required (desktop is blocked without these)
1. `list-project-collaborators` — cursor-paged, `pageInfo` + `state` booleans, safe `actor`, opaque `membershipId`.
2. `invite-project-collaborator` — role from the committed vocabulary; duplicate-pending semantics (**[3c]**); `expiresAt`.
3. `respond-project-invite` — invitee-only accept/decline; expired distinguishable.
4. `revoke-project-collaborator` — owner remove + pending-invite revoke; idempotent; last-owner protected.
5. **[3f] decision** on contribution permission.
6. `list-project-activity` — closed `type` enum, permission-filtered, safe actor, cursor-paged.
7. **[§6 decision]** Option A vs B, plus the contribution response object.
8. Contribution lifecycle + accept/reject actions with **parent immutability guaranteed**.
9. Server-side permission enforcement for every action (never client-asserted).
10. Isolated-staging deployment + authenticated smoke (§15), matching the Project Links pattern.

### Nice-to-have (desktop degrades honestly without them)
`operationKey` idempotency for contribution submit (removes ambiguity) · `list-project-versions`
for authoritative lineage (**[8a]**) · `sinceRevision` deltas on activity · comments (§5) ·
`project.currentVersionId` pointer (**[7a]**) · stable machine error codes.

### Explicitly EXCLUDED from this packet
Realtime co-editing · DAW transport sync · plugin-state sync · presence sockets (unless separately
approved) · cross-DAW automatic perfect conversion · recipient import/package implementation
unless the chosen contribution contract requires it · any second musical-session format (DR-015).

---

## 15. Acceptance matrix (Codex must pass before desktop wiring)

**Membership** — owner invites A · A can see and accept the invite · **B cannot accept A's
invite** (`403`) · expired invite rejected and distinguishable · duplicate-invite semantics match
**[3c]** · owner revokes collaborator (and again → `alreadyRevoked`) · **foreign account cannot
revoke** · last-owner revoke rejected.

**Activity** — only authorized users can list · deterministic pagination across ≥2 pages with a
stable cursor · **no foreign-project events** · safe actor projection (no DID/email) · malformed
cursor → `400`.

**Contribution** — collaborator submits a child from a valid parent · **foreign account cannot
submit** (`403`) · view-only member cannot submit when contribution permission is required ·
**original parent byte-identical and unmodified after submission** · child references the parent ·
owner accepts · **repeated accept has defined behavior** · stale/rejected contribution cannot
mutate history · **restore creates a new descendant rather than rewriting the parent**.

**Privacy** — no DID · no Bearer token · no storage path · no raw stack trace · no unrelated
account data in any response body.

---

## 16. Appendix — remaining manual desktop→staging Project Link smoke (documentation only)

Unrelated to multiplayer; recorded here so the open gate is not lost. **NOT claimed as passed.**

Launch a development desktop build against `https://wavi-staging.vercel.app/api`
(`WAVI_API_BASE_URL`; production defaults untouched), sign in with a **synthetic staging**
identity, then manually prove: signed-in **list** · **create** · **reconciliation** · **revoke** ·
**revoked refresh** · **logout/account cache clearing**. Automated coverage already proves the
unauthenticated leg (endpoint resolves to `/api/desktop`; `401` and `400` match the locked
handler). The authenticated leg needs interactive Privy sign-in and cannot be automated headlessly.

---

## 17. Status ladder

- Desktop contract request authored: ✅ (this document)
- Codex contract implemented + locked: ⏳ pending
- Desktop pure adapter (P3-4a): ⛔ blocked on the above
- Desktop service/IPC/SQLite (P3-4b): ⛔
- Assistant tools unblocked (P3-4c): ⛔ — the three tools remain `server_contract_pending`
- Isolated authenticated staging smoke: ⛔
- Production: ⛔ separate gate, out of scope

**Unrelated open gates:** interactive desktop→staging Project Link sign-in smoke (§16); Ableton
live P0 gates (same-DAW restore round trip, no "Temp Project", revocation denial, child-version
return, original-version immutability).
