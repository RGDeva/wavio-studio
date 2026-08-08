# Wavi Desktop — Phase 3 Execution Plan
## Interoperable Project Links · Multiplayer v1 · Project-Aware Assistant · UI/UX Refinement

Status: **Execution specification (planning pass — no Phase 3 features implemented yet)**
Date: 2026-07-09 · Repo: `wavio-studio` (desktop lane) · Base: `feature/ableton-daw-companion` @ `7d193021`

This is the authoritative desktop execution document for the next milestone. It supersedes
ad-hoc planning for the desktop lane; the Ableton reference milestone's live gates remain
open (see Risk Ledger).

### Authority order
1. verified code, tests, and behavior
2. `docs/WAVI_DECISION_REGISTER.md`
3. DR-015 / approved DAWproject Option B
4. current architecture and contracts (`docs/WAVI_DAW_ADAPTER_ARCHITECTURE.md`, `docs/handoffs/*`)
5. this Phase 3 plan
6. older strategy documents

### Canonical portable-session structure (DR-015 — BINDING, do NOT create a second schema)
- `project.dawproject` (transferable musical truth)
- original native DAW project (highest-fidelity same-DAW open)
- `wavi/session.json` (identity, versions, branches, authors, permissions, provenance, links, asset refs)
- `wavi/fidelity.json` (preserved / approximated / rendered / metadata-only / missing / unsupported)
- referenced stems, MIDI, renders, dependencies, artwork, hashes
All adapters target the Session IR; no pairwise converters; hand-written TS; no Java runtime.

### Documentation gap (recorded, not invented)
The two broader planning docs referenced by the request are **NOT committed to this repo**:
`docs/WAVI_DESKTOP_PRODUCT_EXPERIENCE_AND_INTEROPERABILITY_EXECUTION_PLAN.md` and
`docs/WAVI_DAW_INTEROPERABILITY_SHARED_WORKSPACE_PLAN.md` are ABSENT (they exist only as
external attachments seen in prior sessions). **Action:** commit those two documents to
`docs/` so this plan can cite them normatively. Until then, this plan relies on verified
code + the decision register + `docs/WAVI_ABLETON_E2E_RUNBOOK.md` +
`docs/WAVI_FL_STUDIO_API_MCP_AUDIT.md` + `docs/handoffs/CODEX-HANDOFF-recipient-and-projectpack-contracts.md`
+ `tasks/backlog/MILESTONE_DEFERRED_AND_BLOCKERS.md`.

---

## 1. Current-state feature matrix

Legend: ✅ implemented+tested · 🟡 partial · ⭕ missing · 🔒 blocked-by-web-contract · 🧪 blocked-by-live-E2E

| Capability | State | Evidence / gap |
|---|---|---|
| Node-22 test harness, isolated Node-ABI SQLite | ✅ | 493 tests / 0 skips; `electron/test-native/` |
| `wavi-media://` secure local playback | ✅ | `electron/mediaProtocol*.ts`; real-Electron E2E 10/10 |
| DAW adapter contract (Ableton) | ✅ | `electron/adapters/*`; contract suite 24/24; DR-015-aligned |
| Adapter `capabilities()` + `locateProjectFile` | ✅ | WS-006 step1+2 |
| Project Detail: compatibility card | ✅ | `daw:getCapabilities` + `compatibilityView.ts` |
| Project Detail: at-a-glance summary | ✅ | `deriveProjectSummary` (§6.2) |
| Folder watching + project detection | ✅ | `watcher.ts`, `discovery.ts`, adapter detection |
| Immutable version publish | 🟡 / 🧪 | `project:publishVersion` exists; live publish unverified (auth) |
| Project Link create/revoke | 🟡 / 🧪 / 🔒 | `project:createLink`/`revokeLink` + local `links` table; **server-authoritative** persistence + recipient page are web-owned |
| Restore (download → hash verify → safe extract → open) | 🟡 / 🧪 | `restore:*` handlers + `restore.security` 37/37; live round trip unproven |
| Deep-link import (`wavi://open-project`) | 🟡 | handler wired; end-to-end unproven live |
| Assistant deterministic tools | 🟡 | 5 tools only (search/open/inspect-sync/sync/publish) |
| Assistant confirmation gating | ✅ | envelope; open_in_daw + publish gated; model can't self-confirm |
| Collaborators / roles / presence | ⭕ / 🔒 | no `project_members`/presence tables; `collaboratorMode` string only |
| Child-version contribution return | ⭕ / 🧪 / 🔒 | `restored_projects` records parent context; publish-child path unproven; contract gap |
| Timestamped audio comments | ⭕ | none |
| Design-token system / component library | ⭕ | raw `white/opacity` utilities; no shadcn-style tokens |
| Loading/empty/error/offline states (systematic) | 🟡 | ad-hoc per screen; not a shared pattern |
| FL adapter | ⭕ | audited only (`WAVI_FL_STUDIO_API_MCP_AUDIT.md`); WS-007/008 not started |
| Cross-DAW reconstruction | ⭕ | WS-023..026 spikes; not started |

