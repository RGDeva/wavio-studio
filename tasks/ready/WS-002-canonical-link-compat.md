# WS-002 · Canonical Link compatibility layer (wavio) — GATED ON CODEX IDLE  [ARCHITECT schema]
**Product outcome:** one Link model server-side; every existing URL keeps working; per-link analytics queryable.
**Technical objective:** additive migration on `project_share_links`: `kind` ('listen'|'project'|'page', default 'page'), `project_version_id uuid NULL`, `capabilities text[]`, `revoked_at timestamptz NULL`; backfill Listen-Link and Project-Link tokens into canonical rows with capabilities per docs/WAVI_CANONICAL_PROJECT_MODEL.md §5; resolvers check canonical first then legacy; `wavi_link_events.link_id` nullable FK; new `list-links` + `rename-link` actions in api/desktop/index.ts (owner-scoped).
**GATE:** `pgrep -f "working-dir /Users/rishig/CascadeProjects/wavio"` prints nothing AND `git -C ../wavio status --porcelain` clean — else STOP (blocker B-1).
**Dependencies:** Codex idle; founder approval to run the migration on staging (agents NEVER migrate production). **Repo:** wavio. **Base:** feature/wavi-project-links-analytics. **Branch:** feat/canonical-link-compat. **Worktree:** ~/wavi-worktrees/canonical-link.
**Files:** supabase/migrations/<new>.sql, api/_lib/linkResolver.ts (new), api/share/[trackingId].ts + api/project-link/[token].ts (fallback order only), api/desktop/index.ts, api tests.
**Exact requirements:** additive + reversible migration; zero behavior change for tokens absent from canonical; permissions/RLS unchanged in effect; tests: legacy listen resolves, legacy project resolves, canonical resolves, revoked/expired fail closed, list-links owner-only.
**Prohibited:** drops/renames, touching any uncommitted Codex work, prod migration, desktop changes (WS-003).
**Interactive:** curl all three resolver shapes on a preview deployment after tests pass. **Security:** Critic reviews RLS + fallback for privilege leaks.
**Commits:** migration / resolver / actions / tests. **Handoff:** standard + resolver decision table. **Stop:** Codex resumes; RLS ambiguity.
**Worker:** Architect + Builder (tests/actions). **Reviewer:** Critic.
