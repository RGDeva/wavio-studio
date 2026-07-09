# Wavi AI Control Tower

Operating manual for running Wavi development with a mixed fleet: a frontier
"architect" model (scarce), cheaper implementation models (plentiful), and
human founder decisions. Written 2026-07-02 by the outgoing principal-architect
session. **This file is the entry point — read it first in every new session.**

## The one rule

The architect model designs, reviews, migrates, and unblocks. Implementation
models build inside task packets. Nothing merges to the trunk without passing
the packet's acceptance gates and a review pass.

## Session bootstrap (any model, every session)

1. `cd /Users/rishig/CascadeProjects/wavio-studio` (desktop) — the web repo
   `../wavio` is CODEX TERRITORY while a Codex session is active:
   `pgrep -f "working-dir /Users/rishig/CascadeProjects/wavio"` → if it prints,
   DO NOT modify wavio.
2. Read: `docs/WAVI_BRANCH_AND_WORKTREE_MAP.md`, `docs/WAVI_NEXT_ACTIONS.md`,
   `docs/WAVI_DECISION_REGISTER.md`, then your task packet in `tasks/ready/`.
3. Verify state: `git status`, `git log --oneline -5`,
   `npx vitest run` (from the repo root — NEVER from a parent directory),
   `npx tsc -p tsconfig.electron.json && npx tsc --noEmit -p .`.
4. Test prerequisite: several suites need an arm64-node better-sqlite3 at
   `/tmp/wavio-sqlite-test/node_modules/better-sqlite3`. If missing (macOS
   clears /tmp!): `mkdir -p /tmp/wavio-sqlite-test && cd /tmp/wavio-sqlite-test
   && npm init -y && npm install better-sqlite3` (any version with a prebuilt
   for the local node; tests only use the core API).

## Hard-learned environment facts

- **/tmp is volatile.** The OS wiped every /tmp worktree, scratch backup and
  the test sqlite binary mid-project. Put worktrees in `~/wavi-worktrees/`,
  never /tmp. Anything worth keeping goes in git (pushed) immediately.
- **Shell cwd resets between tool calls** in agent harnesses — every command
  chain must `cd` explicitly. A vitest run from the wrong cwd silently globs
  unrelated repos and reports garbage.
- **Pipelines mask exit codes** (`git merge … | tail` reports tail's status).
  Check `git log` after every merge; never trust the pipeline.
- **Real merges require a clean index**; the repo often carries the founder's
  uncommitted WIP. Never stash/commit founder WIP; unstage-preserving or ask.
- better-sqlite3 in each worktree is Electron-ABI; run it under
  `./node_modules/.bin/electron`, or rebuild with
  `npx electron-builder install-app-deps` after copying node_modules.
- The permission classifier occasionally goes down: writes fail temporarily.
  Do read-only prep, retry in a few minutes; never work around it.

## Task lifecycle

`tasks/backlog/` → (architect prioritizes, fills packet) → `tasks/ready/` →
worker claims: move file to `tasks/in_progress/`, add worker+date line →
work on the packet's branch in `~/wavi-worktrees/<branch>` → on completion
write `handoffs/<task-id>-<date>.md` (template in each packet) and push →
reviewer (per packet) inspects diff, runs gates, approves → move packet to
`tasks/completed/` and merge per packet instructions.

Workers NEVER: touch `main`, force-push, rebase pushed branches, delete
stashes/branches/worktrees, modify wavio while Codex is active, rotate
credentials, deploy production, touch the founder's uncommitted files, or
exceed the packet's file scope without recording a blocker in the handoff.

## Review checklist (architect or GPT reviewer)

diff scope vs packet → tests added & meaningful (not mirror-drift) → both
tsc configs → full vitest from repo root → `npm run build` → security pass
(tokens/paths/logging/IPC surface/confirmation gates) → UX language pass
(no cloud IDs/hashes/queue jargon in default surfaces) → update
`docs/WAVI_DECISION_REGISTER.md` if any decision was made or violated.

## Standing acceptance gates (every merge to trunk)

Both tsc · full vitest green · vite build · QA build keeps bundle id
`stream.wavi.studio.qa` and mutates no source · working tree afterwards shows
only the founder's own uncommitted files.

## Document map

Architecture: WAVI_CANONICAL_PROJECT_MODEL, WAVI_DAW_ADAPTER_ARCHITECTURE,
WAVI_CROSS_DAW_PORTABLE_SESSION (+ WAVI_FL_TO_ABLETON_IMPLEMENTATION),
WAVI_COPILOT_TOOL_ARCHITECTURE, WAVI_DAW_AGENT_ARCHITECTURE,
WAVI_DESKTOP_INFORMATION_ARCHITECTURE. State: WAVI_CURRENT_STATE_AUDIT,
WAVI_SYSTEM_MAP, WAVI_BRANCH_AND_WORKTREE_MAP, WAVI_AUTONOMOUS_PROGRESS/
BLOCKERS/NEXT_ACTIONS. Process: this file, WAVI_MODEL_ROUTING,
WAVI_ACCEPTANCE_TEST_INDEX, WAVI_DECISION_REGISTER,
WAVI_90_DAY_EXECUTION_PLAN, WAVI_EXECUTION_ROADMAP_V2, WAVI_SYNC_BRANCH_REVIEW.