---

## 2. Component & UI audit (desktop vs. web reference)

### Web reference (`wavio`, read-only) — design foundation to adopt
- **Tokens:** shadcn/ui HSL CSS variables — `--background 210 25% 97%`, `--foreground 212 45% 10%`,
  **`--primary 187 92% 81%` (cyan)**, `--secondary 212 40% 11%`, `--destructive 15 75% 54%`,
  `--border 210 20% 88%`, radius scale `--radius .625rem` (sm .375 / lg .875 / xl 1 / 2xl 1.25).
- **Type:** `Jura` (sans/heading/body) + `JetBrains Mono`.
- **Primitives to reuse (restrained):** button, card, dialog, dropdown-menu, input, select, tabs,
  tooltip, badge, skeleton, table, separator, sonner/toast, sidebar, progress, avatar, scroll-area.
- **Audio primitives worth porting conceptually:** `WaveformSeekbar`, `waveform-visualizer`,
  `premium-audio-player` (but desktop plays via `wavi-media://`, not web URLs).
- **Explicitly REJECT for the app UI** (present in web but marketing-only): `shader-animation`,
  `shader-lines`, `gradient-mesh`, `sparkles`, `dotted-surface`, `3d-folder`, `3d-marquee`,
  `macbook-scroll`, `moving-border`, `vinyl-disc`, `--shadow-glow-intense`. No decorative 3D/glow.

### Desktop current state (`wavio-studio`)
- **13 pages:** AbletonPage, ActivityPage, CopilotPage, Dashboard, DiagnosticsPage, FileReviewPage,
  FoldersPage, LibraryPage, LinksPage, LoginPage, SearchPage, SettingsPage, StudioSyncPage.
- **10 components:** BounceConfirmModal, BridgeStatusPanel, DawLogo, ErrorBoundary,
  FLStudioStatusPanel, ProjectDetail, RestoreWindow, Sidebar, SyncStatusBadge, TitleBar.
- **Styling:** dark theme via raw utility opacity (`text-white/40`, `bg-white/[0.03]`), cyan-500
  accent, `rounded-lg`. **No semantic token layer, no shared primitives.**

### Audit findings
| Finding | Severity | Detail |
|---|---|---|
| No design-token system | P1 | hardcoded `white/opacity`; no light/dark var layer; inconsistent contrast |
| No shared component library | P1 | each screen re-implements buttons/cards/badges/dialogs |
| Inconsistent radius / spacing | P2 | mix of `rounded-lg`/`rounded-full`; ad-hoc padding |
| No systematic state coverage | P1 | loading/empty/error/offline/permission-denied not uniform |
| Low-contrast text | P2 | `text-white/20`–`/30` for meaningful labels fails contrast |
| Duplicate status patterns | P2 | SyncStatusBadge vs inline status strings |
| Font mismatch with web | P3 | desktop not using Jura/JetBrains Mono |
| No screenshot baseline | P1 | must capture before any redesign |
| Assistant panel clutter risk | P2 | CopilotPage must show project context + tool cards, not generic chat |

