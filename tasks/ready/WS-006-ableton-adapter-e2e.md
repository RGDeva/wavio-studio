# WS-006 · Un-hold the Ableton adapter: restore/launch dispatch + full E2E  [ARCHITECT]
**Product outcome:** the proven Ableton flow runs through the adapter layer, unlocking FL Studio work on a clean interface.
**Technical objective:** on `refactor/ableton-adapter`: (1) merge trunk in (small conflicts in electron/main.ts + vitest.config.ts; adapter extraction wins for the moved helpers, trunk wins for links/copilot additions); (2) move restore-time and launch-time Ableton specifics behind adapter methods (post-extract validation incl. `Ableton Project Info/`; launch via adapter) — behavior-preserving, golden manifests unchanged; (3) run the FULL Ableton E2E from docs/WAVI_ACCEPTANCE_TEST_INDEX.md §D on a disposable project.
**Dependencies:** founder-authorized signed-in session for the network steps. **Repo:** wavio-studio. **Base/branch:** refactor/ableton-adapter. **Worktree:** ~/wavi-worktrees/ableton-adapter.
**Files:** electron/adapters/*, electron/main.ts (restore:start ~1450+, launch paths), adapter tests.
**Exact requirements:** E2E evidence in handoff: publish→link→preview 200→restore fresh dir→shasum table→opens in Ableton→NO Temp Project screenshot→duplicate-restore dialog→revoke kills resolve.
**Prohibited:** changing manifest content/order or exclusion rules (DR-013 is a founder decision); FL work.
**Unit:** contract suite extended for restore/launch hooks. **Integration:** full vitest. **Interactive:** the E2E. **Security:** restore path containment (restore.security green).
**Commits:** merge + 1–2 refactor commits. **Handoff:** standard + E2E evidence. **Stop:** any behavioral deviation from trunk restore → stop and report.
**Worker:** Architect. **Reviewer:** Critic.
