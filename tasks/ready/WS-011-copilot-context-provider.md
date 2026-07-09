# WS-011 · Copilot context provider: selected project + version
**Product outcome:** Copilot always knows which project/version the user is looking at.
**Technical objective:** a single renderer context source: when Project Detail is open, its project (and selected version when the Versions tab selects one) becomes the Copilot context; CopilotPage/overlay getContext consumers receive it (extend copilot:getContext flow or pass ctx explicitly on chat/confirm — pick the smaller diff consistent with existing copilot.ts getContext implementation); include versionId (already in ProjectContext type).
**Dependencies:** WS-010. **Repo:** wavio-studio. **Base:** trunk. **Branch:** feat/copilot-context. **Worktree:** ~/wavi-worktrees/copilot-context.
**Files:** electron/copilot.ts (getContext), src/App.tsx or a small context module, ProjectDetail.tsx, CopilotPage.tsx, copilotTypes.ts consumers, tests for the pure selection logic.
**Exact requirements:** with Detail open on project X, "sync this project" in Copilot targets X (assert via prioritize call arg in a fake-deps unit test at the tool layer if feasible, else via activity_log audit row in dev smoke); with nothing open, tools answer with the no-project error copy.
**Prohibited:** new tools; storing context anywhere persistent.
**Interactive:** dev smoke both states. **Security:** context contains no absolute paths beyond what tools already require locally (never sent to cloud except the existing chat payload — do not expand it).
**Commits:** ≤3. **Handoff:** standard. **Stop:** if getContext currently derives from a different source of truth (main-process activeProject) that conflicts — document and consult Architect.
**Worker:** Builder. **Reviewer:** Architect.
