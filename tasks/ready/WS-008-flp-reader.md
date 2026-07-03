# WS-008 · FLP reader (timing, MIDI, names, playlist)  [ARCHITECT]
**Product outcome:** Wavi can inspect real FL projects — the foundation of FL packs AND the FL→Ableton proof.
**Technical objective:** pure-TS TLV parser per docs/WAVI_FL_TO_ABLETON_IMPLEMENTATION.md §1–2: header (PPQ), tempo, time signature, title/comments, channel names + sample paths (with env-token substitution + resolution ladder), pattern notes, playlist items, markers; every extractor returns {value, confidence}; unknown events counted. `electron/adapters/flstudio/flpReader.ts`, zero Electron imports.
**Dependencies:** WS-007. **Repo:** wavio-studio. **Base:** trunk. **Branch:** feat/flp-reader. **Worktree:** ~/wavi-worktrees/flp-reader.
**Files:** electron/adapters/flstudio/flpReader.ts, flpEvents.ts (id constants + doc links), tests with synthetic TLV fixtures + real tiny .flp fixtures (founder-provided, hash-pinned).
**Exact requirements:** never throw on malformed input (typed {error} result); length-skip unknown events; sample-path resolution ladder exactly per the doc (§2) with UNRESOLVED reporting; fixture tests assert tempo/PPQ/notes/positions byte-exactly.
**Prohibited:** writing .flp; wiring into publish; guessing undocumented events (skip + count instead).
**Unit:** parser cases incl. truncated stream, wrong magic, huge var-length guard. **Integration:** flstudio adapter extractMetadata switches to the reader; vitest full. **Interactive:** parse the founder's real .flp; output table in handoff. **Security:** treat .flp as untrusted input — bounds-check every read (reviewer will fuzz).
**Commits:** events / reader / adapter-wire / tests. **Handoff:** standard + parsed-fixture table + unknown-event counts. **Stop:** any fixture parses differently than FL displays → report, don't fudge.
**Worker:** Architect. **Reviewer:** Critic (adversarial fuzz cases).
