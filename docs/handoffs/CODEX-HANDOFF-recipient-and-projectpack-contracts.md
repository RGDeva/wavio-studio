# Codex Handoff — Recipient Page, ZIP/Project Pack, Import-Token & Link Contracts

**From:** Wavi Studio (desktop lane) · **To:** Codex (web/backend lane)
**Date:** 2026-07-09 · **Status:** contract spec — desktop-authored, web-implemented
**Authority:** `docs/CROSS_REPO_CONTRACTS.md` is the source of truth; this packet
consolidates only the endpoints the **Ableton reference-milestone** restore/link
flow depends on and flags the gaps. Do **not** implement any of this in the
desktop repo — it is the web/backend work the desktop flow requires.

Related: `docs/WAVI_ABLETON_E2E_RUNBOOK.md` (the live round-trip this unblocks),
`docs/WAVI_DECISION_REGISTER.md` (DR-001 owner authority, DR-015 DAWproject),
`docs/WAVI_DESKTOP_PRODUCT_EXPERIENCE_AND_INTEROPERABILITY_EXECUTION_PLAN.md §8`.

Legend: **[OK]** desktop verified it works today · **[VERIFY]** desktop calls it,
needs a web-side confirmation/contract lock · **[GAP]** required by the milestone,
not known to exist yet.

---

## 1. Link resolve (recipient → manifest)  [VERIFY]

Desktop calls (no auth — the share token is the capability):
```
POST {API_BASE}/desktop/index
Header: X-Desktop-Action: resolve-project-link
Body:   { "token": "<share token>" }
```
Desktop consumes this response shape (from `restore:start`); please lock it:
```jsonc
{
  "projectName": "string",
  "dawType": "ableton" | "fl-studio" | string | null,
  "versionId": "string",
  "parentVersionId": "string | null",
  "ownerUserId": "string | null",
  "collaboratorMode": "view" | "comment" | "edit",
  "shareId": "string",
  "fileCount": number,
  "totalSize": number,
  "files": [
    { "relative_path": "string", "file_name": "string",
      "role": "project|master|stem|midi|audio|artwork|document|directory|other",
      "sha256": "hex string | null", "size": number }
  ]
}
```
Requirements:
- Revoked/expired token → non-200 with `{ error }` (desktop surfaces it).
- `files[].relative_path` MUST match the ZIP entry paths exactly (§2) and the
  `sha256` MUST be the pre-upload hash (desktop verifies every file; a mismatch
  fails the restore).
- Include the `Ableton Project Info/` directory entry (`role:"directory"`) when
  the source packed it — desktop needs it to avoid Ableton's "Temp Project"
  state. (Desktop already emits this in the manifest via the adapter; the web
  manifest must preserve it.)

## 2. ZIP / Project Pack download  [VERIFY]

Desktop calls:
```
GET {webOrigin}/api/project-link/{token}/download   → application/zip
```
Status contract already handled by desktop: **200** ok · **403** permission_denied
· **410** expired_link · **404** missing_asset. Please keep these exact codes.

Requirements (mirror `execution-plan §8.5`):
- Only **authorized** assets for the link's permissions; never private storage
  paths or absolute local paths inside the archive.
- Entry paths == manifest `relative_path`. Safe names; **no archive traversal**
  (`../`), no symlinks. (Desktop also defends on extract, but the server must not
  emit unsafe entries.)
- Deterministic / idempotent for a given version; revoked or expired link → the
  download must also fail (403/410), not just the page.
- DAWproject-aware (DR-015): the pack should carry `project.dawproject` +
  original native project + `wavi/session.json` + `wavi/fidelity.json` +
  referenced assets when present. For the Ableton same-DAW milestone, the native
  `.als` + dependencies + `Ableton Project Info/` are the required minimum.

## 3. Create / revoke Project Link  [OK]

Desktop calls `desktopApiPost(token, 'create-project-link' | 'revoke-project-link', …)`
(authed) and builds the recipient URL as `{WEB_BASE}/project-link/{trackingId}`.
- **[VERIFY]** revoke must immediately kill both the recipient page AND the
  `resolve-project-link` + `/download` endpoints (runbook §5 asserts this).

## 4. Recipient project-style page  [GAP for "project-style"]

`{WEB_BASE}/project-link/{trackingId}` exists as a listen/preview page. The
milestone needs it to also (permission-gated) present: source DAW, current
version, file sections (master/stems/MIDI/native/artwork), a plugin/dependency
report placeholder, **compatibility summary**, and the primary actions
**Open in <DAW>** / **Download Project Pack** / **Open in Wavi Studio**.
- Only render actions the package + permissions actually support (desktop
  exposes the same honesty rule via `daw:getCapabilities`).

