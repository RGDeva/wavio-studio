# WS-007 · FL Studio adapter skeleton + fixtures
**Product outcome:** groundwork for FL-to-FL native Project Packs.
**Technical objective:** `electron/adapters/flstudio.ts` implementing the DawAdapter interface conservatively: isProjectFile (.flp), projectExtensions ['.flp'], findProjectRoot = file's directory, classifyEntry/cacheAndBackupPatterns (FL Backup/ 'Backup' folders + .flp.bak + autosaves), manifestExtras [] (none known), extractMetadata via WS-008's flpReader when merged (stub {bpm:0,key:''} until then), preview convention shared. Register in adapters/index.ts (moves '.flp' from KNOWN_DAW_PROJECT_EXTENSIONS extras into adapter claim — set membership unchanged). Synthetic .flp fixtures for tests (TLV bytes built in-test; also commit one tiny real .flp when the founder provides it — see stop conditions).
**Dependencies:** WS-006 merged (adapter layer on trunk). **Repo:** wavio-studio. **Base:** trunk (post-WS-006). **Branch:** feat/fl-adapter-skeleton. **Worktree:** ~/wavi-worktrees/fl-skeleton.
**Files:** electron/adapters/flstudio.ts (+tests), adapters/index.ts, adapters/adapters.test.ts.
**Exact requirements:** contract tests: registry resolves .flp→flstudio; classification totality; discovery extension set membership UNCHANGED; Backup exclusion; publish path picks the FL adapter for daw_type 'fl-studio'.
**Prohibited:** FLP parsing (WS-008), packing/restore changes, cross-DAW work.
**Unit/Integration:** as above + full vitest. **Interactive:** add a fixture .flp folder via Folders page → detected as FL project on Dashboard. **Security:** none new.
**Commits:** adapter / registry / tests. **Handoff:** standard. **Stop:** if publish flow requires FL-specific manifest extras you can't verify → blocker, don't invent.
**Worker:** Builder. **Reviewer:** Architect.
---
## WORKER PROMPT
wavio-studio. Read docs/WAVI_DAW_ADAPTER_ARCHITECTURE.md, electron/adapters/* (post-WS-006 trunk), docs/AI_CONTROL_TOWER.md. Implement exactly this packet; the Ableton adapter is your template; keep the generic adapter as fallback for other DAWs. Worktree ~/wavi-worktrees/fl-skeleton, branch feat/fl-adapter-skeleton. Push + handoffs/WS-007-<date>.md.
