# Wavi Copilot — Tool Architecture

Copilot is a **permissioned tool layer over the canonical Wavi Project**, not a chatbot. Its value is that it can *see* project state (sync, versions, files, collaborators, compatibility) and *act* through the same audited paths the UI uses.

## 1. What exists and is reusable (audited)

- `electron/agentLoop.ts` — a working tool loop with `TOOL_REGISTRY` (10 tools: `search_local_files`, `list_recent_files`, `open_local_file`, `reveal_local_file`, `reveal_project_folder`, `summarize_project_context`, `generate_midi_melody`, `generate_chord_progression`, `generate_drum_pattern`, `explain_import_to_fl_studio`) + `runAgentChat`. **Reusable as the execution core**; needs the permission/confirmation/audit envelope below.
- `electron/copilot.ts` + `copilot-preload.ts` — overlay window plumbing. Reusable.
- `electron/copilotTypes.ts` — `ProjectContext`, `CloudProjectSnapshot`, `CloudVersion`, `CloudAsset`. Correct seed for the context object.
- `electron/midiTools.ts` — generation tools. Reusable unchanged.
- `feature/copilot-semantic-discovery` branch — date-aware semantic search was reverted from trunk; the *query understanding* is worth salvaging, the auto-grouping heuristic is flagged do-not-ship (`79290977`) and stays dead.
- Desktop `memory` table + IPC — Copilot memory store exists locally.

Missing: permission checks, confirmation gates, audit logging, cloud-side tools, model routing. That envelope is the actual work.

## 2. Project context (assembled per conversation turn, not per app boot)

```ts
interface CopilotContext {
  project?: { id, name, daw, cloudId, syncStatus, missingFiles: count, compatibility }
  version?: { id, number, parentId, publishedAt }
  currentTrack?: { fileId, name, role }        // if user opened one
  localFiles: summary (counts by role/status, recent N)
  cloudAssets: summary
  collaborators: [{ userId, role }]
  permissions: { canPublish, canLink, canInvite }  // derived from role + plan
  links: [{ id, kind, active, views }]
  pluginDependencies: [{ name, installed? }]
  recentActivity: last N events
  commentsUnresolved: count
}
```

Sources are all existing: local SQLite + `get-project-files` + diagnostics. Context is **capability-filtered**: a collaborator with view-only sees no revoke/invite affordances in tool space either.

## 3. Tool catalog

Legend — Perm: permission check · Conf: needs explicit user confirmation · Exec: local / cloud / both · Off: works offline.

| Tool | Input → Output (schema sketch) | Perm | Conf | Exec | Off | Failure behavior |
|---|---|---|---|---|---|---|
| `search_projects` | `{query, dawFilter?}` → `{projects[]}` | none (own library) | no | local | ✅ | empty list + suggestion |
| `search_files` | `{query, role?, bpmRange?, dateRange?}` → `{files[]}` | none | no | local | ✅ | empty list |
| `open_project` | `{projectId}` → `{opened}` | none | no | local | ✅ | error surfaced verbatim |
| `open_file` / `reveal_file` | `{fileId}` → `{ok}` | none | no | local | ✅ | "file missing" → offer `inspect_sync_status` |
| `open_in_daw` | `{projectId}` → `{launched, daw}` | none | no (launching an app is visible+reversible) | local | ✅ | adapter launch error |
| `create_project` | `{name, folderPath?}` → `{projectId}` | none | **yes** (creates folder/rows) | local | ✅ | rollback row on failure |
| `organize_project` | `{projectId, plan}` → `{moves[] proposed}` | none | **yes — always dry-run first**; file moves are the highest-risk local op | local | ✅ | never partial: apply moves transactionally with undo journal |
| `classify_stems` | `{projectId}` → `{classifications[]}` | none | apply=yes, suggest=no | local (classifier.ts) | ✅ | suggestions only on low confidence |
| `extract_metadata` | `{fileId|projectId}` → `{bpm,key,…}` | none | no | local (audioAnalyzer/bpmDetector) | ✅ | partial results OK |
| `inspect_sync_status` | `{projectId?}` → `{queue summary, failures[], missing[]}` | none | no | local | ✅ | — |
| `retry_sync` | `{projectId?}` → `{requeued}` | none | no (idempotent, bounded) | local | ✅ queues offline | — |
| `pause_sync` / resume | `{}` → `{status}` | none | no | local | ✅ | — |
| `sync_project` | `{projectId}` → `{prioritized}` | none | no | local | ✅ queues | uses fixed `prioritizeProject` (incl. failed-row reset, sync review D3) |
| `publish_version` | `{projectId, notes?}` → `{versionId, number}` | `canPublish` | **yes** (irreversible, creates immutable version) | both | ❌ | atomic: no version row without complete manifest |
| `create_project_link` | `{projectId, kind, capabilities, expiry?}` → `{url, linkId}` | `canLink` | **yes** (publishes access) | cloud | ❌ | none created on failure |
| `revoke_project_link` | `{linkId}` → `{revoked}` | `canLink` | **yes** (breaks recipients) | cloud | ❌ | idempotent |
| `invite_collaborator` | `{projectId, email, role}` → `{inviteId}` | owner | **yes** (sends external email) | cloud | ❌ | no email on failure |
| `inspect_compatibility` | `{projectId, targetDaw}` → `{report}` | none | no | local (adapter.validate) | ✅ | — |
| `prepare_native_pack` / `prepare_portable_pack` | `{versionId, targetDaw?}` → `{packPath, fidelityReport}` | `canPublish` | pack=no, share=separate tool | local | ✅ | temp-dir cleanup on failure |
| `summarize_project_activity` | `{projectId, since?}` → `{summary}` | none | no | both (degrades to local) | ✅ partial | — |
| `compare_versions` | `{versionA, versionB}` → `{added[], removed[], changed[], metadataDiff}` | none | no | both (manifests local if cached) | ✅ if cached | — |

**Universal rules:** every tool call is written to `activity_log` (actor=`copilot`, with the user prompt hash); every Conf=yes tool renders a native confirmation card in the overlay — the model cannot self-confirm; cloud tools carry the user's existing desktop token (no separate Copilot credential); all inputs validated with zod-style schemas before dispatch (extend the pattern `agentLoop.ts` already uses for tool args).

## 4. Model routing

| Tier | Handles | Examples |
|---|---|---|
| **T0 — deterministic, no model** | exact-match commands, direct tool invocations from UI chips | "pause sync", "open Project X" when unambiguous |
| **T1 — small/local or low-cost model** | intent classification, query parsing to `search_files` filters, single-tool routing | "that trap beat from June" → date+role filter |
| **T2 — frontier cloud model** | multi-step plans, `organize_project` proposals, version-diff narration, compatibility explanations | Claude API (key already in Settings for semantic-search work) |
| **T3 — audio analysis services** | stem splitting, mastering analysis (RoEx exists), key/BPM beyond local detectors | existing `roex`/audio-AI job routes |
| **T4 — screen/computer assistance** | *not shipped*; design slot only. If ever used: separate opt-in, never routed implicitly | — |

Routing: T0 bypasses models entirely (fast path from overlay). T1 attempts first with a strict function-call schema; escalates to T2 on low confidence or multi-tool plans. Offline: T0/T1-local tools work; T2+ degrade with an explicit "offline — showing local results only" state.

## 5. First five tools to ship

`search_files`, `open_in_daw`, `inspect_sync_status`, `sync_project`, `publish_version` — because the first four are pure wiring over existing code (highest value per line), and `publish_version` exercises the full permission/confirmation/audit envelope early, which is the part that must be right before the catalog grows.