## 5. Open in Wavi Studio + import token  [GAP]

Today "Open in Ableton" deep-links `wavi://open-project/<shareToken>` and the
desktop resolves the **share token** directly. The execution plan (§8.6) calls
for a **short-lived import token** minted per open-click instead of reusing the
long-lived share token in the deep link.
- **[GAP] Requested:** `POST /api/share-links/{code}/import-token` →
  `{ importToken, expiresInSec }`; deep link carries `importToken`;
  `resolve-project-link` + `/download` accept it and reject once expired/used.
- Until this lands, the desktop continues with the share token (works, but the
  token is longer-lived than ideal). This is a hardening item, **not** a blocker
  for the first Ableton round trip.

## 6. Collaborator permissions & contribution submission  [GAP — milestone item]

Contribution return (runbook §6, execution-plan loop item) needs a web contract
for publishing a **child version** from a restored project back into the same
workspace:
- child references the original project + records `parent_version_id`;
- original version stays immutable; no unrelated project is created;
- permission check: only `collaboratorMode` ∈ {comment, edit} may submit.
- **Requested:** confirm whether `publish-project-version` (desktop already calls
  it for the owner) accepts a `parentVersionId` + `sourceRestoreId` for the
  collaborator path, or whether a distinct `submit-contribution` action is
  needed. Desktop will wire whichever contract you lock.

---

## 7. Authoritative link listing + reconciliation  [GAP — found in P3-2a audit]

The desktop Links workspace and the Project Detail links section are **local
device-only** today: `links:getAll` reads the desktop SQLite `links` table and
there is **no** server call that lists a user's links or reconciles a cached
record against server truth (see `docs/WAVI_PROJECT_LINKS_DESKTOP_AUDIT.md` Q3/Q7).
Consequence the desktop now surfaces honestly: a record loaded from a previous
session is shown as `cached` (not `server-confirmed`), and reconciliation is
exposed as *unavailable* rather than faked.

- **Requested:** a `list-project-links` desktop action returning, per link:
  `trackingId`, `projectId`, `projectVersionId`, `status` (active/revoked/expired),
  `permissions`, `createdAt`, `expiresAt`, `revokedAt`. This lets desktop flip a
  `cached` record to `server-confirmed`/`revoked`/`expired` authoritatively and
  drop the "not re-verified this session" caveat.
- Optional: a lightweight `resolve-project-link-status` (single trackingId) for
  cheap per-row reconciliation.

## 8. Account-scoped isolation of cached links  [GAP — found in P3-2a audit]

The `links` table has **no creator/account column**, and `auth:clearToken`
(logout) does **not** clear it (audit Q8). Desktop mitigates in the client layer
(session-confirmed state is invalidated on account switch, so a cached row is
never *presented* as freshly server-confirmed for a different account), but the
rows themselves remain visible.

- **Requested (server/contract):** include the owning `accountId` in the
  `create-project-link` response and any `list-project-links` payload so desktop
  can attribute — and on account switch, hide/segregate — cached records.
- Desktop-side follow-up (tracked separately, not requested of Codex): persist
  that `accountId` on the local row and filter on the active account.

## 9. Permission-enforcement contract  [GAP — found in P3-2a audit]

Desktop only offers permissions it can verify the server honors: `allow_download`
and `collaboratorMode` ∈ {view, comment, edit}. Everything else (download
Project Pack, open-in-Wavi-Studio import, contribute, comment enforcement) is
shown **disabled with an honest note**, not as an enforced capability.

- **Requested:** the authoritative list of permission keys the server *enforces*
  on resolve/download, and their exact wire names, so desktop can enable each
  toggle only when enforcement is real. Until a key appears here, desktop keeps it
  disabled.

---

## What desktop already guarantees (so the web side can rely on it)
- Every downloaded file is SHA-256-verified against the manifest; restore fails
  closed on mismatch/missing.
- Archive extraction is path-contained to the chosen destination (restore.security
  suite green); no `..`/symlink escape; never executes archive contents.
- The renderer never receives raw local filesystem paths for playback
  (wavi-media:// opaque IDs).

## Priority for the Ableton milestone
1. **[VERIFY] §1 + §2** — resolve manifest + ZIP with the exact shapes/paths/hashes
   and the `Ableton Project Info/` entry (required for the round trip to pass).
2. **[VERIFY] §3** — revoke kills resolve + download.
3. **[GAP] §6** — contribution child-version contract (needed for the full
   milestone; the same-DAW open works without it).
4. **[GAP] §5** import-token — hardening, after the round trip is green.

No desktop code changes are requested here. Reply on the shape locks in §1/§2/§6
and desktop will wire the client side in a bounded follow-up.
