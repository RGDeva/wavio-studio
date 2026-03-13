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
