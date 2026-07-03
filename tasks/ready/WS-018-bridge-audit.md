# WS-018 · Local bridge audit + capability-registry groundwork  [ARCHITECT]
**Product outcome:** the safe foundation for DAW-agent work (DR-014).
**Technical objective:** audit electron/bridgeServer.ts (auth token handling, bind address, surface); harden to: localhost-only bind asserted, constant-time token compare, per-op allowlist scaffold, structured audit of every bridge call into activity_log; add the capability-registry types from docs/WAVI_DAW_AGENT_ARCHITECTURE.md (types only + a read-only 'ping'/'inventory' op); NO DAW control ops.
**Repo:** wavio-studio. **Base:** trunk. **Branch:** feat/bridge-hardening. **Worktree:** ~/wavi-worktrees/bridge.
**Exact requirements:** threat notes in the handoff (who can call the bridge, replay, CSRF-from-browser vectors — bridge must reject browser origins); tests for auth failure paths.
**Prohibited:** any write-op implementation; model-facing exposure.
**Worker:** Architect. **Reviewer:** Critic.
