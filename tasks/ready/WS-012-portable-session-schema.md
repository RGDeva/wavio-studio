# WS-012 · Portable-session schema package  [ARCHITECT]
**Product outcome:** the versioned contract every cross-DAW flow builds on.
**Technical objective:** implement schema v1 from docs/WAVI_CROSS_DAW_PORTABLE_SESSION.md §2 as `portable-session/` in wavio-studio (schema.json + generated TS types + validator with typed errors + manifest hashing helpers + fidelity-report type per WAVI_FL_TO_ABLETON_IMPLEMENTATION.md §6). Pure TS, no Electron. Include container helpers: write/read the ZIP layout (session.json + stems/ midi/ presets/ mix/) reusing the archiver already in deps.
**Dependencies:** none (parallel-safe). **Repo:** wavio-studio. **Base:** trunk. **Branch:** feat/portable-session-schema. **Worktree:** ~/wavi-worktrees/portable-schema.
**Files:** portable-session/{schema.json,types.ts,validate.ts,container.ts,fidelity.ts}, tests.
**Exact requirements:** validator rejects: missing bpm, absolute paths anywhere, manifest hash mismatch, clips before beat 0; round-trip write→read→deep-equal; version field mandatory ('1').
**Prohibited:** DAW-specific code; renderer/UI; wavio changes.
**Unit:** validation matrix + round-trip. **Integration:** vitest full. **Interactive:** none. **Security:** treat session.json as untrusted on read (bounds, no prototype pollution via JSON revive).
**Commits:** schema / validator / container / tests. **Handoff:** standard. **Stop:** any schema field you feel needs changing → propose in DECISION_REGISTER as PROPOSED, don't silently alter.
**Worker:** Architect. **Reviewer:** Critic.
