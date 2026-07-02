# Wavi Execution Roadmap V2

Staged plan. Each phase lists: objective, user outcome, repos/files, schema/migrations, APIs, IPC, UI, tests, acceptance, dependencies, risks, complexity (S/M/L/XL), explicit not-yet, branch, worktree. Companion docs: `WAVI_SYNC_BRANCH_REVIEW.md`, `WAVI_CANONICAL_PROJECT_MODEL.md`, `WAVI_DAW_ADAPTER_ARCHITECTURE.md`, `WAVI_CROSS_DAW_PORTABLE_SESSION.md`, `WAVI_COPILOT_TOOL_ARCHITECTURE.md`, `WAVI_DESKTOP_INFORMATION_ARCHITECTURE.md`.

**Phase 0 (prerequisite hygiene, ½ day):** reconcile `main` with `feature/ableton-daw-companion` (Finding A1); reconcile/drop `stash@{0}` and the untracked ProjectDetail WIP (keep the file, commit it as WIP-flagged); prune dead worktrees (human-approved); rotate the leaked credentials before any public beta. No feature work.

---

## 1. Review & integrate sync-scalability work — ✅ EXECUTED 2026-07-02 (merge pending)
Status: D1–D4 fixed (`3ead68e6`, `79cddb1c`, `3e427c05`, `82c3fff8` + hardening `877403e6`), plus a fifth defect (D5, `d0501466`) found by the new watcher-storm validation: watcher enqueued with a never-persisted file id, defeating dedup on every rescan of an unsynced path — a second real contributor to the 4,511-item backlog. 379 tests green; 5,000-file, scheduler, watcher-storm, and two-process validations all pass (measured results in `WAVI_SYNC_BRANCH_REVIEW.md` §9). QA build clean, no source mutation, bundle id `stream.wavi.studio.qa` intact. Remaining before beta: run `scripts/validate-sync-scalability/real-network-test.js` with a user-supplied token; human smoke of the folder-confirmation dialog. Merge to the trunk branch is approved-pending-user (fast-forward; branch strictly ahead).
- **Objective:** fix review defects D1–D4, validate, merge `fix/studio-sync-scalability`.
- **User outcome:** app stays responsive and correct with 5,000+ files; pause/resume/Sync-This-Project work as labeled.
- **Repos/files:** wavio-studio — `src/pages/FoldersPage.tsx` (D1 dialog), `electron/main.ts` + `syncAgent.ts` (D2 persistence, D3 failed-row bump), commit `bench/` harness (D4).
- **Schema/migrations:** none. **APIs:** none. **IPC:** none new (behavioral fixes).
- **UI:** folder-confirmation dialog; pause copy "finishing current uploads".
- **Tests:** renderer/IPC test for confirmation flow; mirror tests for D2/D3; bench harness in repo.
- **Acceptance:** validation plan §7 of the review, items 2–6; all 349+ tests green.
- **Deps:** none. **Risks:** low — scoped fixes. **Complexity:** S.
- **Not yet:** per-item cancel UI, typed status union (S1), structured error codes (S4).
- **Branch:** continue `fix/studio-sync-scalability`. **Worktree:** `/tmp/wavio-studio-sync-fix` (existing).

