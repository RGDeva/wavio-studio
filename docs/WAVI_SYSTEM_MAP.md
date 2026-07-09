# Wavi System Map

Authoritative subsystem inventory, both repos, as of trunk `83b5a82e`
(2026-07-02). Cols: state = production-proven ✅ / merged-unproven 🟡 /
branch-held 🔶 / partial ⚠ / missing ✖. Worker = recommended model class
(see WAVI_MODEL_ROUTING). Deeper detail: WAVI_CURRENT_STATE_AUDIT.md.

| Subsystem | Purpose / current implementation | Key files | State | Tests | Risks | Next task → worker |
|---|---|---|---|---|---|---|
| Authentication | Privy JWT → `wv_` desktop token via deep link; safeStorage-encrypted at rest; sanitized auth logging | studio: main.ts (exchange/queue/replay), deepLinkValidator.ts; web: api/_lib/desktop-auth, privy-* | ✅ | auth.test, authLogging, deepLinkValidator (60+) | token lifetime/revocation UX; 401 handling is substring-based (S4) | structured error codes → Builder |
| Local database | better-sqlite3 WAL, single-writer main process; migrations CREATE-then-ALTER; queue repair incl. dangling-id pass; links registry | electron/db.ts (1.2k lines) | ✅ | heavy (real-sqlite + mirrors) | mirror-test drift (compensated by committed harness) | none urgent |
| Watcher | chokidar per-folder, stabilization, rename/move reconciliation, resolved-id enqueue (D5 fix), assoc engine debounce | electron/watcher.ts | ✅ | storm harness + unit | none known after D5 | — |
| Discovery | explicit-roots walk, skip-lists, sample-library classifier, folder-add confirmation contract | electron/discovery.ts, FoldersPage, folderAddFlow | ✅ | good | — | — |
| Synchronization | immediate-refill bounded scheduler, persistent pause, prioritize+failed-requeue, crash repair | electron/syncAgent.ts | ✅ (5k-file validated; real-library run clean) | 27+ | real-network throughput unmeasured (B-2) | WS-017 → Builder |
| Uploads | presign→PUT→register-asset w/ dedup, retries/backoff, cancellation | syncAgent.ts + web api/storage | ✅ | mocked+unit | wavio side under Codex churn | hold |
| Project association | classifier v1 + assoc engine + review queue UI | electron/projectAssociation/, classifier.ts, FileReviewPage | ✅ | 40+ | heuristic FPs → review queue mitigates | — |
| Project versions | local versions table; cloud project_versions (+parent_version_id); publish = manifest snapshot (doPublishVersion) | main.ts, web publish-project-version | ✅ | partial | manifest/compat columns from model Wave-1 not yet landed | WS-002 adjacent → Architect |
| Listen Links | asset share w/ trackingId, permissions, expiry, revoke; recorded in local links registry | main.ts share:*, web api/share/[trackingId] | ✅ | contract tests (web) | fragmentation (3 systems) | WS-002 → Architect |
| Project Links | immutable-version link, ZIP pack stream, resolve/restore, revoke | main.ts project:*, web api/project-link/[token] | ✅ (production-acceptance passed) | good | same fragmentation | WS-002 |
| Codex share analytics / multi-links | project_share_links table (additive, backfill, is_active, view_count, server label) + share pages rework | wavio (uncommitted + branches) | ⚠ in-flight (Codex) | theirs | coordination only | wait; WS-016 read-only prep → Builder |
| Public player pages | ListenPage, StandaloneTrackPage, PublicProjectPage, ProjectShare — duplicated logic | wavio src/pages | ⚠ duplication | thin | analytics double-emission risk; Phase E consolidation pending | WS-016 → Builder (after Codex) |
| Comments | asset_comments (web) | wavio | ✅ basic | thin | needs project/version-level attach (model Wave-1) | backlog |
| Downloads / paywalls | share settings gates, buyer grants, stripe | wavio api/paywall, stripe | ✅ | some | untouched this cycle | — |
| Analytics | wavi_link_events (listen/project) + Codex view_count | wavio | ⚠ split | thin | per-canonical-link query impossible until unified | WS-002/WS-014 |
| Restore | resolve→manifest→download→hash-verify→no-Temp-Project→duplicate detection (4-option) | main.ts restore:*, RestoreWindow | ✅ | restore.security + acceptance | logic still inline in main.ts (adapter dispatch owed) | WS-006 → Architect |
| Deep links | wavi[-qa|-dev]:// schemes, cold-launch queue, replay guards, second-instance forwarding | main.ts, deepLinkValidator | ✅ (two-process validated) | good | — | — |
| DAW launching | shell.openPath + per-DAW app pickers in Settings | main.ts, SettingsPage | ✅ basic | none | no adapter.launch dispatch yet | fold into WS-006 |
| Ableton support | detect/scan/.als parse/manifest-extras behind adapter (branch); pack/restore proven on trunk | electron/adapters/* (branch 5d8562ba), ableton.ts | 🔶 held branch / ✅ trunk behavior | 17 contract tests on branch | merge blocked on E2E | WS-006 → Architect |
| FL Studio support | UI shell only (FLStudioStatusPanel); exts recognized | — | ✖ | — | — | WS-007/008 |
| Pro Tools support | exts recognized only | — | ✖ | — | — | after FL |
| Copilot | overlay+page chat, 15-tool registry, envelope (validation/auth/out-of-band confirm/audit/containment), confirmation card, context w/ versionId | electron/agentLoop, copilotTools/, copilot.ts, CopilotPage, overlay | 🟡 merged, card visual unexercised live | 19 | LLM endpoint is wavio-hosted gpt-4o-mini (works only signed-in); "find X" intent routes to reveal | WS-010/011 → Builder |
| Audio intelligence | bpmDetector, audioAnalyzer, classifier; RoEx/audio-AI jobs web-side | electron/*, wavio api/roex, audio_ai | ✅ basic | some | — | backlog |
| Desktop navigation | Page-switch shell; Links page added; Detail panel; IA doc has remaining moves (Search→Library etc.) | App.tsx, Sidebar | 🟡 | route smoke only | Copilot page unreachable from sidebar (only overlay + Detail chip — chip nav bug seen in smoke) | WS-010 |
| Web navigation | marketing + vault + share pages | wavio | ✅ | — | Codex churn | hold |
| Build & release | vite+tsc, electron-builder prod/QA (identity-safe), validation harness committed | package.json, electron-builder.qa.json, scripts/validate-sync-scalability | ✅ | harness | notarization skipped locally | — |
| Security & secrets | safeStorage tokens, sanitized logs, no-token-in-audit envelope, path-validated restore | various | ⚠ | security.test 26 | **unrotated leaked keys (DR-011)**; CSP unsafe-eval warning in dev renderer | founder + backlog |
