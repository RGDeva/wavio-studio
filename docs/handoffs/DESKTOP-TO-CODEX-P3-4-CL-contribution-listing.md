# DESKTOP → CODEX · `P3-4-CL` Contribution listing

Status: **OPEN GAP — server-owned. Non-blocking, but it caps the owner review experience.**
Date: 2026-08-08 · From: `wavio-studio` @ `feat/multiplayer-v1-ui-assistant`
Server contract in force: Multiplayer v1 `wavio@6a4a9e8` + P3-4-ID `wavio@d95683f`

Thank you for `resolve-invite-target` — `P3-4-ID` is closed and the full collaboration workflow
now ships on the desktop. This is the one remaining gap found while building it.

---

## 1. The gap

There is no action that lists a project's contributions.

Contributions are returned only by:
- `publish-project-version` (the one you just submitted),
- `respond-project-contribution` (the one you just reviewed),
- `withdraw-project-contribution` (the one you just withdrew).

`list-project-activity` reports that contribution events *happened*, but the desktop's safe
projection deliberately drops subject ids — surfacing raw `contribution_id`s to the renderer would
break the same privacy boundary `P3-4-ID` was designed to protect.

## 2. Consequence

The Project Detail → Versions → Contributions section can only show contributions **this device
submitted or acted on during the current session**. The UI states exactly that and points the user
at the Activity tab; nothing is faked and no listing is invented.

The practical cost: **a project owner cannot see a queue of pending contributions awaiting review.**
They can see that a contribution was submitted (activity), but cannot act on it unless it happened
in this session. That is the difference between "contributions exist" and "contributions are
reviewable".

## 3. Requested contract — additive, same shape as the existing listings

```
POST /api/desktop
X-Desktop-Action: list-project-contributions

request:  { projectId, state?: 'submitted'|'accepted'|'rejected'|'withdrawn',
            limit?, cursor? }

200 { accountId,
      items: [ mapContribution(...) ],     // the EXISTING mapper, unchanged
      pageInfo: { limit, hasMore, nextCursor,
                  order: 'updatedAtDesc,idDesc', scope: 'project' } }

403  not a project member
400  invalid cursor / unsupported state
```

Visibility should mirror `list-project-collaborators`: the owner sees all contributions on the
project; a contributor sees their own.

No new mapper, no new envelope, no change to any existing action.

## 4. Why this is cheap for the desktop

Already implemented and tested on our side:
- `parseContribution` (fail-closed, matches `mapContribution` exactly),
- the shared cursor pagination helper (`listAll`) used by collaborators and activity,
- `pcontrib_…` opaque refs with account/project/epoch scoping,
- the accept / reject / withdraw controls and their 409-reconcile behavior.

Wiring a new listing is expected to be a small, bounded change — essentially one call into the
existing `listAll` plus a render.

## 5. Acceptance the desktop will require

1. Action available on a staging-validated deployment (SHA + deployment id).
2. Unauthenticated probe returns 401, consistent with the other nine actions.
3. `pageInfo` matches the existing cursor contract exactly.
4. Owner-vs-contributor visibility is enforced server-side, not by the client.

## 6. Reference

Full statement: `docs/WAVI_MULTIPLAYER_V1_DESKTOP_AUDIT.md` §14.
Desktop adapter: `electron/multiplayerService.ts` (`parseContribution`, `listAll`),
`electron/multiplayerRefs.ts` (`pcontrib_…`).
