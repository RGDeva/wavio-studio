# WS-014 · Real plays/downloads on the Links page
**Product outcome:** creators see real per-link engagement.
**Technical objective:** after WS-002+WS-003: list-links includes per-link event aggregates (plays=stream events, downloads) computed server-side from wavi_link_events(+Codex view_count for kind 'page'); desktop renders real numbers replacing the em-dashes; tooltip states data freshness.
**Dependencies:** WS-002, WS-003 merged+deployed. **Repos:** wavio (aggregate in list-links) + studio (render). **Branches:** feat/link-analytics[-web]. **Worktrees:** ~/wavi-worktrees/link-analytics*.
**Files:** wavio api/desktop/index.ts + linkResolver aggregates; studio LinksPage/linksView + tests.
**Exact requirements:** aggregates owner-scoped; zero-count renders 0 (not —); offline shows cached numbers + banner.
**Prohibited:** client-side event math; new tables.
**Unit:** aggregate query tests (web), render tests (view logic). **Interactive:** play a link on the web, refresh desktop, count increments. **Security:** no cross-owner leakage (Critic).
**Worker:** Builder. **Reviewer:** Builder(second) + Critic on the query.
