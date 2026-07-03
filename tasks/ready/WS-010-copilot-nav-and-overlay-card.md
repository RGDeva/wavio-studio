# WS-010 · Copilot navigation fix + overlay confirmation card
**Product outcome:** gated Copilot actions are confirmable everywhere; the Copilot page is reachable.
**Technical objective:** (1) BUG: Project Detail's Copilot chip calls onNavigate('copilot') but the app stayed on Dashboard in smoke — reproduce, fix (likely the Detail overlay must close first / event ordering), and add 'copilot' to Sidebar NAV_ITEMS (page nav) distinct from the overlay toggle button; (2) port the CopilotPage confirmation card into the overlay panel (same out-of-band confirmTool IPC via copilot-preload; DR-002 binds), replacing the "open the Copilot page" text fallback.
**Dependencies:** none. **Repo:** wavio-studio. **Base:** trunk. **Branch:** feat/copilot-card-everywhere. **Worktree:** ~/wavi-worktrees/copilot-card.
**Files:** src/components/ProjectDetail.tsx, src/components/Sidebar.tsx, src/overlay/CopilotPanel.tsx, electron/copilot-preload.ts (confirmTool exposure), tests for any pure logic.
**Exact requirements:** card shows action, target project, files count, version, impact line, Confirm/Cancel; Cancel NEVER executes; confirm goes only through copilot:confirmTool; overlay + page behavior identical.
**Prohibited:** new tools; envelope changes; auto-confirmation of any kind.
**Interactive:** dev-app: Detail chip → Copilot page opens with project context; overlay gated flow shows card; Cancel leaves no activity_log 'done' entry for the tool. **Security:** verify the overlay webview cannot invoke confirmTool without a user click (no programmatic path from model output).
**Commits:** navfix / sidebar / overlay-card. **Handoff:** standard + screenshots. **Stop:** if the nav bug is in App-level state architecture → report to Architect instead of restructuring.
**Worker:** Builder. **Reviewer:** Critic.
---
## WORKER PROMPT
wavio-studio. Read docs/WAVI_DECISION_REGISTER.md DR-002 (binding), src/pages/CopilotPage.tsx card implementation (your template), src/overlay/CopilotPanel.tsx, electron/copilot.ts confirmTool IPC. Implement exactly this packet in ~/wavi-worktrees/copilot-card on feat/copilot-card-everywhere. The model must never be able to confirm its own action — preserve that property everywhere. Push + handoff.