## 2. Canonical project model
- **Objective:** land Wave-1 additive migrations + shared contracts (model doc §6).
- **User outcome:** none visible; every later phase gets a stable spine.
- **Repos/files:** wavio — new migration (`project_daw_representations`, `project_versions.manifest/compatibility/daw`, `project_version_dependencies`); wavio-studio — `electron/db.ts` ALTERs (`versions.parent_version_id`, `manifest_hash`); both — generated `contracts.ts` from `CROSS_REPO_CONTRACTS.md` types.
- **APIs:** `list-versions`, `get-version-manifest` actions in `api/desktop/index.ts`. **IPC:** none.
- **UI:** none. **Tests:** migration idempotency (both repos' existing patterns); contract type round-trip.
- **Acceptance:** existing publish/restore flows unchanged (regression suite); backfill row per project present.
- **Deps:** Phase 0; coordinate with Codex `project_share_links` WIP before touching wavio migrations. **Risks:** collision with Codex working tree — additive-only + separate migration files mitigates. **Complexity:** M.
- **Not yet:** link unification (Wave 2 — needs Codex migration landed), cloud Copilot memory.
- **Branch:** `feat/canonical-model-wave1` (each repo). **Worktree:** `/tmp/wavio-model-wave1`, `/tmp/wavio-studio-model-wave1`.

## 3. Desktop information architecture cleanup
- **Objective:** IA doc §6 steps 2–5: ProjectDetail routed, nav restructure, Links page, status language, empty states.
- **User outcome:** one obvious home per job; first persistent link-revocation UI; statuses humans understand.
- **Repos/files:** wavio-studio — `App.tsx` routing, `Sidebar.tsx`, `ProjectDetail.tsx` (finish), new `LinksPage.tsx`, merge SearchPage→LibraryPage, FoldersPage→Settings, FileReview→Home cards, `SyncStatusBadge` mapping.
- **Schema:** none. **APIs:** `list-links` (read path over existing link tables; pre-unification it aggregates the two legacy sources). **IPC:** `links:getAll`.
- **Tests:** routing smoke, links-list contract, status mapping unit tests.
- **Acceptance:** every action reachable in ≤2 clicks from nav; revoke works from Links page against production-shaped data; no internal vocabulary in default surfaces.
- **Deps:** Phase 1 merged (D1 dialog is part of Folders move). **Risks:** churn in Dashboard while it's also uncommitted-WIP — commit WIP first (Phase 0). **Complexity:** M–L.
- **Not yet:** visual restyle, Collaborate tab, onboarding beyond checklist v1.
- **Branch:** `feat/desktop-ia-v2`. **Worktree:** `/tmp/wavio-studio-ia-v2`.

## 4. Ableton adapter normalization
- **Objective:** extract existing Ableton logic behind the `DawAdapter` interface (adapter doc §2). Pure refactor.
- **User outcome:** none visible; unlocks FL/PT/Logic/REAPER as bounded work.
- **Repos/files:** wavio-studio — new `electron/adapters/{types,index,ableton}.ts`; carve publish from `main.ts:project:publishVersion`, restore from `main.ts:restore:start`; `discovery.ts` project-ext registry; export `cacheAndBackupPatterns` JSON consumed by wavio's `project-link/[token].ts` exclusions (kill the duplicated regex list).
- **Schema:** none. **APIs:** none. **IPC:** unchanged signatures.
- **Tests:** adapter contract suite + golden `.als` fixtures; pack→restore→hash round-trip; all existing restore tests must pass untouched.
- **Acceptance:** byte-identical manifests vs pre-refactor for fixture projects; production acceptance script re-run on QA build.
- **Deps:** Phases 1–2. **Risks:** regression in the one flow that's acceptance-tested — mitigated by golden manifests. **Complexity:** M.
- **Not yet:** plugin-dependency extraction (do it here only if trivial; else Phase 7), portable-session methods.
- **Branch:** `refactor/ableton-adapter`. **Worktree:** `/tmp/wavio-studio-ableton-adapter`.

## 5. FL Studio native Project Packs
- **Objective:** FL adapter — detect `.flp`, referenced-sample resolution, manifest, pack, restore, launch.
- **User outcome:** FL users publish versions and share/restore Project Links exactly like Ableton users.
- **Repos/files:** wavio-studio — `electron/adapters/flstudio.ts`, FL fixtures; wavio — none structural (packs are DAW-agnostic); `project_daw_representations` rows get `daw='fl_studio'`.
- **Schema:** none (Phase 2 covered it). **APIs:** none. **IPC:** none.
- **UI:** DAW badge, compatibility chip already generic from Phase 3/4.
- **Tests:** contract suite against FL fixtures; sample-path resolution matrix (absolute, relative, shared-library, missing).
- **Acceptance:** FL project publishes → link → restore on second machine/user-data dir → opens in FL with all samples found; hash verification passes; duplicate-restore detection works.
- **Deps:** Phase 4. **Risks:** `.flp` parse coverage (mitigate: required-file classification can fall back to whole-folder packing when parse confidence is low, with a visible warning). **Complexity:** L.
- **Not yet:** FL plugin-chain extraction, portable-session export.
- **Branch:** `feat/fl-studio-adapter`. **Worktree:** `/tmp/wavio-studio-fl-adapter`.

## 6. Pro Tools native Project Packs
- **Objective:** PT adapter — conventions-based (no deep `.ptx` parse): session root, `Audio Files/`, backup exclusions, manifest, pack, restore, launch.
- **User outcome:** send a Pro Tools session to a mix engineer as a Project Link.
- **Repos/files:** `electron/adapters/protools.ts` + fixtures. **Schema/APIs/IPC:** none.
- **Tests:** contract suite; restore-and-open acceptance (manual gate).
- **Acceptance:** PT session round-trips with all audio; `Session File Backups` excluded; opens without relink dialog for packed media.
- **Deps:** Phase 4 (not 5). **Risks:** closed format → metadata is thin (acceptable; set expectations in compatibility report). **Complexity:** M.
- **Not yet:** PT plugin extraction, `.ptx` parsing.
- **Branch:** `feat/pro-tools-adapter`. **Worktree:** `/tmp/wavio-studio-pt-adapter`.

## 7. Copilot project tools & metadata
- **Objective:** permission/confirmation/audit envelope + first five tools (`search_files`, `open_in_daw`, `inspect_sync_status`, `sync_project`, `publish_version`), context assembly, T0/T1/T2 routing.
- **User outcome:** "find that 140bpm idea from June and open it in Live" works; Copilot can safely publish with confirmation.
- **Repos/files:** wavio-studio — `agentLoop.ts` (envelope), `copilotTypes.ts` (context), new `electron/copilotTools/` per-tool modules, CopilotPage/overlay confirmation cards; wavio — none (uses existing desktop token + actions).
- **Schema:** none (audit rows go to existing `activity_log`). **APIs:** none new. **IPC:** `copilot:runTool` with schema validation.
- **Tests:** per-tool schema validation, permission-denial paths, confirmation-required enforcement (tool refuses without UI ack token), audit-row assertions.
- **Acceptance:** all five tools work offline-degraded as specced; no Conf-tool executes without explicit ack; every call visible in Activity.
- **Deps:** Phases 1–3 (uses fixed `prioritizeProject`, ProjectDetail chip). **Risks:** scope creep into the full catalog — the catalog doc exists precisely so this phase ships five. **Complexity:** L.
- **Not yet:** remaining catalog tools, semantic search revival (separate follow-up from the parked branch), cloud memory, T3/T4 routing.
- **Branch:** `feat/copilot-tools-v1`. **Worktree:** `/tmp/wavio-studio-copilot-v1`.

## 8. FL Studio → Ableton portable session
- **Objective:** the proof from the portable-session doc §4: FL export (stem-folder ingest + `.flp` MIDI/timing parse) → `session.json` → generated `.als`.
- **User outcome:** FL beatmaker sends a link; Ableton collaborator opens a playable, in-sync, partially-editable Live set with a fidelity report.
- **Repos/files:** wavio-studio — `portable-session/` schema+TS, `flstudio.exportPortableSession`, `ableton.importPortableSession`; wavio — link capability `portable_session` on resolve payload.
- **Schema:** unified-link `capabilities` (Wave 2 of model doc §5 — this phase forces it; coordinate with landed Codex migration). **APIs:** resolve returns available representations. **IPC:** `project:preparePortable`, restore-window branch.
- **Tests:** schema validation; beat-position round-trip; cross-correlation sync check vs reference mix on fixtures.
- **Acceptance:** doc §4 acceptance — 8-track FL fixture opens in Live in time with editable MIDI and honest fidelity report.
- **Deps:** Phases 4, 5; link Wave 2. **Risks:** highest technical risk on the roadmap (`.als` generation); mitigation: minimal Live Set template + audio-at-origin rule; fallback ship = Universal Pack. **Complexity:** XL.
- **Not yet:** automation, tempo maps, preset blobs, FL-native-plugin anything.
- **Branch:** `feat/portable-fl-to-ableton`. **Worktree:** `/tmp/wavio-studio-portable-v1`.

## 9. Ableton → FL Studio portable session
- **Objective:** reverse direction. Ableton export is easy (we parse `.als`); FL *import* is the unknown (writing `.flp`).
- **User outcome:** two-way FL↔Live collaboration.
- **Plan:** spike `.flp` generation first (1 week timebox); if impractical, ship as Portable Session consumed by an in-app FL import assistant (places files, builds a template with instructions) or Universal Pack. Honesty over fidelity theater.
- **Deps:** Phase 8. **Complexity:** L–XL depending on spike. **Branch:** `feat/portable-ableton-to-fl`.

## 10. Collaborator child-version publishing
- **Objective:** a restored project can publish back as a child version (`parent_version_id` ancestry already in schema; desktop `restored_projects` already tracks provenance).
- **User outcome:** collaborator edits a restored pack and publishes "v3 (from Alex)" into the same project; owner sees ancestry.
- **Repos/files:** wavio — `publish-child-version` action + RLS via `project_collaborators`; wavio-studio — publish flow branches on `restored_projects` provenance; ProjectDetail Versions tab shows ancestry tree. **Schema:** none. 
- **Tests:** permission matrix (view/comment/edit × publish attempt), ancestry integrity, RLS.
- **Acceptance:** full loop — owner shares edit link → collaborator restores, edits, publishes child → owner restores child.
- **Deps:** Phases 2, 3; Collaborate nav appears now (IA doc §2). **Risks:** permission edges (revoked link after restore — decide: provenance grants nothing; publishing requires live collaborator row). **Complexity:** L.
- **Branch:** `feat/child-versions`.

## 11. Version comparison & approval
- **Objective:** `compare_versions` (manifest+metadata diff) surfaced in ProjectDetail + approval state on child versions (owner approves → becomes head).
- **Schema:** `project_versions.approval_status` (additive). **Complexity:** M. **Deps:** Phase 10. **Branch:** `feat/version-compare-approval`.
- **Not yet:** audio-diff listening tools, DAW-level merge (never promise merge).

## 12. Open Sessions and later multiplayer
- **Objective:** design-only until Phases 1–11 are stable. Presence ("Alex is working on v4"), open-session links, then real-time. Explicitly out of scope for V2 execution; revisit with a dedicated design doc.

---

## Sequencing constraints
- 1 → 3 → (2 ∥ 4) → 5 → 7 is the critical path to the product wedge (FL Project Packs + usable IA + Copilot v1).
- 6 can run parallel to 7 (different files).
- 8 forces link Wave 2; do not start it before the Codex migration lands.
- Nothing after Phase 1 ships to beta until credential rotation (Phase 0) is done.