**Principle:** clean, restrained, precise, professional, music-workflow-focused. No generic
AI-dashboard look, no excessive gradients/glass, no decorative 3D that reduces clarity, no giant
empty hero areas, no inconsistent pills, no random icon treatments, no low-contrast text, no
over-animated controls. Purposeful depth only for project layers / versions / package completeness
/ compatibility / transfer state.

---

## 3. Assistant tool audit matrix

Current envelope (`electron/copilotTools/envelope.ts`) is sound: typed validation, auth gate for
cloud tools, **out-of-band confirmation (model cannot self-confirm)**, sanitized audit logging,
failure containment (never throws). Only **5 tools** exist today.

Legend: ✅ implemented · 🟡 partial · ⭕ missing · ⚠️ unsafe-if-added-without-gate · 🔒 web-contract · 🧪 live-E2E

| Required tool | State | Notes / gate |
|---|---|---|
| inspect_project | ⭕ | add read-only project inspector |
| search_files | ✅ | read-only |
| reveal_files | ⭕ | maps to `shell:revealInFinder`; read-only-ish |
| open_files | 🟡 | `open_in_daw` exists (gated ✅); generic open-file missing |
| organize/tag files | ⭕ | needs file mutation → **confirm** |
| detect_missing_files | ⭕ | read-only (uses `local_status`) |
| detect_missing_dependencies | ⭕ / 🔒 | dependency scan partial; plugin scan not implemented |
| explain_sync_state | ✅ | `inspect_sync_status` |
| retry_failed_sync | 🟡 | `sync_project` (dynamic large-retry confirm ✅) |
| inspect_package_completeness | ⭕ | maps to `deriveProjectSummary` |
| inspect_daw_compatibility | ⭕ | maps to `daw:getCapabilities` |
| list_versions | ⭕ | `versions` table exists |
| compare_versions | ⭕ | needs diff surface |
| publish_checkpoint / publish_version | ✅ | cloud, gated ✅, 🧪 live-unverified |
| create_project_link | ⭕ / 🔒 | **confirm** + web-authoritative persistence |
| copy_project_link | ⭕ | read-only (clipboard) |
| list_project_links | ⭕ / 🔒 | needs authoritative server listing |
| revoke_project_link | ⭕ | **confirm** (destructive) |
| invite_collaborator | ⭕ / 🔒 | **confirm** + web contract |
| inspect_collaborator_activity | ⭕ / 🔒 | web contract |
| restore_version | ⭕ | **confirm** (restore-over) |
| open_in_daw | ✅ | gated ✅ |
| publish_child_version | ⭕ / 🧪 / 🔒 | **confirm** + parentage contract |
| explain_errors | 🟡 | partial via tool error messages |

**Requirements for the registry (P3-3):** project context always visible; deterministic tools
(no model improvisation); progress + result cards; model can never self-confirm; explicit
confirmation for external/destructive/permission-changing/publishing/sharing/revoking/restoring/
inviting; read-only tools do NOT prompt; auth/offline failures explained; auditable; no fabricated
success; no raw local paths to renderer/model unnecessarily (reuse the `wavi-media://` opaque-id
discipline for any asset reference).

---

## 4. Multiplayer v1 — data & event model proposal

Multiplayer v1 is **checkpoint-based → branch-aware → conflict-safe → real-time presence/review**,
NOT live DAW-state sync. No arbitrary plugin/mixer/arrangement synchronization this phase.

### Desktop-local tables (SQLite) — additive, no canonical cloud state duplicated
- `collaborators(project_id, user_id, role, display_name, invited_by, joined_at)` — cache of the
  server-authoritative membership (source of truth = web).
- `presence_local(project_id, user_id, state{editing|reviewing|offline}, daw, branch, updated_at)`
  — ephemeral; hydrated from the realtime channel; never the source of truth.
