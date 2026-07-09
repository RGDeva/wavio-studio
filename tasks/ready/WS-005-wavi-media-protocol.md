# WS-005 · Safe media protocol for bounce playback
**Product outcome:** the latest bounce plays inside Project Detail in BOTH dev and packaged builds.
**Technical objective:** register a `wavi-media://` protocol in the main process that serves ONLY files present in the local `files` table (path looked up by file id — never taken from the URL) and switch the Detail audio element to `wavi-media://file/<fileId>`.
**Dependencies:** WS-004 findings. **Repo:** wavio-studio. **Base:** feature/ableton-daw-companion. **Branch:** feat/wavi-media-protocol. **Worktree:** ~/wavi-worktrees/wavi-media.
**Files:** electron/main.ts (protocol registration at app.whenReady; privileged scheme registered pre-ready), src/components/ProjectDetail.tsx, src/lib/projectDetailView.ts, new unit test for the id-guard.
**Exact requirements:** handler parses fileId → getFileById → row exists AND fs.existsSync → serve that absolute path; else fail closed. NO URL path segment is ever used as a filesystem path (traversal-proof). Keep the graceful renderer error state.
**Prohibited:** serving arbitrary/query-param paths; touching sync/publish code.
**DB/API:** none. **Unit tests:** unknown id → null; missing file → null; traversal attempts fail. **Integration:** vitest green. **Interactive acceptance:** dev app plays a seeded wav; packaged QA app plays it; `wavi-media://file/../x`, absolute-path and unknown-id URLs all fail closed (prove in handoff). **Security review:** REQUIRED — Architect sign-off (path-traversal surface).
**Commits:** 1–2. **Handoff:** standard + malformed-URL proofs. **Stop:** CSP/session conflicts → document and stop.
**Worker:** Builder. **Reviewer:** Architect (security).
---
## WORKER PROMPT
wavio-studio Electron app. Read docs/AI_CONTROL_TOWER.md, this packet, electron/main.ts around app.whenReady, and getFileById in electron/db.ts. Invariant: the served filesystem path MUST come from the database row, never from the URL. Worktree per packet; push; handoffs/WS-005-<date>.md with the three malformed-URL failure proofs.
