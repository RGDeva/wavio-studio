# WS-009 · Collaborator child versions  [ARCHITECT for RLS]
**Product outcome:** the core loop closes — a collaborator restores a Project Link, edits, and publishes a child version the owner sees.
**Technical objective:** wavio: `publish-child-version` desktop action (parent_version_id set from the restored provenance; permission = live project_collaborators row with edit; RLS enforced; provenance alone grants NOTHING). studio: publish flow branches when the local project row came from restored_projects (offer "Publish as new version for <owner's project>"); Versions tab shows ancestry (parent chain).
**GATE:** wavio side gated on Codex idle (same check as WS-002).
**Dependencies:** WS-002 preferred first (shared canonical plumbing) but not strictly required. **Repos:** both. **Branches:** feat/child-versions (each repo). **Worktrees:** ~/wavi-worktrees/child-versions[-web].
**Files:** wavio api/desktop/index.ts + migration only if a column is missing (ancestry column already exists), collaboration-auth; studio main.ts publish path, restored_projects read, ProjectDetail Versions tab, tests both sides.
**Exact requirements:** permission matrix tested (view/comment/edit × publish attempt; revoked-link-after-restore publishes NOTHING); ancestry integrity (child.parent = restored source version); owner's Versions tab shows the child with author label.
**Prohibited:** editing owner's version rows; merge/overwrite semantics (children only, DR-006).
**Interactive:** full loop on disposable accounts: owner shares edit link → collaborator restores → publishes child → owner sees it. **Security:** Critic on the permission matrix.
**Commits:** api / rls-tests / studio-flow / ui. **Handoff:** standard + matrix. **Stop:** any path where provenance alone grants publish.
**Worker:** Architect (server) + Builder (studio UI). **Reviewer:** Critic.
