# P3-1a — Desktop UI baseline (before design-token migration)

Date: 2026-07-09 · Branch: `feat/desktop-design-tokens` · Base: `feature/ableton-daw-companion` @ `154f5965`

Purpose: record the current visual state of the priority surfaces before the token/primitive
migration, so P3-1b+ can compare. **No screenshots were fabricated.**

## Capture method + environment limitation (recorded exactly, per instruction)

Two capture paths were attempted:

1. **Live Electron app** (`Wavi Studio.app` / dev `Electron`): the window exists (System Events
   reports it, correct size) but `screencapture -x` does **not** capture it — this is a
   multi-Mission-Control-Space macOS session and the app window renders on a Space the capture
   utility does not grab (verified repeatedly across the session; wallpaper differs per shot). No
   `Quartz`/CoreGraphics Python module is available for `screencapture -l<windowID>` direct-window
   capture. **Result: the 10 authenticated surfaces cannot be captured as files in this environment.**
2. **Standalone renderer via Vite** (`http://localhost:5173`, browser pane): renders, but the app
   gates on auth (`api.auth.getToken()`), and without the Electron `window.waviAPI` bridge the
   client falls back to a stub and shows **LoginPage**. Injecting a `window.waviAPI` stub does not
   help because `const api = window.waviAPI ?? _stub` binds at module import (before any post-load
   injection), and the reload required to re-run that binding wipes the injected global. LoginPage's
   "Sign in with Wavi" opens an **external OAuth** (`shell.openExternal`) that cannot complete
   headless. **Result: only LoginPage is reachable standalone.**

**Reachable + observed:** `LoginPage` — centered brand lockup ("⌁ Wavi Studio" heading), a dark
card ("Sign in to sync your DAW" / "Uses the same account as wavi.stream"), a **cyan primary
button** ("Sign in with Wavi"), muted footer ("Your session is encrypted at rest."). This is a
faithful sample of the current visual language (accent = `cyan-500`, card = `bg-white/[0.03]`-ish
dark surface, system/sans type, `rounded` corners) that the token work relates to. LoginPage is
**not** migrated in P3-1a, so it also serves as an unchanged control for the after-comparison.

**Required capture method for the 10 live surfaces** (founder-attended or CI): run the app on a
single-Space macOS session (or CI with a virtual display), then `screencapture -l<windowID>` per
window, or use the computer-use MCP with screen-recording on the app's Space. Store PNGs beside
this file. Do not commit sensitive project names, local paths, emails, tokens, or private artwork.

## Per-surface current-state notes (from code — factual, not screenshots)

| # | Surface | Route/component | Current styling notes (migration-relevant) |
|---|---|---|---|
| 1 | App shell | `App.tsx` + `Sidebar` + `TitleBar` | dark; sidebar nav uses `text-white/opacity`; no token layer |
| 2 | Home | `Dashboard` (`page='dashboard'`) | project cards + `SyncStatusBadge` (migration target) |
| 3 | Projects | `Dashboard` project list | inline status strings + badges |
| 4 | Project Detail | `ProjectDetail` panel | **primary actions row** (Open in DAW / Sync / Publish / Project Link / Listen) = migration target; compatibility card; summary strip |
| 5 | Project Links | `LinksPage` (`page='links'`) | link rows, status via `deriveLinkStatus` |
| 6 | Versions | Project Detail "Versions" tab | list; needs data |
| 7 | Assistant | `CopilotPage` (`page='copilot'`) | chat + tool cards |
| 8 | Activity | `ActivityPage` (`page='activity'`) | activity log list |
| 9 | Settings | `SettingsPage` (`page='settings'`) | forms/toggles/DAW paths |
| 10 | Watched folders | `FoldersPage` (`page='folders'`) | folder list + discover |

## Migration scope for P3-1a (unchanged elsewhere)
Only `SyncStatusBadge` and the Project Detail **primary actions** (+ directly-related status
elements) are migrated onto the new `Button`/`StatusBadge` primitives. All other surfaces above are
untouched this task and should be pixel-identical after (regression control).
