# Wavi Studio — Assistant (Copilot) completeness audit (P3-3)

Audited against `feature/ableton-daw-companion` @ `45795a81` (branch
`feat/assistant-local-tools-foundation`). Evidence is `file:line` in the current tree.

## Architecture traced

| Layer | Location | Notes |
|---|---|---|
| Assistant UI (main pane) | `src/pages/CopilotPage.tsx` | chat + confirmation card + Discover; calls `api.copilot.chat/getContext/confirmTool` |
| Assistant UI (overlay) | `src/overlay/CopilotPanel.tsx` | floating panel variant |
| Chat / agent loop | `electron/agentLoop.ts` `runAgentChat` | server-side Claude via `wavi.stream`; `TOOL_REGISTRY` static tools |
| Envelope | `electron/copilotTools/envelope.ts` | validation · auth gate · **out-of-band confirmation** (model can't self-confirm; `confirmed` stripped) · audit log · failure containment |
| Envelope tools | `electron/copilotTools/index.ts` | `search_files, open_in_daw, inspect_sync_status, sync_project, publish_version` (injected deps) |
| Registry | `electron/agentLoop.ts` `TOOL_REGISTRY` + `registerProjectTools` | static tools + envelope tools merged |
| Tool IPC | `electron/copilot.ts` `copilot:runTool` (218) · `copilot:confirmTool` (252) | confirmTool is the ONLY caller passing `confirmedOutOfBand` |
| Project context | `electron/copilot.ts` `buildProjectContext` (128) | **uses `projects[0]` = most-recently-modified**, NOT the renderer's active project |
| Auth | `getDecryptedToken()` / envelope `isAuthenticated` | cloud tools gated on a signed-in session |
| Audit log | `logActivity` type `copilot_tool` | sanitized args, never file contents/tokens |
| Tests | `electron/copilotTools/copilotTools.test.ts` | envelope + first-5 tools, injected fakes |

## Safety gaps found (pre-existing, integration base)

1. **Stale project context.** `buildProjectContext()` resolves `projects[0]` (most-recently-modified), and `copilot:runTool` rebuilds it per call with **no explicit `projectId`** from the renderer's active view — a tool can silently act on an unrelated project after a switch. (`electron/copilot.ts:130,218`)
2. **Unsafe external-open without confirmation.** Static `TOOL_REGISTRY` `open_local_file` / `reveal_local_file` have `confirmationRequired: false` yet call `shell.openPath` / `shell.showItemInFolder` — inconsistent with the envelope's gated `open_in_daw`. (`electron/agentLoop.ts:151,174`)
3. **Raw path in a model-visible result.** `open_local_file` error returns `Path: ${file.file_path}` (absolute local path) into the model-visible message. (`electron/agentLoop.ts:161`)

P3-3 introduces envelope-gated, project-context-explicit, path-redacting deterministic tools for the read-only inspection surface; it does not rip out the legacy static tools (out of scope) but records them here.

## Capability matrix

Legend: **implemented** (safe, deterministic, shipped) · **partial** · **missing** · **unsafe** (works but violates a safety rule) · **server-blocked** (needs the Codex Project Link contract) · **live-E2E-blocked** (needs a real DAW round trip to verify).

| Capability | Status (base) | Status (after P3-3) | Evidence / notes |
|---|---|---|---|
| inspect current project | missing | **implemented** | new `inspect_project` — deterministic summary from explicit ctx |
| search files | implemented | implemented | `search_files` (envelope) — library-wide, offline |
| reveal file | unsafe | **implemented** | new `reveal_file` — confirmation-gated, path-redacted (basename only to model) |
| open file | unsafe | partial | legacy `open_in_daw` is gated + safe; legacy static `open_local_file` remains unsafe (documented, not this task's fix) |
| organize files | missing | missing | destructive; requires confirmation design — not in this task |
| tag files | missing | missing | not in this task |
| detect missing files | partial | **implemented** | surfaced via `inspect_project` + `inspect_package_completeness` + `explain_project_errors` |
| explain sync state | implemented | implemented | `inspect_sync_status` (envelope), offline |
| retry failed sync | implemented | implemented | `sync_project` (envelope), confirmation for large batches |
| inspect package completeness | missing | **implemented** | new `inspect_package_completeness` — roles present, unsynced, missing |
| inspect DAW compatibility | missing | **implemented** | new `inspect_daw_compatibility` — adapter capability report, deterministic |
| list versions | missing | **implemented** | new `list_local_versions` — `getVersionsByProject`, local |
| compare versions | missing | missing | needs a local diff surface — deferred (not in this task's 8) |
| list Project Links | server-blocked | server-blocked | authoritative `list-project-links` uncommitted in `wavio`; tool returns `server_contract_pending` |
| create Project Link | server-blocked | server-blocked | blocked tool returns `server_contract_pending` (no fabricated success) |
| revoke Project Link | server-blocked | server-blocked | blocked tool returns `server_contract_pending` |
| invite collaborator | server-blocked | server-blocked | blocked tool returns `server_contract_pending` (multiplayer) |
| inspect collaborator activity | server-blocked | server-blocked | blocked tool returns `server_contract_pending` (multiplayer) |
| restore version | live-E2E-blocked | live-E2E-blocked | restore path exists (`restore:start`) but assistant tool not added here; needs real DAW verify |
| Open in DAW | implemented | implemented | `open_in_daw` (envelope), confirmation-gated |
| publish version | implemented | implemented | `publish_version` (envelope, cloud), confirmation-gated |
| publish child version | server-blocked | server-blocked | contribution contract pending; blocked tool returns `server_contract_pending` |
| explain errors | partial | **implemented** | new `explain_project_errors` — classifies failed/permanent/missing rows |

## Typed honest states for blocked tools
`server_contract_pending` (Project Link listing/create/revoke, collaborator, child publish),
`authentication_required` (cloud tool without a session), `unsupported`, `not_implemented`.
Blocked tools return these in `CopilotToolResult.blockedReason` and NEVER a fabricated success.

## Dependencies still pending
- **Project Link reconciliation** — authoritative `list-project-links` + account identity, uncommitted in `wavio` (`feat/project-links-authoritative-reconciliation`, see `CODEX-TO-DESKTOP-project-link-reconciliation.md`).
- **Multiplayer** — collaborator invite/activity, contribution/child publish.
- **Live Ableton E2E** — restore + Open in DAW round trip verification on real hardware.
