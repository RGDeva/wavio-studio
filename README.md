# Wavi Studio

Desktop DAW sync agent for Wavi. Automatically monitors FL Studio and Pro Tools project folders and syncs them to the Wavi cloud platform.

## Stack
- **Electron** — cross-platform desktop shell
- **React + Vite** — UI renderer
- **Tailwind CSS** — styling
- **better-sqlite3** — local sync database
- **Chokidar** — filesystem watcher
- **tus-js-client** — resumable uploads

## Development

```bash
npm install
npm run dev
```

## Build

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux
```

## Architecture

```
electron/
  main.ts        — Electron main process, IPC handlers
  preload.ts     — Context bridge (exposes waviAPI to renderer)
  db.ts          — SQLite database (projects, files, sync_queue, activity_log)
  watcher.ts     — Chokidar folder watcher + project/dependency detection
  syncAgent.ts   — Background sync worker with tus resumable uploads

src/
  App.tsx        — Root component, auth check, page routing
  pages/
    Dashboard    — Project list, upload progress, sync stats
    FoldersPage  — Add/remove watched folders
    ActivityPage — Sync history and file events
    SettingsPage — Sync settings, auth, system preferences
  components/
    Sidebar      — Navigation
    TitleBar     — macOS-style drag handle
    SyncStatusBadge — Status indicator
```

## Authentication

On first launch, enter your Wavi API token from `https://wavi.stream/settings`. The token is stored locally via `electron-store` and used to authenticate all API calls.

## Supported DAW Types

| Extension | DAW |
|-----------|-----|
| `.flp` | FL Studio |
| `.ptx` | Pro Tools |
| `.als` | Ableton Live |
| `.logic` | Logic Pro |
| `.rpp` | Reaper |

## Dependency Scanning

When a project is detected, the folder is recursively scanned for:
`.wav` `.mp3` `.aiff` `.mid` `.stems` `.flac` `.ogg`

All found assets are associated with the project and queued for upload.

## Resumable Uploads

Large files (5GB+) are uploaded using the [tus protocol](https://tus.io/) with 5MB chunks. Uploads can be interrupted and resumed automatically.

---

## FL Studio Demo Flow

Full end-to-end test walkthrough. Each step maps to a checklist item in the **FL Studio Status Panel** on the Dashboard.

### Prerequisites
1. Launch Wavi Studio (`npm run dev` or packaged `.dmg`)
2. Sign in — open Settings tab, paste your token from `https://wavi.stream/settings`, or use the deep-link OAuth flow
3. Ensure you have an FL Studio project saved somewhere on disk

---

### Step 1 — Link your FL Studio folder

- Open **Folders** tab → **Browse…**
- Select the folder containing your `.flp` files  
  Default: `~/Documents/Image-Line/FL Studio/Projects`
- Dashboard status panel: **"Folder linked" ✅**

---

### Step 2 — Wavi detects the .flp

- Within 2–5 seconds of linking, Wavi scans the folder
- Each `.flp` file becomes a project row in the Dashboard
- **Activity** tab logs: `"Detected new project: <name>.flp"`
- Status panel: **"FL Studio project detected (.flp)" ✅**

> **Stabilization:** Wavi waits for the file size to stop changing before processing.  
> New files written by FL Studio during Save are not acted on until fully written.

---

### Step 3 — Export a bounce

In FL Studio:
- `File → Export → Wave file…`
- Save into a subfolder named `exports`, `bounces`, `mixes`, `masters`, or `stems`:
  ```
  ~/…/Projects/MyTrack/exports/MyTrack_rough_v1.wav
  ```
- Wavi detects the file **after it stabilizes** (1.5–8 seconds depending on file size)
- Status panel: **"Export folder detected" ✅**, **"Latest bounce: MyTrack_rough_v1.wav" ✅**

> **Duplicate protection:** If you export the same file again with the same content, the bounce candidate is not duplicated (checksum match). If the file changes, it's re-opened.

---

### Step 4 — Confirm the bounce toast

A toast appears bottom-right:
- Shows filename, size, and detected role (`mix` / `master` / `stem`)
- **Buttons:** `New version` · `Stem` · `Master` · ✕ Ignore

Click **New version** (or the role-specific button):
- A `versions` DB row is created (label = `bounce`/`stem`/`master`)
- File is enqueued for upload at priority 9
- **Activity** logs: `"New bounce version: MyTrack_rough_v1.wav"`
- Status panel: **"Version created" ✅**

> **Idempotency:** Clicking "New version" a second time for the same file (same checksum) is a no-op — no duplicate version is created.

> **Ignored files:** Files dismissed with ✕ stay ignored unless FL Studio exports a new version of the same file (checksum changes), at which point a new toast appears.

---

### Step 5 — Upload syncs to cloud

- **Activity** logs: `"Upload started: MyTrack_rough_v1.wav"`
- Dashboard shows progress bar per file
- On completion: **Activity** logs `"Upload complete: MyTrack_rough_v1.wav"`
- Status panel: **"Upload: Complete" ✅**, files counter updates

> **Offline / retry:** If upload fails, it retries with exponential backoff (5s → 30s → 2m → 5m). Click **Retry** in the status panel or use the red "Retry N failed" button on Dashboard.

---

### Step 6 — View in web vault

- Click **↗** (globe icon) in the Dashboard header, or the vault link in the status panel
- URL: `https://wavi.stream/vault`
- Project appears with synced files
- Version history visible in the project row (expand `v1`, `v2`… counter)
- Status panel: **"Web vault synced" ✅**

---

## Remaining Blockers

### Phase 2 — Completed ✅ (this session)
- [x] Per-file stabilization (detect → wait 1.5s → recheck size → process when stable)
- [x] Bounce candidate dedup by `file_path` (UNIQUE index) + checksum
- [x] Version dedup by `(project_id, checksum)` and `(project_id, file_path)`
- [x] Ignored files stay ignored unless checksum changes
- [x] `bounces:resolve` uses proper DB exports, no `require()` hacks
- [x] Sync queue includes `file_id` so `syncAgent` reliably finds the file row
- [x] `syncAgent` falls back to `file_name` lookup if `file_id` is missing
- [x] `upload_started` + `upload_complete` activity log entries
- [x] FL Studio Status Panel on Dashboard (7-step checklist with live refresh)
- [x] Version row shows `label`/`version_type` badge (bounce/stem/master/mix)
- [x] Web API `versions` action uses correct DB columns

### Phase 3 — Collaboration & Plugin (next)
- [ ] **Project linking UI** — explicitly associate a local folder with a named cloud project (currently auto-named from `.flp` filename)
- [ ] **Version naming prompt** — ask user to name a version on confirm ("rough mix v1", "final master")
- [ ] **Web vault version player** — play bounce audio directly in browser
- [ ] **Real-time collaborator notifications** — push event when a collaborator syncs to the same project
- [ ] **FL Studio VST/Plugin bridge** — in-DAW upload without leaving FL Studio

### Phase 4 — AI Analysis (future)
- [ ] **Copilot overlay** (Cmd+Shift+W) — in-app chat with project context
- [ ] **BPM/key surfacing** — show detected BPM/key in vault asset view (data already collected)
- [ ] **Stem separation** — Replicate Demucs (API wired, needs UX)
- [ ] **Smart nudges** — "You haven't bounced in 3 days"
