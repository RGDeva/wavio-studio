# Wavi Next Actions

Loop closed 2026-07-02 after 6 iterations / 5 phases (A, C, D, F, H). Continuation order:

1. **Human review + merge decision for the four feature branches** (all pushed, all green, none merged):
   `feature/desktop-links-page` → `feature/project-detail` (stacked pair) · `refactor/ableton-adapter` · `feature/copilot-tools-v1` (independent, both from trunk `9731f873`). The three independent lines will conflict lightly in `main.ts`/`vitest.config.ts` when combined — merge the stacked pair first, then rebase-or-merge the other two (no force-push on shared branches; prefer merge). Run one interactive renderer smoke before merging (row → Project Detail → bounce play → link create; Links page revoke).
2. **Phase H follow-up:** confirmation CARD UI in CopilotPage/overlay for `needs_confirmation` results (envelope already enforces; UI currently shows text only).
3. **Phase F follow-up:** dispatch `restore:start` through the adapter registry on `refactor/ableton-adapter`. Required before Phase G.
4. **Phase B (canonical Link server layer)** — still blocked by the active Codex agent in wavio (B-1). Re-check with `pgrep -f "working-dir /Users/rishig/CascadeProjects/wavio"`; start only when idle AND its tree is clean.
5. **Phase G (FL Studio native packs)** after 3; **Phase E** after 4; **Phase I** last.

Human items: supply `WAVI_AUTH_TOKEN` for the real-network harness (B-2); authorize credential rotation (B-3); decide on the pre-existing `Backup` (scanner skip) vs `Backups` (publish exclude) naming quirk; decide fate of the still-uncommitted `.gitignore`/`ProjectDetail.tsx` working-tree copies (both preserved on `feature/project-detail-wip` + stash@{0}); commit these three progress docs + the 8 architecture docs when reviewed; eventually fast-forward `main`.