- `comments(id, project_id, version_id, author_id, ts_seconds, body, created_at)` — timestamped
  audio comments (mirror of server).
- `edit_claims(project_id, user_id, claimed_at, expires_at)` — soft-lock advisory only.
- reuse existing `versions` (add `parent_version_id`, `branch_id`, `author_id` if absent) and
  `activity_log`.

### Realtime events (consumed by desktop; produced by web/realtime)
`workspace.member.joined/left` · `workspace.presence.updated` · `workspace.version.published` ·
`workspace.comment.created` · `workspace.checkpoint.created` · `workspace.contribution.submitted` ·
`workspace.contribution.reviewed` · `workspace.editclaim.changed` · `workspace.playback.updated`
(live-review).

### Behaviors
- presence + "who has it open" + activity feed (read-only surfaces first)
- publish checkpoint → branch; child-version contribution attached to original project
- compare/review changes; accept/reject a contribution (owner)
- **soft edit lock** + collision warning (advisory, never blocks local DAW work)
- live review session with synchronized master playback where feasible
- invitations + notifications; explicit ownership/provenance

**Web/backend dependencies** (Codex handoffs, not implemented here): membership persistence,
presence/realtime channel, comment storage, contribution review state, notifications.

---

## 5. Project Link desktop→web contract gaps

Source of truth: `docs/handoffs/CODEX-HANDOFF-recipient-and-projectpack-contracts.md`. Open gaps
blocking Workstream A live flow:

| # | Contract | Status | Desktop need |
|---|---|---|---|
| 1 | `resolve-project-link` manifest shape (paths == ZIP entries; sha256 = pre-upload; `Ableton Project Info/` entry) | VERIFY | restore correctness / no Temp Project |
| 2 | `GET /api/project-link/{token}/download` (auth assets only, safe paths, 200/403/410/404) | VERIFY | package download |
| 3 | revoke kills resolve **and** download | VERIFY | revocation denial gate |
| 4 | **project-style recipient page** (file sections, compatibility, Open-in-DAW / Download Pack / Open in Wavi Studio) | GAP | recipient UX |
| 5 | **short-lived import-token** issuance (`POST /api/share-links/{code}/import-token`) | GAP | Open-in-DAW hardening |
| 6 | **contribution submission** endpoint (`parentVersionId` + contributor + permission gate) | GAP | child-version return |
| 7 | authoritative **link listing** for `list_project_links` | GAP | assistant + Links page reconciliation |
| 8 | collaborator roles / membership persistence | GAP | multiplayer v1 |

Action: expand the handoff packet with exact request/response/status for #4–#8; do not implement
web code here.

---

## 6. Implementation sequence — ordered task packets (P3-0 → P3-6)

Each packet is bounded, test-gated (Node 22, both tsc, full Vitest zero-skip, relevant
security/E2E, `git diff --check`, packaged build for Electron-runtime changes), and merged only
when green.

### P3-0 · State & contract audit  *(this document is the deliverable; ratify + fill gaps)*
- Ratify sections 1–5; commit the two absent broader docs; expand contract gaps #4–#8.

### P3-1 · Desktop design foundation
- `src/design/tokens.css` (shadcn-style HSL vars, dark-first + light variant; adopt web hues:
  cyan primary `187 92% 81%`, radius scale, Jura + JetBrains Mono).
- Primitives: `Button`, `Card`, `Input`, `Select`, `Menu/Dropdown`, `Dialog`, `Badge`,
  `Skeleton`, `Tooltip`, `Tabs`, `StatusBadge`, `EmptyState`, `ErrorState`, `OfflineBanner`.
- Application shell + Sidebar refresh. **Screenshot baseline first.**

