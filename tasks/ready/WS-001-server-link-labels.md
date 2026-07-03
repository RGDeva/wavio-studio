# WS-001 · Server-side internal labels groundwork (canonical Link column)
**Product outcome:** internal labels follow the creator across devices instead of living on one desktop.
**Technical objective:** design+add (as PART of the WS-002 migration if it hasn't merged yet — coordinate; else a follow-up additive migration) an `internal_label text NULL` on the canonical link rows for kinds 'listen'/'project' (Codex 'page' rows already have one), plus rename-link action support (WS-002 defines it) and desktop push of local labels on first server sync (WS-003 consumes). This packet = the wavio column/action side ONLY.
**GATE:** same Codex-idle gate as WS-002. **Repo:** wavio. **Base:** feat/canonical-link-compat (stack on WS-002). **Branch:** feat/link-labels. **Worktree:** ~/wavi-worktrees/link-labels.
**Exact requirements:** owner-only write via RLS/action check; label length ≤120; label never appears on public link pages.
**Prohibited:** desktop changes; exposing labels publicly.
**Unit:** action auth tests + public-page absence test. **Interactive:** rename via curl, see it in list-links. **Security:** Critic checks no public leakage.
**Worker:** Builder. **Reviewer:** Critic.
