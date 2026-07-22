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