### P3-2 · Project Detail & Project Links
- Clean Project Detail (contents / versions / dependencies / package completeness / compatibility).
- Authoritative link creation + listing + revocation (reconciled with server once #7 lands).
- Open in Wavi Studio + Open-in-DAW capability states (honest, from `capabilities()`).

### P3-3 · Assistant completeness
- Deterministic tool registry (fill the §3 matrix: inspect_project, reveal/open, missing files/deps,
  package completeness, compatibility, list/compare versions, link create/copy/list/revoke,
  restore, open_in_daw, publish_child, explain_errors).
- Project context always visible; confirmation system; tool-result cards; assistant E2E tests.

### P3-4 · Multiplayer v1
- collaborators/presence/soft-locks/activity/checkpoints/child-version/review/comments/live-playback
  (desktop-local tables + realtime consumption; server contracts via Codex).

### P3-5 · FL Studio native handoff *(only after Ableton adapter + Project Link flow stable)*
- FL detection, `.flp` packaging, dependency report, FL→FL native restore, Open in FL Studio,
  child-version return (WS-007/008 + adapter contract; offline path per `WAVI_FL_STUDIO_API_MCP_AUDIT.md`).
- Do NOT begin FL↔Ableton reconstruction in the same milestone.

### P3-6 · Cross-DAW reconstruction *(later, bounded)*
- FL→Ableton, Ableton→FL (Session IR / `.dawproject`, WS-023..026), then Pro Tools / Logic Project Pack.

---

## 7. P0 / P1 / P2 risk ledger

### P0 (release gates — remain OPEN / UNPROVEN; do not claim passed)
- **P3-2c status ladder (updated 2026-08-07):** server contract LOCKED (`wavio` @ d34d5218) ✅ ·
  local desktop behavior PROVEN (596 tests / 0 skips; endpoint `/api/desktop` via one builder;
  DID main-only; dedup + stale-session discard; create-outcome-unknown) ✅ · REAL SQLite
  `account_id` migration PROVEN ✅ · **authenticated isolated staging smoke PASSED** ✅
  (server SHA `a561dee6…`, deployment `dpl_E2HFE5xsYS7tTKwy23pJBHMxAeYC`, Supabase
  `qjhzrxgiomctzxdzywhu`, production untouched, server PL tests 19/19) ·
  **desktop MERGED into development integration** ✅ (merge `ec38ebba`) ·
  desktop→staging smoke: unauthenticated leg PASSED ✅ / **authenticated in-app leg PENDING
  (manual, interactive Privy sign-in)** ⏳ · **production deployment remains a SEPARATE gate** ⛔.
- Assistant Project Link tools remain **blocked pending P3-3b**; recipient page, import token,
  ZIP/Project Pack and contribution APIs remain **excluded**.
- Live **Project Link creation** against the server — 🧪 unproven (auth/visibility).
- **Same-DAW Ableton restore** end-to-end — 🧪 unproven.
- **No "Temp Project"** state after restore — 🧪 unproven live.
- **Revocation denial** (revoked link cannot resolve/download/import) — 🧪 unproven live.
- **Collaborator child-version return** attaches to original — 🧪/🔒 unproven + contract gap.
- **Original-version immutability** — 🧪 unproven live.
- Blocker: founder-attended or screen-visible disposable-project session (see
  `tasks/backlog/MILESTONE_DEFERRED_AND_BLOCKERS.md`).

### P1
- No design-token system / component library (blocks consistent UI + state coverage). — RESOLVED (P3-1a/b/c).
- Assistant tool set incomplete (only 5/24 required). — PARTLY RESOLVED (P3-3: local deterministic tools added; server/multiplayer tools remain blocked).
- Server contract gaps #4–#8 block Workstream A live flow.
- Two broader planning docs uncommitted (documentation gap).
- **Assistant safety gaps (P3-3 audit): RESOLVED** — implicit `projects[0]` context, confirmation-envelope bypass by static file-open/reveal tools, and raw-path leakage are all closed (explicit project selection + `sanitizeToolResult` + removal of ungated duplicates + gated `open_file`/`reveal_file`). No assistant safety blocker remains open on this branch.

### P2
- Low-contrast text / inconsistent radius+spacing.
- Duplicate status patterns; no screenshot baseline.
- Presence/comments schema not yet designed into migrations.

---

## 8. The exact first bounded implementation task

**P3-1a — Desktop design token foundation + screenshot baseline (no behavior change).**

Scope (single bounded packet, branch `feat/desktop-design-tokens`):
1. Capture a **screenshot baseline** of the 10 priority surfaces (shell, Home/Dashboard, Projects,
   Project Detail, Links, Versions, Activity, Assistant, Restore, Settings) — record method given
   the multi-Space capture limitation (per-window where possible).
2. Add `src/design/tokens.css` with shadcn-style semantic HSL variables (dark-first; adopt web
   hues: primary cyan `187 92% 81%`, `--radius .625rem` scale) and wire `tailwind.config` to them
   (`colors: { background, foreground, primary, … } = hsl(var(--…))`); add `Jura` + `JetBrains Mono`.
3. Introduce **two** primitives only — `Button` and `Badge`/`StatusBadge` — as the pattern, and
   refactor `SyncStatusBadge` + the Project Detail primary actions to use them (behavior-preserving).
4. Do **not** restyle all screens yet (that is P3-1b+). No token value reaches the renderer as a
   raw path; no new deps beyond dev-only if needed.

Gate: electron tsc, renderer tsc, full Vitest **zero skips** (expect 493+), `git diff --check`,
packaged build (renderer-only → optional). Deliverable: baseline screenshots + tokens + 2 primitives,
committed on the feature branch with a before/after note. **Do not proceed to P3-1b until reviewed.**

---

## 9. Phase 3 progress ledger (updated as packets land)

### P3-3 · Assistant completeness — **local tools landed** (`feat/assistant-local-tools-foundation`, off `feature/ableton-daw-companion@45795a81`)

Audit: `docs/WAVI_ASSISTANT_COMPLETENESS_AUDIT.md` (matrix for all 23 required capabilities).

**Implemented local assistant tools (deterministic, server-independent, envelope-gated):**
- `inspect_project`, `inspect_package_completeness`, `inspect_daw_compatibility`,
  `list_local_versions`, `explain_project_errors` — read-only, no confirmation.
- `reveal_file` — confirmation-gated (launches Finder), reveals by opaque id in main; no raw path to model.
- `search_files`, `inspect_sync_status`, `sync_project`, `publish_version` — pre-existing, retained.

**Project context:** every tool resolves an EXPLICIT project (`copilot:runTool`/`getContext` now take a
`requestedProjectId`; `buildProjectContext` resolves that project instead of silently `projects[0]`). A
tool whose targeted project no longer matches the active one returns `stale_project_switch` and is
discarded. The assistant UI shows the active project chip. Raw absolute paths are redacted to basenames
in every model-visible result (`redactPath`, verified by test).

**Confirmation:** the out-of-band envelope is preserved — a model-emitted `confirmed:true` is stripped;
only the renderer's confirmation card sets `confirmedOutOfBand`. Read-only tools need no confirmation.

**Server-blocked assistant tools** (return typed `blockedReason: server_contract_pending`, never a
fabricated success): `list_project_links`, `create_project_link`, `revoke_project_link`,
`invite_collaborator`, `inspect_collaborator_activity`, `publish_child_version`.

**Dependencies still pending for the blocked tools:**
- **Project Link reconciliation** — authoritative `list-project-links` + canonical account identity,
  uncommitted in `wavio` (`feat/project-links-authoritative-reconciliation`, `CODEX-TO-DESKTOP-…` note).
- **Multiplayer** — collaborator invite/activity + contribution/child publish (§4 event model).
- **Live Ableton E2E** — restore + Open-in-DAW round trip verification on real hardware (§7 P0 gates).

Tests: `electron/copilotTools/localTools.test.ts` (19) + `src/lib/assistantToolCard.test.ts` (9); existing
`copilotTools.test.ts` updated (not weakened) for the expanded registry.

---

*End of Phase 3 plan. Implementation progress is tracked in §9.*
