# WS-003 · Links page server synchronization (desktop)
**Product outcome:** Links page shows ALL the creator's links (any device/web/Codex) with live status, per DR-001.
**Technical objective:** consume WS-002 list-links/rename-link: fetch on load/refresh, reconcile into the local registry (server wins status/expiry/capabilities; labels: local wins until server label ships, then push via rename-link), render server rows, registry becomes an explicit cache (update header copy; drop "this computer" scoping).
**Dependencies:** WS-002 deployed to the QA-pointed preview. **Repo:** wavio-studio. **Base:** trunk. **Branch:** feat/links-server-sync. **Worktree:** ~/wavi-worktrees/links-sync.
**Files:** electron/main.ts (links:getAll → fetch+reconcile, offline fallback), electron/db.ts (additive `source` column 'local'|'server' + upsert), src/pages/LinksPage.tsx (copy + offline banner), electron/links.test.ts (reconcile matrix).
**Exact requirements:** offline ⇒ cached rows + "showing cached links" banner; 401 ⇒ cached + sign-in hint; server revocation overwrites stale local active; local revoke stays server-first; repeated reconcile creates no duplicates.
**Prohibited:** inventing analytics values; removing legacy revoke dispatch; wavio edits.
**Unit:** reconcile matrix (server-revoked×local-active, expiry drift, label precedence). **Integration:** full vitest. **Interactive:** §C Links block + one other-device link visible in a real QA session. **Security:** owner-only rows; no token logging.
**Commits:** db / ipc / ui / tests. **Handoff:** standard + matrix results. **Stop:** endpoint shape differs from packet → sync with Architect.
**Worker:** Builder. **Reviewer:** Architect.
---
## WORKER PROMPT
wavio-studio. Read docs/AI_CONTROL_TOWER.md, docs/WAVI_DECISION_REGISTER.md (DR-001 binds this task), electron/db.ts links section, electron/main.ts links IPC, src/pages/LinksPage.tsx, src/lib/linksView.ts. Implement exactly this packet in worktree ~/wavi-worktrees/links-sync on branch feat/links-server-sync from feature/ableton-daw-companion. Server truth always beats local for status; never fabricate analytics. Push + handoff.
