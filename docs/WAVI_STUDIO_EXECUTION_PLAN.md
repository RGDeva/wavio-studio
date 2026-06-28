# Wavi Studio — Execution Plan

**Date:** 2026-06-27  
**Starting point:** `feature/ableton-daw-companion` (desktop) / `fix/seedbed-anon-share` (web)

Work is ordered by dependency. Each slice is bounded and independently reviewable. A later slice must not begin until its foundational dependencies are demonstrably working.

---

## Slice 0 — Working Branch + Test Baseline (1–2 hours)

**Goal:** Know the current test pass rate and establish clean branches.

Tasks:
1. Create `feature/studio-v1-reliability` branch from `feature/ableton-daw-companion`.
2. Create `feature/studio-desktop-api` branch on wavio from `fix/seedbed-anon-share`.
3. Run `npm test` in wavio-studio — baseline classifier and engine tests.
4. Run `npm test` in wavio — baseline web tests.
5. `npm run build:electron` — confirm TypeScript compiles clean.

**Files touched:** none (read-only + branch creation)  
**Human approval needed:** none

---

## Slice 1 — Fix SHA-256 Hash Truncation (30 min) ⚠️ HIGHEST PRIORITY

**Bug:** `watcher.ts:44` truncates SHA-256 to 16 hex chars, breaking deduplication and content-addressed storage.

**Fix:**
```ts
// watcher.ts — remove .slice(0, 16) in fileChecksum()
stream.on('end', () => resolve(hash.digest('hex')));   // full 64-char hex
stream.on('error', () => resolve(crypto.randomUUID())); // full UUID on error
```

Also fix `main.ts` `fileChecksum` call if it has its own copy.

**Tests to add:** `electron/watcher.test.ts` — `fileChecksum()` returns 64-char hex string.

**Files:** `electron/watcher.ts`  
**Human approval:** none — pure bug fix, no API contract change

---

## Slice 2 — Fix Retry Queue (no time gate after restart) (1 hour)

**Bug:** After restart, `retrying` rows are immediately processed regardless of intended backoff delay.

**Fix:**
1. Add `next_retry_at TEXT` column to `sync_queue` in `db.ts`.
2. Update `getPendingSyncItems` query:
   ```sql
   WHERE status IN ('pending', 'retrying')
     AND (next_retry_at IS NULL OR next_retry_at <= ?)
   ```
3. When setting status to `retrying`, also set `next_retry_at = new Date(Date.now() + delay).toISOString()`.

**Files:** `electron/db.ts`, `electron/syncAgent.ts`  
**Human approval:** none

---

## Slice 3 — Desktop Token Auth (2–3 hours) ⚠️ HIGH PRIORITY

**Bug:** Desktop stores short-lived Privy JWT instead of a persistent desktop token. Syncs fail ~15 min after login.

**Plan:**

### wavio-studio changes

In `electron/main.ts`, after receiving the deep-link token, before storing it:
```ts
// If token is a Privy JWT (not wv_), exchange it for a desktop token
if (!token.startsWith('wv_')) {
  const res = await fetch('https://wavi.stream/api/desktop/index', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-Desktop-Action': 'create-desktop-token' },
    body: JSON.stringify({}),
  });
  if (res.ok) {
    const data = await res.json();
    token = data.token; // wv_ token
  }
}
```

### wavio changes

The `handleCreateDesktopToken` function already exists in `api/desktop/index.ts` — verify it's wired and functional.

**Files:** `electron/main.ts`, `wavio/api/desktop/index.ts` (verify only)  
**Human approval:** none for code; yes for deploying wavio changes

---

## Slice 4 — Remove sessionPath Privacy Leak (1 hour)

**Bug:** Local absolute path sent to server in `daw-sync` payload.

### wavio-studio

Replace in `syncAgent.ts`:
```ts
// Remove:
sessionPath: project.file_path,

// Add:
fileName: path.basename(project.file_path),
localProjectId: project.id,
```

### wavio API

In `api/desktop/index.ts — handleDawSync`:
- Change guard from `!projectName || !sessionPath` to `!projectName || !fileName`.
- Add `localProjectId` to upsert logic and store in `desktop_id` column.

**Requires:** Supabase migration to add `desktop_id TEXT` to `projects` table (HUMAN APPROVAL for migration application).

**Files:** `electron/syncAgent.ts`, `wavio/api/desktop/index.ts`, new migration  
**Human approval:** required before applying migration to production

---

## Slice 5 — Project Identity via localProjectId (2 hours)

**Bug:** Project matched by name only — rename creates duplicate cloud project.

**Fix:**
- Add `desktop_id` column (from Slice 4).
- In `handleDawSync`, look up by `desktop_id` first, then fall back to name.
- Store returned `cloudProjectId` in local `projects.cloud_id`.

**Files:** same as Slice 4  
**Human approval:** same migration gate

---

## Slice 6 — Share Link Creation (3–4 hours)

**Goal:** User can create a Wavi share link from desktop and copy it.

### wavio API

Add `create-share-link` action to `api/desktop/index.ts`:
- Accepts `projectId`, `assetIds[]`, `permissions`, `visibility`.
- Creates or retrieves a share link record.
- Returns `{ shareUrl, trackingId }`.

### wavio-studio

- Add IPC handler `share:createLink` in `main.ts`.
- Add `Create Link` button to Dashboard/project card.
- Show result in a copy-to-clipboard modal.

**Files:** `wavio/api/desktop/index.ts`, `electron/main.ts`, `src/pages/Dashboard.tsx`, new modal component  
**Human approval:** required for deploying API changes

---

## Slice 7 — Resumable Uploads for Large Files (4–6 hours)

**Goal:** Files over 50 MB upload resumably via tus (tus-js-client is already installed).

**Plan:**
- In `syncAgent.ts`, detect file size. Under 50 MB: use existing presign → PUT flow. Over 50 MB: use tus.
- Store `upload_url` and `upload_offset` in `sync_queue` for resume on restart.
- Supabase storage supports tus via `<supabase_url>/storage/v1/upload/resumable`.

**Files:** `electron/syncAgent.ts`, `electron/db.ts` (add `tus_upload_url` column)  
**Human approval:** none

---

## Slice 8 — Polished UI States (2–3 hours)

**Goal:** Every screen has loading, empty, error, success states. No dead buttons.

Priority screens:
1. Dashboard — project list with sync status
2. FoldersPage — watched folder management
3. Upload queue — with retry/cancel per item
4. Activity — log with timestamps

Remove placeholder data and fake statistics.

**Files:** `src/pages/*.tsx`, `src/components/*.tsx`  
**Human approval:** none

---

## Slice 9 — Tests (ongoing)

Add after each slice:
- `electron/watcher.test.ts` — fileChecksum, stabilization, duplicate prevention
- `electron/syncAgent.test.ts` — queue transitions, retry timing, restart recovery
- `electron/db.test.ts` — schema migrations, idempotency

**Target:** 80% coverage on core sync engine before packaging.

---

## Human Approval Gates

| Gate | What requires approval |
|------|----------------------|
| Supabase migration | Adding `desktop_id`, `file_name` columns to `projects` table |
| wavio API deploy | Any changes to `api/desktop/index.ts` or `api/storage/index.ts` |
| Production secrets | Any env var changes in Vercel dashboard |
| Release publish | `electron-builder` output uploaded to `wavi.stream/releases` |
| Signing cert | macOS notarization and Developer ID cert |
