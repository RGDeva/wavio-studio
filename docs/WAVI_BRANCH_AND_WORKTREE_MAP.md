# Wavi Branch and Worktree Map

Updated 2026-07-02 (post integration review). All listed branches are pushed
to origin. **Worktree rule going forward: create under `~/wavi-worktrees/`,
never /tmp (the OS wiped every /tmp worktree during this project).**

## wavio-studio (desktop) — github.com/RGDeva/wavio-studio

| Branch | Tip | Status |
|---|---|---|
| `feature/ableton-daw-companion` | `83b5a82e` | **DE-FACTO TRUNK.** Contains: full Project Links stack, sync-scalability (9 commits), Links registry + Links page, routed Project Detail, Copilot tools v1 + out-of-band confirmation + card. 434 tests green. |
| `main` | ancient | 70+ commits behind trunk. Founder decision needed on reconciliation (DR-004). Never work here. |
| `refactor/ableton-adapter` | `5d8562ba` | **HELD — do not merge** until the full Ableton E2E (publish→link→restore→open, no Temp Project) passes on it (packet WS-006). Contains the adapter extraction (behavior-preserving, 396 tests green on-branch). Will need a trivial re-merge vs trunk (main.ts/vitest.config overlap). |
| `feature/desktop-links-page` | `5f5e0311` | Merged into trunk via the project-detail stack. Keep for history; do not delete. |
| `feature/project-detail` | `f9bdef0b` | Merged into trunk (merge commit `83b5a82e`). Keep. |
| `feature/copilot-tools-v1` | `6e093fc9` | Merged into trunk (fast-forward). Keep. |
| `fix/studio-sync-scalability` | `9731f873`-lineage | Fully merged since Phase 1.5. Keep until founder approves deletion. |
| `feature/project-detail-wip` | `9518f51c` | **PRESERVATION ONLY — never merge.** Snapshot of founder WIP (Dashboard.tsx/.gitignore tracked; ProjectDetail.tsx in `^3`). Superseded by the merged Project Detail, retained for reference. |
| `feature/copilot-semantic-discovery` | old | Parked. Carries a do-not-ship note on its folder-grouping heuristic. Salvage only the query-understanding ideas. |
| `integration/overnight-review` | == trunk content | Scratch integration candidate; checkout was wiped with /tmp. Safe to delete the REF after founder confirms trunk stability (DR-007). |

Founder working-tree items in the main checkout (do not touch): modified
`.gitignore` (unstaged; content preserved in stash@{0}), `stash@{0}`, and the
untracked docs/ + tasks/ control-tower files pending founder review/commit.

## wavio (web) — ACTIVE CODEX TERRITORY

Check `pgrep -f "working-dir /Users/rishig/CascadeProjects/wavio"` before ANY
change. Checked out: `feature/wavi-project-links-analytics` with uncommitted
Codex work incl. migration `20260701163000_project_share_links.sql` (additive
multi-link model, backfills `project_share_settings`, own token/slug,
`is_active`, `view_count`, server-side `internal_label`). ~16 codex/* and
~13 cascade/* branches + ~30 registered worktrees under ~/.codex and
~/.windsurf — never prune without the founder. `main` at `9c7f95e`.

## Cross-repo compatibility (Codex overlap verdict, 2026-07-02)

No collisions: desktop's local `links` registry stores trackingIds from the
desktop `create-share-link`/`create-project-link` actions; Codex multi-links
use their own table/token/slug and `is_active`. Three link systems now exist
(Listen, Project, Codex multi-link) — unification is Phase B (packet WS-002),
NOT another desktop abstraction. Desktop internal labels are local-only;
Codex links have a server-side label column — converge in the canonical Link.
