# DESKTOP → CODEX · `P3-4-ID` Collaborator identity resolution

Status: **OPEN BLOCKER — server-owned. Desktop cannot resolve this alone.**
Date: 2026-08-08 · From: `wavio-studio` @ `feature/ableton-daw-companion` `64ea4230`
Server contract in force: `wavio @ 6a4a9e8050902cd9f16cd3d4e067ef56eb6ca584`
(`feat/multiplayer-v1-server-contracts`, `api/desktop/multiplayer.ts`)

The Multiplayer v1 desktop adapter is **landed and green**. This document requests the **one
additive contract** that the collaborator-invite feature is waiting on. Nothing here asks for a
breaking change, and nothing here is blocking the parts of Multiplayer v1 that already work.

---

## 1. What is blocked

| Blocked | Not blocked (landed, working) |
|---|---|
| Collaborator **invite UI** | Listing collaborators |
| `invite_collaborator` **assistant tool** | Responding to invites *received* (accept / decline) |
| | Self-leave and revoke |
| | Project activity feed |
| | Contribution submit / review / withdraw |

Everything that does **not** require knowing a stranger's identity already works.

## 2. Why it is blocked

Four facts hold simultaneously, and together they leave no legitimate path:

1. `invite-project-collaborator` requires `inviteeAccountId` — a **canonical Privy DID**.
2. Email invitation is **explicitly rejected**: 400 *"Email invitations are not supported by this
   contract"*.
3. The contract has **no account discovery / lookup / handle-resolution action**.
4. The desktop's privacy boundary forbids canonical DIDs in renderer state, UI, or model surfaces.

So: the user knows an email or a handle; the server accepts only a DID; there is no way to convert
one to the other; and even if there were, the DID could not be shown, typed, or stored.

## 3. Workarounds the desktop has explicitly refused

These are recorded so nobody re-proposes them later:

- prompting the user to paste a Privy DID
- displaying DIDs anywhere in the UI
- caching DIDs in renderer state
- sending an email address to the existing invite action (contract-rejected)
- querying Privy directly from the renderer
- inventing local user discovery
- relaxing the privacy boundary "just for invites"

The adapter instead validates the shape of an explicitly-supplied account id and rejects an email
locally, quoting the contract's own reason. It fabricates nothing.

## 4. Requested contract — additive

### 4.1 New action

```
POST /api/desktop
X-Desktop-Action: resolve-invite-target
Authorization: Bearer <desktop token>

request:  { projectId: string, identifier: string }   // identifier = email or @handle, user-typed

200 { accountId,                       // the CALLER's own DID, as every action already returns
      resolved: true,
      inviteTarget: "invt_…",          // opaque · server-minted · project-scoped · short-TTL
      display: { displayName, avatarUrl } }   // display-only; safe to render

200 { accountId, resolved: false }     // no match — MUST be indistinguishable from "no account"
403                                    // caller is not the project owner
429                                    // rate-limited
```

### 4.2 Additive extension to the existing invite action

```
invite-project-collaborator
  accepts EITHER inviteeAccountId   (unchanged — existing/server-internal callers)
              OR inviteTarget       (new — the desktop path)
```

No change to the response envelope, the `alreadyInvited` echo, or any status code.

### 4.3 Required properties

| Property | Requirement |
|---|---|
| Opacity | `inviteTarget` must **not encode or reverse to** the DID |
| Scope | Valid for **one project** only |
| Lifetime | Short TTL, so a leaked reference has minimal blast radius |
| Non-enumerable | `resolved: false` must be **indistinguishable** from "account exists but declined to be discoverable", and rate-limited — this action must not become a Wavi-account enumeration oracle |
| Projection | Return **only** `displayName` / `avatarUrl`; never the canonical identity |

## 5. What the desktop will do once this ships

No boundary change is needed. The user types an email or handle → the **main process** calls
`resolve-invite-target` → the renderer receives only `invt_…` plus display fields → invite is sent
with `inviteTarget`. The canonical DID never leaves the server.

The desktop already has the adapter, the opaque-ref registry (`pmember_…`), the privacy projections,
and the failure vocabulary in place. Unblocking is expected to be a small, bounded change.

## 6. Acceptance the desktop will require before unblocking

1. The action exists on a **staging-validated** deployment (SHA + deployment id supplied).
2. An unauthenticated probe returns 401 (consistent with the other 8 actions).
3. `resolved: false` and "account exists" are provably indistinguishable to the caller.
4. Rate limiting is demonstrable.
5. `inviteTarget` is confirmed opaque and project-scoped with a stated TTL.

Only then will the desktop build the invite UI and unblock `invite_collaborator`.

## 7. Reference

Full statement and rejected-workaround table: §11 of
`docs/WAVI_MULTIPLAYER_V1_DESKTOP_AUDIT.md`.
Adapter as landed: `electron/multiplayerService.ts`, `electron/multiplayerRefs.ts`.
