# WS-015 · Post-refactor dead-code sweep  [HAIKU-friendly]
**Product outcome:** cleaner trunk after the big merges.
**Technical objective:** remove now-unused imports/symbols left by the Dashboard simplification and merges (e.g. Dashboard.tsx icon imports Link/Copy/Check/Package/ExternalLink if unused; any orphaned helpers), enable noUnusedLocals check ONLY if diff stays small, run gates.
**Dependencies:** none. **Repo:** wavio-studio. **Base:** trunk. **Branch:** chore/dead-code-sweep. **Worktree:** ~/wavi-worktrees/dead-code.
**Exact requirements:** zero behavior change; `git diff --stat` < 120 lines; full gates green.
**Prohibited:** logic edits, renames, formatting churn outside touched lines.
**Worker:** Haiku/Builder. **Reviewer:** Builder.
---
## WORKER PROMPT
wavio-studio repo, branch chore/dead-code-sweep from feature/ableton-daw-companion in ~/wavi-worktrees/dead-code. Find unused imports/vars introduced by recent merges (tsc has them off — verify by temporary --noUnusedLocals runs), remove conservatively, run `npx tsc -p tsconfig.electron.json && npx tsc --noEmit -p . && npx vitest run && npm run build` from the worktree root. Small conventional commits. Push + handoffs/WS-015-<date>.md.
claimed: sonnet subagent pilot · 2026-07-02

## ACCEPTED · 2026-07-03
Reviewer: architect session. Commit 3932452f verified line-by-line; gates 434/434; merged ff into feature/ableton-daw-companion and pushed. Deviations accepted: single commit for two files (documented). Flagged blocker (Dashboard importStatus set-but-never-rendered) moved to backlog.
