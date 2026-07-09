# WS-019 · Acceptance harness automation index
**Product outcome:** one command per acceptance layer.
**Technical objective:** add npm scripts wrapping the gate layers (gates:tsc, gates:test, gates:build, gates:qa, validate:sync = harness sequence with fixtures), plus scripts/check-test-sqlite.sh that reinstalls /tmp/wavio-sqlite-test when missing (AI_CONTROL_TOWER bootstrap step, automated); update ACCEPTANCE_TEST_INDEX to reference them.
**Repo:** wavio-studio. **Base:** trunk. **Branch:** chore/gates-scripts. **Worktree:** ~/wavi-worktrees/gates.
**Prohibited:** changing any gate's substance; CI setup (separate founder decision).
**Worker:** Builder. **Reviewer:** Builder.
