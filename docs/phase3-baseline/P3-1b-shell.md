# P3-1b — shell foundation + preview harness (visual + a11y evidence)

Branch: `feat/desktop-shell-foundation` · Base: `feature/ableton-daw-companion` @ `c34e32b3`

## Deterministic visual preview harness
Dev-only, opt-in: run a **development** build and open `http://localhost:5173/?ui-preview`
(gate: `isUiPreviewEnabled({ dev: import.meta.env.DEV }, location.search)`). Synthetic fixtures
only — no auth, network, IPC, filesystem, DB, publishing, links, or DAW launch; no real names/
paths/emails/tokens/artwork. Renders the 10 priority surfaces across 9 states
(populated/loading/empty/error/offline/permission-denied/partial-sync/missing-file/success).

## Captured states (Browser pane, synthetic data only — no committable binaries produced here)
- **populated** — sidebar (active "Home"), PageHeader ("Home · Synced" + Share/Open), Projects grid
  with token SyncStatusBadges (Synced/Uploading/Failed/Paused), Project Links (Active/Revoked),
  Versions + Activity in Surfaces.
- **error** — ErrorState primitive (destructive icon, "Something went wrong", "Try again" + Details).
- **empty** — EmptyState primitive (folder icon, title, one-sentence description, "Add folder").
- **loading** — Skeleton lines (motion-safe pulse). **offline** — warning offline banner + offline badge.
All clean/dense/operational, token-driven; no glow/glass/gradients/decorative-3D. No console errors.

To store PNGs: on a single-Space session or CI, capture `?ui-preview` per state (the harness is the
deterministic source). Founder/CI method as in BASELINE.md.

## Accessibility (verified in code + harness)
- Sidebar: `<nav aria-label="Primary">`, real `<button type="button">`, `aria-current="page"` on the
  active item, `focus-visible:ring-2 ring-ring` visible focus, consistent `w-4 h-4` icons.
- Offline banner `role="status"`; ErrorState `role="alert"`.
- Skeleton respects `prefers-reduced-motion` (`motion-safe:animate-pulse`); Sidebar "Agent running"
  dot likewise. Buttons are real buttons (no clickable non-semantic divs in the migrated shell).
- Shell at 1280×800 and narrower: fixed 208px sidebar + fluid main; no horizontal overflow.
- Contrast: `muted-fg` raised to `220 9% 55%`; meaningful labels moved off `white/20–30`.

## Remaining (P3-1c)
Per-page header adoption of `PageHeader` across Links/Activity/Settings/Folders; full Project Detail
token pass; broader `white/opacity` → token conversion; Input/Select/Dialog/Tooltip primitives.
