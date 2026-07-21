# P3-1c — Project Detail workspace redesign (visual + a11y evidence)

Branch: `feat/project-detail-workspace-redesign` · Base: `feature/ableton-daw-companion` @ `ff7399cf`

## Information architecture
Compact header (name in Jura, SyncStatusBadge · DAW · vN · last-updated, Copilot, close)
→ primary actions (Open in DAW / Sync Changes / Publish Version / Share Project) + secondary
(Copy Listen Link / Reveal Folder) using the `Button` primitive → workspace `Tabs`:
**Overview · Files · Versions · Dependencies · Compatibility · Activity**.
- Overview: wavi-media:// player + honest next-recommended-action + Package `Progress`
  completeness + a restrained stat grid (native/bounce/stems/MIDI/synced/missing) + recent
  activity + active links.
- Files: role groups (SectionHeader) of `FileRow` (name / relative path only / size / local /
  cloud / missing / in-package) — never a raw absolute path.
- Versions: present versions only (no fabricated parent/branch data).
- Dependencies: missing-file list + honest "plugin scanning not yet implemented".
- Compatibility: adapter `capabilities()` with honest labels (Available / Planned / Not yet).
- Activity: existing project/sync activity.

## Preview harness (dev-only, `?ui-preview` → "Project Detail")
Deterministic synthetic Project Detail across 13 states (populated/loading/empty/error/offline/
permission-denied/partial-sync/missing-file/success/sync-in-progress/publish-ready/no-native-daw/
playback-error). Captured (Browser pane, synthetic data, no console errors, 1280×800):
- **populated Overview** — header, actions, tabs, player, "Up to date and shared", Progress 100%, stats.
- **Files** — grouped FileRow with in-package/synced/local-only badges + relative paths.
(error / empty / offline states shared with the shell harness; missing-file/no-native-daw switchable.)
No committable binaries produced in this environment; capture PNGs on a single-Space/CI session.

## Behavior preserved (no changes)
wavi-media:// remains the only local playback path; `<audio>` omitted when no playable bounce
(no `src=""`); project switch clears playback (pause + removeAttribute('src') + load) and resets
tab to Overview; all handlers (open/sync/publish/share/listen/reveal) unchanged; no IPC/schema/
permission/deep-link/secure-audio changes.

## Accessibility
Tabs: role=tab/tablist, aria-selected, roving tabindex + Arrow/Home/End (pure `nextTabIndex` unit
tested), focus-visible ring, active tabpanel aria-labelledby. Progress: role=progressbar +
aria-valuenow + numeric %, tone not the only signal (`clampPercent`/`progressTone` unit tested).
Real `<button>`s throughout; group toggles have aria-expanded; status uses role=status; loading
uses aria-busy. FileRow actions keyboard-focusable (focus-within reveal). Readable at 1280×800.

## Remaining Project Detail limitations (P3-2+)
Collaborator count / branch state absent until multiplayer; portable-session (`.dawproject`)
artifacts not yet in Files; live Ableton gates unproven; per-file package-inclusion is heuristic
until the Project Pack contract lands.
