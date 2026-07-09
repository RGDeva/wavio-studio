# WS-004 · Packaged-app smoke of merged trunk
**Product outcome:** confidence that the newly merged Links page, Project Detail and Copilot card behave in the real packaged app (not just dev).
**Technical objective:** build QA app from trunk `feature/ableton-daw-companion`, run the interactive smoke checklist against a disposable user-data dir, fix ONLY small rendering/wiring defects found (≤20-line diffs each), file anything larger as a blocker.
**Dependencies:** none. **Repo:** wavio-studio. **Base branch:** feature/ableton-daw-companion. **Feature branch:** fix/packaged-smoke-findings. **Worktree:** ~/wavi-worktrees/packaged-smoke.
**Files likely affected:** src/pages/LinksPage.tsx, src/components/ProjectDetail.tsx, src/pages/CopilotPage.tsx (small fixes only).
**Exact requirements:** (1) `npm run build && npx electron-builder --mac --config electron-builder.qa.json`; (2) launch the QA .app with `WAVI_USER_DATA_DIR=~/wavi-worktrees/smoke-ud WAVI_QA_OVERRIDE=1`; (3) run docs/WAVI_ACCEPTANCE_TEST_INDEX.md §C fully, ESPECIALLY: does the bounce player play a real wav in the packaged app (file:// origin)? does the Copilot confirmation card render? record yes/no per item with screenshots in handoffs/; (4) fix only trivial defects; (5) update docs/WAVI_DECISION_REGISTER.md DR-010 with the packaged-playback finding.
**Prohibited:** feature work, styling redesign, electron/main.ts logic changes, production deploy, the founder's real library.
**DB/API implications:** none. **Unit tests:** only for helpers you fix. **Integration:** full vitest stays 434+ green. **Interactive acceptance:** §C checklist with per-item PASS/FAIL. **Security review:** none beyond checklist.
**Commits:** conventional, one per defect. **Handoff:** per tasks/README schema + checklist. **Stop conditions:** any defect needing >20 lines → blocker; build failures after 3 attempts.
**Worker:** Builder (Sonnet). **Reviewer:** Critic (GPT) or Architect.
---
## WORKER PROMPT (self-contained)
You are working in the wavio-studio Electron app (~/CascadeProjects/wavio-studio). Read docs/AI_CONTROL_TOWER.md and docs/WAVI_ACCEPTANCE_TEST_INDEX.md first, then execute this packet exactly; do not exceed its scope. Create the worktree with `git worktree add ~/wavi-worktrees/packaged-smoke -b fix/packaged-smoke-findings feature/ableton-daw-companion`, copy node_modules from the main checkout, run `npx electron-builder install-app-deps` inside it. Never touch the founder's modified .gitignore, the stash, or the wavio repo. Push the branch and write handoffs/WS-004-<date>.md.
