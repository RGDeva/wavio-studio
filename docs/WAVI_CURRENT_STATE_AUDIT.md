# Wavi — Current State Audit

Date: 2026-07-01. Verified against live repository state, not prior reports.
Scope: `/Users/rishig/CascadeProjects/wavio` (web/API) and `/Users/rishig/CascadeProjects/wavio-studio` (desktop).

## 1. Repository state — wavio-studio

### Branches
| Branch | State |
|---|---|
| `feature/ableton-daw-companion` | **Checked out. The de-facto trunk.** All Project Links, restore, publish, QA-build work lives here. |
| `main` | **64 commits behind** the feature branch. Contains none of the last two months of work. |
| `fix/studio-sync-scalability` | 6 commits ahead of the feature branch (worktree `/private/tmp/wavio-studio-sync-fix`). Reviewed in `WAVI_SYNC_BRANCH_REVIEW.md`. |
| `feature/copilot-semantic-discovery` | Contains semantic-search + auto-grouping commits that were **reverted** on the trunk (`243517a3`, `e85fa1d4`), plus a safety-audit commit (`79290977`) stating the folder-count grouping heuristic must not ship. |

**Finding A1 (process risk):** `main` is stale. Everything that matters is on a feature branch whose name no longer describes its contents. A `main` fast-forward (or rename of the trunk) should happen before any new phase begins, or the next agent/collaborator will branch from a two-month-old base.

### Working tree
- Modified: `.gitignore`, `src/pages/Dashboard.tsx`
- Untracked: `src/components/ProjectDetail.tsx` (WIP project-detail screen, ~458 lines, not routed)
- Stash: `stash@{0}` "closeout: stash pre-existing ProjectDetail WIP" — previously verified byte-identical to the working-tree copies; safe but should be dropped or reconciled deliberately.

### Build configurations
- Production: `package.json` build block — `com.wavi.studio`, `wavi://` protocol.
- QA: `electron-builder.qa.json` — `stream.wavi.studio.qa`, `wavi-qa://`. **Deliberately** a different namespace (documented incident history in `main.ts`: shared Keychain namespace corrupted production credentials). Do not "normalize" this.
- QA base URL currently points at preview deployment `wavio-9t99dhvad` (`a97c230c`).
- Safety: `WAVI_USER_DATA_DIR` + `WAVI_QA_OVERRIDE=1` redirect userData; `assertNotProductionUserDataDir` hard-fails non-production builds writing to the production dir.

### Desktop architecture (verified)
- **Main process** (`electron/main.ts`, 2,406 lines): ~70 IPC handlers across auth, files, folders, projects, sync, share, project (links/publish), restore, association, memory, musehub, bounces, versions, settings, diagnostics, bridge, shell. Restore logic (`restore:start`, line ~1453) lives inline in main.ts, not a module.
- **DB** (`electron/db.ts`, 1,113 lines): better-sqlite3, WAL. Tables: projects, files, sync_queue, versions, bounce_candidates, association_queue, activity_log, restored_projects (+ migrations adding `local_status`, `reconciled_from`, `cloud_asset_id`, `desktop_id`, `cloud_version_id`, `parent_version_id` analogues). Application-level queue dedup (`enqueueSyncItemIdempotent`), startup repair (`repairStalledQueue`), terminal-row pruning.
- **Sync** (`electron/syncAgent.ts`): reviewed separately.
- **DAW logic** (`electron/ableton.ts`, 208 lines): folder scan → `DawSnapshot`, `.als` gzip-XML parse for BPM/key, file-role classification. **Publishing/manifest/pack logic is NOT here** — it is inline in `main.ts` (`project:publishVersion`) and in the web repo's pack builder. There is no adapter boundary today.
- **Copilot** (`electron/copilot.ts` overlay + `electron/agentLoop.ts`): a real tool registry already exists with 10 tools: `search_local_files`, `list_recent_files`, `open_local_file`, `reveal_local_file`, `reveal_project_folder`, `summarize_project_context`, `generate_midi_melody`, `generate_chord_progression`, `generate_drum_pattern`, `explain_import_to_fl_studio`.
- **Renderer**: 12 pages (Dashboard, Library, Search, Folders, FileReview, Ableton, StudioSync, Copilot, Activity, Diagnostics, Settings, Login) + RestoreWindow. Reviewed in the IA doc.
- Tests: 20 files / 349 passing on the sync branch; vitest config uses an explicit include list (new test files must be registered manually). better-sqlite3 ABI mismatch forces the mirror-test pattern (see sync review §6).

## 2. Repository state — wavio

### Branches / worktrees
- Checked out: `fix/seedbed-anon-share` at `9c7f95e`.
- **Uncommitted work in progress (not mine — active Codex territory):** `api/storage/index.ts`, `api/vault/index.ts`, `ShareSettingsPanel.tsx`, `PrivateSharePage.tsx`, `PublicProjectPage.tsx`, plus **new untracked migration `20260701163000_project_share_links.sql`** and `scripts/verify-playback.mjs`.
- ~16 Codex worktrees + ~13 Windsurf worktrees + `/tmp/wavio-demo-deploy` (prunable, detached). **Finding A2:** worktree sprawl is a real hazard — several sit on detached heads of old commits; any of them can silently hold work. Recommend a pruning pass (human-approved) before V2 work begins.
- Many parallel branches (`codex/*`, `cascade/*`) — the audit treats only `main`+checked-out branch as authoritative.

