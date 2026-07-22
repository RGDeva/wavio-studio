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