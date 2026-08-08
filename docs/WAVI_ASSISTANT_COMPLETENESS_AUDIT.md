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

---

# P3-3 hardening pass — the three safety gaps (resolution)

Branch `feat/assistant-local-tools-foundation`. Status of the three audit findings:

## Finding 1 — implicit `projects[0]` project context → **RESOLVED**
- `electron/copilot.ts` `buildProjectContext(requestedProjectId)`: the `projects[0]`
  fallback is removed. With no explicit id the context is project-less; project-sensitive
  tools fail closed (`no_project_selected`). Evidence: `buildProjectContext` (~129).
- The active project is chosen **visibly** in the renderer (`CopilotPage` project `<select>`)
  and threaded to every `getContext`/`chat`/`confirmTool` call. No backend path silently picks
  a project. Stale switch is discarded by `resolveToolProjectContext` (`localTools.ts`).
- Tests: `assistantHardening.test.ts` (1),(2),(3),(9),(10); `localTools.test.ts` context suite.

## Finding 2 — file-opening tools bypassing the confirmation envelope → **RESOLVED**
- Removed the ungated static duplicates `open_local_file`, `reveal_local_file`,
  `reveal_project_folder` from `agentLoop.ts` `TOOL_REGISTRY`.
- The regex fast-path `tryLocalIntent` now routes "open"/"reveal" through the gated envelope
  tools `open_file` / `reveal_file`, propagating `needs_confirmation` as a confirmation card —
  neither model text nor user chat text can trigger an unconfirmed external launch.
- New project-scoped `open_file` (parallel to `reveal_file`): opaque-id resolution in main,
  confirmation-gated, path-free. One authoritative path per capability; no duplicate aliases.
- Tests: `assistantHardening.test.ts` (4),(5),(6),(7),(8),(13),(14); registry-list tests in
  `copilotTools.test.ts`.

## Finding 3 — raw absolute-path leakage from `open_local_file` (and elsewhere) → **RESOLVED**
- New pure `sanitizeToolResult` (`envelope.ts`) strips the `filePath` field and redacts
  absolute paths from `message`/`error`/`data`. Applied in `wrapTool` (every envelope tool at
  source), in `runAgentChat` (LLM + fast-path results), and in `copilot.ts` `runTool`/`confirmTool`
  (IPC boundary + the renderer-visible audit log, which now records only `outcome`, not the result).
- `search_local_files` returns safe metadata only (no `file_path` in `data`). `open_file`/`reveal_file`
  resolve the real path in main by opaque id and never return it. `open_in_daw`'s `filePath` is
  stripped by the sanitizer.
- Tests: `assistantHardening.test.ts` Gap-3 suite incl. (11) across every built tool and (12) errors;
  `localTools.test.ts` "no local tool result contains an absolute path".

## Registry consolidation
One authoritative, envelope-wrapped execution path per capability (open → `open_file`; reveal →
`reveal_file`; DAW open → `open_in_daw`). Static `TOOL_REGISTRY` retains only read-only/generative
tools (search/recent/midi/summaries/FL-explainer); no duplicate unsafe aliases (asserted by test 13).
All side-effecting tools share the same out-of-band confirmation gate and path sanitizer.

**Mergeability:** the three safety gaps are resolved; the branch remains unmerged pending Project
Link reconciliation (server-blocked tools still return `server_contract_pending`).

---

# LANDED — assistant foundation merged into development integration (2026-08-08)

`feat/assistant-local-tools-foundation` (`b0f37ae1`) merged into
`feature/ableton-daw-companion` as merge commit `f5a8d316`, on top of the landed P3-2c
Project Link reconciliation (`ec38ebba`). Development integration — **not** a production release.

- **Conflict:** exactly one, as predicted by the merge-readiness audit — `vitest.config.ts`
  `test.include` add/add — resolved as a **union** retaining every suite from both branches.
- **Merged-tree gate:** Node 22; electron + renderer tsc clean; **640/640 vitest across 40 files,
  0 skips** (543 base + 53 Project Link reconciliation + 44 assistant); production build;
  unsigned packaged app; `diff --check` clean; secret + absolute-path scans clean.
- **Invariants re-verified post-merge:** the three safety gaps stay closed (no implicit
  `projects[0]` — the only textual match is an explanatory comment, the code resolves to `null`;
  no ungated static open/reveal; `sanitizeToolResult` active at the envelope) AND the Project
  Link invariants survive the merge (endpoint exactly `/api/desktop` via the single builder;
  no legacy PL mutation path; Privy DID main-process-only behind the opaque handle).
- **Still blocked:** assistant Project Link tools continue to return `server_contract_pending`
  until **P3-3b** wires them to the now-merged `codexLinkContractAdapter` + `reconcileLink`.
  Multiplayer (collaborator invite/activity, child publish) and the live Ableton E2E gates
  remain open; recipient page / import token / contribution APIs remain excluded.
