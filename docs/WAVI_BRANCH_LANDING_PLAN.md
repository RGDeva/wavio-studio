# Branch Landing Plan — desktop milestone stack

Date: 2026-07-09 · For the reviewer/founder landing the /loop-produced branches
into `feature/ableton-daw-companion` (@ `6600cfa5`). Every branch below cleanly
descends from integration (no divergence) and passed its own gate (Node 22:
electron+renderer tsc, full Vitest zero-skip, task-specific security/E2E,
packaged build where runtime changed, `git diff --check`). **None is merged.**

## The stack

| # | Branch | SHA | Depends on | Files | Runtime? |
|---|--------|-----|-----------|-------|----------|
| A | `refactor/ableton-adapter` | `2d182029` | integration | adapters/*, ableton.ts, discovery.ts, main.ts, vitest.config | yes |
| B | `feature/project-detail-compatibility` | `8cff949e` | **contains A** | A's files + preload, api.ts, ProjectDetail.tsx, compatibilityView.* | yes |
| C | `feature/assistant-openindaw-gating` | `e867cc1f` | integration | copilotTools/{index,test} | yes |
| D | `feature/project-detail-summary` | `e5c660d7` | integration | ProjectDetail.tsx, projectDetailView.* | no (renderer) |
| E | `docs/fl-studio-api-mcp-audit` | `e38994a5` | integration | 1 doc | no |
| F | `docs/ableton-e2e-runbook` | `caa721b3` | integration | 1 doc | no |
| G | `docs/codex-handoff-recipient-contracts` | `41a18e6f` | integration | 1 doc | no |

Verified relationships:
- **B ⊇ A** — B was branched off A (adapter is an ancestor of B). Merging B lands
  the WS-006 step-1+2 adapter work *and* the compatibility surface together; do
  **not** merge A separately if you merge B.
- **B and D both edit `src/components/ProjectDetail.tsx`** → a **real but small
  conflict** (B adds the compatibility card + `compatibilityView` import; D adds
  the summary strip + `deriveProjectSummary`/`formatFileSize` import). Trial
  merge confirmed exactly one conflicted file, resolvable as a union.
- **C, E, F, G are independent** — no conflicts with anything.

## Recommended merge order

1. **B `feature/project-detail-compatibility`** (`8cff949e`) — lands adapter
   (WS-006 step 1+2) + compatibility card + `daw:getCapabilities`.
   - ⚠️ **Release gate:** the adapter's live proof is **WS-006 step 3** (the
     Ableton same-DAW E2E, `docs/WAVI_ABLETON_E2E_RUNBOOK.md`), still un-run
     (needs founder session + Ableton). The code is behavior-preserving and
     fully unit-tested (adapter contract 24/24, restore.security 37/37), but if
     you want the live round trip to precede integration, run the runbook first.
2. **C `feature/assistant-openindaw-gating`** (`e867cc1f`) — independent safety
   fix; land anytime.
3. **D `feature/project-detail-summary`** (`e5c660d7`) — **after B**. Resolve the
   one `ProjectDetail.tsx` conflict as a **union** (keep both the compatibility
   card and the summary strip; merge the two import statements). Alternatively
   rebase D onto post-B integration first, then fast-forward.
4. **E, F, G** (docs) — land anytime, no conflict.

After each merge: re-run `nvm use && npm run test:setup-native && npm test`
(expect 0 skips) and both tsc. After B+D, expect ~487+ tests (B) then +4 (D).

## What stays OUT until the founder session

- WS-006 **step 3** live Ableton round trip (runbook F).
- Live **Project Link creation** + **collaborator child-version return**.
- These are the only remaining terminal-condition items; all are founder-gated.

## Do not

- Do not merge A separately from B (B already contains it).
- Do not land D before B (avoids a harder 3-way ProjectDetail conflict).
- Do not begin FL adapter *code* (WS-007) yet — deferred until after the Ableton
  reference milestone (see `WAVI_FL_STUDIO_API_MCP_AUDIT.md`).