### API surface (verified, `api/`)
- `api/desktop/index.ts` — action router: `create-desktop-token`, `daw-sync`, `register-asset`, `get-project-files`, `publish-project-version`, `create-project-link`, `revoke-project-link`, `create-share-link`, `revoke-share-link`.
- `api/project-link/[token].ts` — public Project Link resolve + analytics + ZIP pack streaming (archiver v5, 60s max, exclusion patterns for temp/backup files). Distinct from `api/share/[trackingId]` (audio-stream oriented).
- `api/storage/index.ts` — presign/dedup (currently being modified by Codex).
- Others: share, seedbed, audio/secure, vault, stripe, roex, formless, email, paywall.

### Cloud schema (verified from `supabase/migrations/`)
Core project-model tables that exist today:
- `projects` + `daw_source`, `daw_snapshot JSONB`, `last_synced_at` (20260606), `desktop_id` (20260627)
- `project_versions` + `parent_version_id` (20260629100000) — **version ancestry already exists in schema**
- `assets` + `source`, `project_version_id` (20260629), audio delivery metadata (20260628)
- `project_collaborators`, `collaborator_invites`, `project_share_settings`, `project_share_unlocks`
- `wavi_link_events` (link analytics), `desktop_tokens`, `asset_versions`, `asset_comments`, `asset_events`
- Plans/limits: `user_plans`, `plan_limits`, `entitlements`, usage tables
- **Pending/uncommitted:** `project_share_links` — first-class multi-link model (slug, share_token, visibility private/unlisted/public/password, paywall fields, `selected_asset_ids`, `is_default`), explicitly designed to coexist with legacy `project_share_settings`.

**Finding A3 (architectural, important):** there are now **three link systems**: audio Listen Links (`share/[trackingId]` + `project_share_settings`), DAW Project Links (`project-link/[token]`), and the in-flight `project_share_links` multi-link model. They have separate tokens, separate analytics, separate revocation paths. The canonical model (see `WAVI_CANONICAL_PROJECT_MODEL.md` §5) must unify these behind one Link concept before a fourth appears.

## 3. What exists where (committed vs branch vs incomplete)

| Capability | Status | Location |
|---|---|---|
| Ableton detect/scan/publish | Committed | `feature/ableton-daw-companion` (trunk) |
| Immutable version manifests, Project Packs, `Ableton Project Info/` preservation | Committed | trunk + `wavio` main (`7af6e77`, `850a99e`, `ad69b6f4`) |
| Browser preview playback, correct WAV content-type | Committed | `wavio` main (`dee51f6`, `6afea0a`) |
| Deep links, restore, no-Temp-Project behavior, hash verification, duplicate-restore detection (4-option dialog) | Committed | trunk (`2a0afc30` etc.) |
| Production acceptance (create/play/restore/revoke) | Passed 2026-07-01 (isolated env) | session records; not re-run in this audit |
| Sync scalability (immediate refill, pause/resume, priority, folder protection) | **Feature branch only** | `fix/studio-sync-scalability` — 3 defects found, see review |
| Copilot semantic search / auto-grouping | **Reverted from trunk**; parked | `feature/copilot-semantic-discovery` (with a do-not-ship safety note on the grouping heuristic) |
| Project Detail screen | **Incomplete** | untracked `src/components/ProjectDetail.tsx`, not routed |
| Multi-link share model (web) | **Uncommitted WIP (Codex)** | `wavio` working tree |
| FL Studio | UI shell only (`FLStudioStatusPanel`), no adapter | — |
| `main` branch hygiene | **Stale by 64 commits** | both repos have trunk-on-feature-branch drift |

## 4. Cross-cutting risks

1. **Two agents, one web repo.** The uncommitted `wavio` changes overlap files the roadmap touches (`api/storage`, share pages). Coordinate via `docs/AGENT_COORDINATION.md` conventions before any wavio-side work.
2. **No adapter boundary.** Ableton logic is smeared across `ableton.ts`, `main.ts` (publish/restore), and `wavio`'s pack builder. Every new DAW multiplies this smear unless Phase 4 (adapter extraction) happens first.
3. **Link-model fragmentation** (Finding A3).
4. **Test-runner ABI constraint** shapes all desktop testing (mirror tests). Acceptable short-term; the real-process validation harness (sync review §7) is the compensating control and should be committed, not left in `/tmp`.
5. **Leaked-credential remediation is incomplete**: `.env.vercel-prod-temp` was removed from tracking (`9c7f95e`) but the exposed keys (Stripe, Supabase service role, Resend, RoEx, Replicate, Google OAuth, cron secret) have **not been rotated** — awaiting explicit authorization. This predates V2 planning but should gate any public beta.
