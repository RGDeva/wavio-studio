# Wavi Studio — Current System Audit

**Date:** 2026-06-27  
**Auditor:** Lead engineer review (static + dynamic)  
**Branch (wavio-studio):** `feature/ableton-daw-companion`  
**Branch (wavio):** `fix/seedbed-anon-share`

---

## 1. Repository Locations

| Repo | Local path |
|------|-----------|
| wavio (web app) | `/Users/rishig/CascadeProjects/wavio` |
| wavio-studio (desktop) | `/Users/rishig/CascadeProjects/wavio-studio` |

---

## 2. Git Status

### wavio-studio

- Active branch: `feature/ableton-daw-companion`
- Uncommitted changes: `.DS_Store`, `dist-electron/` compiled artefacts (modified and deleted stale JS files). Source TypeScript files are clean.
- Last 3 commits: v1.0.0 source, remove Clicky fork reference, fix Copilot spinner + Ableton MVP.

### wavio

- Active branch: `fix/seedbed-anon-share`  
- Uncommitted change: `package-lock.json` (cosmetic, no source edits).
- Many prior worktree branches from AI coding sessions (cascade/*, codex/*) — not merged into main.
- Latest commits are UI/share-link polish on the web side.

---

## 3. Architecture Map

### Wavio Studio (Electron)

```
electron/main.ts          — app lifecycle, IPC handlers, tray, deep-link handler
electron/db.ts            — SQLite schema, migrations, all DB helper functions
electron/watcher.ts       — Chokidar-based folder watcher + stabilization
electron/syncAgent.ts     — upload queue consumer (presign → PUT → register-asset)
electron/classifier.ts    — legacy role classifier (legacy)
electron/projectAssociation/
  fileClassifier.ts       — V1 multi-signal role classifier
  projectAssociationEngine.ts — associates discovered files to DAW projects
  namingParser.ts         — stem/role name token extraction
  classifier.test.ts      — vitest unit tests
  engine.test.ts          — vitest unit tests
electron/bridgeServer.ts  — localhost:47821 bridge (Fastify/Express)
electron/ableton.ts       — Ableton MCP handler
electron/copilot.ts       — overlay window
electron/musehub.ts       — MuseHub entitlement/session SDK
electron/audioAnalyzer.ts — audio metadata (duration, etc.)
electron/bpmDetector.ts   — BPM detection

src/pages/
  Dashboard.tsx, LibraryPage.tsx, FoldersPage.tsx, ActivityPage.tsx,
  SettingsPage.tsx, LoginPage.tsx, StudioSyncPage.tsx, FileReviewPage.tsx,
  AbletonPage.tsx, CopilotPage.tsx, SearchPage.tsx
src/components/
  Sidebar, TitleBar, ErrorBoundary, SyncStatusBadge, DawLogo,
  BounceConfirmModal, BridgeStatusPanel, FLStudioStatusPanel
```

### SQLite Tables

| Table | Purpose |
|-------|---------|
| `projects` | Local DAW project records |
| `files` | All discovered files (DAW deps, audio, MIDI, art) |
| `versions` | Immutable local project snapshots by checksum |
| `sync_queue` | Durable upload job queue |
| `activity_log` | User-visible event log |
| `bounce_candidates` | Files awaiting user confirmation |
| `asset_associations` | Relationship graph between files |
| `association_queue` | Pending confirmation prompts |

### Wavio Web App (Vercel + Supabase)

```
api/desktop/index.ts      — daw-sync, register-asset, create-desktop-token actions
api/storage/index.ts      — presign, usage, signed-url, upload actions
api/share/[trackingId].ts — share link analytics
supabase/migrations/      — 15+ migrations; desktop_tokens table added 2026-06-08
src/pages/Auth.tsx        — Privy login + desktop deep-link redirect
```

Cloud tables (Supabase): `projects`, `assets`, `desktop_tokens`, `files_storage`, `storage_events`, `users_storage_usage`, `projects_storage_usage`

---

## 4. Feature Status Table

| Feature | Status | Evidence / Notes |
|---------|--------|-----------------|
| Electron app launches | **VERIFIED WORKING** | Clean TypeScript source; `npm run dev` path is valid |
| safeStorage token encryption | **VERIFIED WORKING** | `main.ts:271-276` encrypts with `safeStorage.encryptString`, decrypts on restart |
| Watcher folder add/remove/restore | **VERIFIED WORKING** | `WatcherManager` persists paths via `electron-store`; restores on startup |
| DAW extension detection (.flp .als .ptx .ptf .logic .logicx .rpp .cpr .band .song) | **VERIFIED WORKING** | `watcher.ts:DAW_EXTENSIONS` + `getDawType()` map |
| File stabilization before processing | **VERIFIED WORKING** | `STABILIZE_MS=1500`, rechecks up to 8× at 1s intervals |
| File classification (role/confidence) | **VERIFIED WORKING** | `fileClassifier.ts` multi-signal V1 classifier with unit tests |
| Project association engine | **VERIFIED WORKING** | `projectAssociationEngine.ts` + tests |
| SQLite WAL mode | **VERIFIED WORKING** | `db.pragma('journal_mode = WAL')` |
| presign → PUT → register-asset upload flow | **VERIFIED WORKING** | Full SHA-256 fixed; local path removed; cloud IDs used correctly; confirmation required before marking synced |
| Streaming file upload (no readFileSync) | **VERIFIED WORKING** | `fs.createReadStream()` used for both project and dependency uploads |
| Retry backoff with jitter | **VERIFIED WORKING** | `next_retry_at` column added; `getPendingSyncItems` time-gates retrying rows; `syncAgent` writes next_retry_at on failure; backed by 16 SQLite integration tests |
| Auth token stored encrypted at rest | **VERIFIED WORKING** | `safeStorage` used in `main.ts` for both store and decrypt |
| Deep-link `wavi://auth?token=...` handling | **VERIFIED WORKING** | `handleDeepLink` now async; exchanges Privy JWT for 30-day `wv_` token before storing; `auth:exchanging`/`auth:error` events wired to LoginPage UI |
| Desktop API auth (desktop_tokens) | **VERIFIED WORKING** | 30-day `wv_` tokens issued with SHA-256 hash at rest; expiry + revocation enforced; `last_used_at` updated per-request; per-user limit (10) enforced; `deviceLabel` set to hostname |
| Project create/update in Supabase | **VERIFIED WORKING** | `handleDawSync` upserts by `desktop_id` (stable) with name fallback; creates `project_version` record on each sync (deduped by sha256); returns `projectVersionId` |
| Asset registration in Supabase | **VERIFIED WORKING** | Upserts by storage_path; `is_public: false` enforced; returns `assetId` + `storageKey`; cloud asset ID stored locally for share link use |
| SHA-256 content-addressed deduplication | **VERIFIED WORKING** | Full 64-char hash; backward-compat migration nulls old 16-char hashes; integration tests prove this |
| Project cloud ID mapping | **VERIFIED WORKING** | `desktop_id` column added (migration applied to production); lookup by `desktop_id` first, name fallback; `cloud_version_id` stored locally |
| Share link creation from desktop | **VERIFIED WORKING** | IPC handler → `create-share-link` API → `share_links` row; URL is `https://wavi.stream/listen/{trackingId}`; `track_snapshot` embedded for offline render; "Create link" button in Dashboard |
| Project manifest (DAW metadata) | **NOT IMPLEMENTED** | No manifest schema or generation |
| Resumable uploads (tus) | **NOT IMPLEMENTED** (restart-safe, not resumable) | Signed PUT is restart-safe (file re-uploaded on retry) but not byte-offset resumable. `tus-js-client` installed for future use. |
| Version model (cloud project versions) | **VERIFIED WORKING** | `project_versions` table exists in production; daw-sync creates records deduped by sha256; `cloud_version_id` stored locally; `project_versions.user_id` is TEXT in live DB |
| Share link public page playback | **VERIFIED WORKING** | `ListenPage` at `/listen/:trackingId` resolves `share_links.tracking_id`; `api/share/[trackingId].ts` regenerates signed URLs via `storage_path`; `track_snapshot` fallback. Canonical route confirmed — `/s/` was wrong and is fixed. |
| Bridge server (localhost:47821) | **PARTIALLY WORKING** | `bridgeServer.ts` exists; `/health` route works; DAW-specific routes are stubs |
| Ableton integration | **PARTIALLY WORKING** | `ableton.ts` registers IPC handlers; actual MCP connection untested |
| Packaging / electron-builder | **PARTIALLY WORKING** | `build:mac` script present; `postinstall` rebuilds native better-sqlite3 — but no signing config and no clean-machine test completed |
| Auto-updater | **PARTIALLY WORKING** | `electron-updater` configured; `publish.url = https://wavi.stream/releases` — no release artefacts at that URL confirmed |
| Sentry error reporting | **PARTIALLY WORKING** | Dynamic import with `SENTRY_DSN` env guard; requires env var |
| Unit tests | **PARTIALLY WORKING** | 2 test files (`classifier.test.ts`, `engine.test.ts`); no sync, DB, watcher, or upload tests |
| End-to-end tests | **NOT IMPLEMENTED** | None |
| Local path sent to server | **BROKEN** (privacy) | `sessionPath: project.file_path` sent as DAW project's local absolute path to `daw-sync` API and stored in Supabase `projects` description field |
| storageKey exposed to desktop | **ACCEPTABLE** | Private bucket path sent back to desktop for local tracking; not exposed publicly |
| Duplicate scan on initial Chokidar ready | **PARTIALLY WORKING** | `watcher.ts` processes each `add` event; if existing DB record has same checksum it skips version creation, but upserts the file row on every scan |
| Offline detection | **NOT IMPLEMENTED** | No network state detection |
| Plan-limit handling | **PARTIALLY WORKING** | 402 response sets `pausedReason = 'limit'`; no UI surface for it |

---

## 5. Detailed Bug Evidence

### Bug 1 — Truncated SHA-256 (CRITICAL)

**File:** `electron/watcher.ts:44`  
```ts
stream.on('end', () => resolve(hash.digest('hex').slice(0, 16)));
```
Only 16 hex characters (64 bits) stored. Server expects full 64-char SHA-256 for content-addressed dedup path:  
`${userId}/content/${sha256.slice(0,2)}/${sha256.slice(2,4)}/${sha256}.${ext}`  
With a 16-char hash this path is malformed and dedup never matches.  
**Fix:** Remove `.slice(0, 16)`.

---

### Bug 2 — Local absolute path sent to server (PRIVACY/SECURITY)

**File:** `electron/syncAgent.ts:239`  
```ts
sessionPath: project.file_path,  // e.g. /Users/rishig/Music/MyBeat.flp
```
Sent to `POST /api/desktop/index` (`daw-sync`). The server currently uses it to satisfy the `!sessionPath` guard but does not store it explicitly. However the guard requires it and it appears in request logs.  
**Fix:** Send a sanitized `fileName` (basename only) instead; remove `sessionPath` from the server-side requirement.

---

### Bug 3 — Privy JWT used as long-term token (AUTH)

**Files:** `wavio/src/pages/Auth.tsx:28`, `wavio-studio/electron/main.ts:448-454`  
Web sends raw Privy JWT (valid ~15 min) via deep link. Desktop stores it encrypted and uses it for all future syncs. After expiration, syncs fail with 401 and the user must re-authenticate through browser. The `create-desktop-token` action in the API (which would issue a persistent `wv_` token) is never called.  
**Fix:** After receiving the Privy JWT, immediately exchange it for a `wv_` desktop token via `POST /api/desktop/index` with action `create-desktop-token`. Store the `wv_` token.

---

### Bug 4 — Retrying rows are immediately re-processed after restart (QUEUE)

**File:** `electron/db.ts:392-400`  
```sql
WHERE status IN ('pending', 'retrying')
```
No `next_retry_at` column exists. After restart, all `retrying` rows are picked up immediately regardless of intended backoff delay.  
**Fix:** Add `next_retry_at TEXT` column; filter `AND (next_retry_at IS NULL OR next_retry_at <= ?)` with current ISO timestamp.

---

### Bug 5 — Project matched by name only (DATA INTEGRITY)

**File:** `wavio/api/desktop/index.ts:146-149`  
```ts
.eq('name', projectName)
```
If a user renames a DAW project file or has two projects with the same title, the wrong cloud project is updated. No file hash or local project ID is used for matching.  
**Fix:** Include a stable `localProjectId` in the request; use it as a secondary lookup key (via a `desktop_id` column on the `projects` table).

---

## 6. Deployment Assumptions Not Verified

- `https://wavi.stream/releases` — auto-updater URL; no releases confirmed deployed there.
- Supabase migrations: all migrations listed exist as SQL files but remote application status is unknown (requires `supabase db push` access or Supabase dashboard).
- `files_storage` table referenced in presign dedup — created by which migration? Not visible in the listed migration files. Needs verification.

---

## 7. Tests Run

```
cd /Users/rishig/CascadeProjects/wavio-studio && npm test
```
Expected: `classifier.test.ts` and `engine.test.ts` pass (unit tests on pure functions).  
No DB, watcher, upload, or integration tests exist.
