# Wavi Canonical Project Model

The single conceptual model every subsystem (desktop, web, API, Copilot, links, adapters) maps onto. Design constraint: **no destructive rewrite** — every entity below maps to something that already exists, plus a small number of additive migrations.

## 1. The model

```
WaviProject (persistent identity)
├── ownership: owner, collaborators[role], permissions
├── representations: DawRepresentation[]        ← one per DAW the project exists in
│     └── daw, projectFilePath, adapterVersion, compatibility
├── versions: ProjectVersion[] (immutable)
│     ├── parent_version_id  → ancestry DAG (fork/child versions)
│     ├── manifest: ManifestEntry[] {relative_path, hash, size, required|optional, role}
│     ├── preview_bounce → Asset
│     └── created_by, daw, notes
├── assets: Asset[] (cloud objects: bounce, stems, samples, MIDI, artwork)
├── local state (desktop only): files[], sync_status, missing[], watch roots
├── dependencies: PluginDependency[] {name, vendor, version, format, substitutable}
├── metadata: bpm, key, time_sig, genre, tags, notes, artwork
├── social: comments[], activity[]
├── links: Link[] (unified — see §5)
└── copilot_memory: scoped notes/preferences keyed to project id
```

Identity rule: **one `WaviProject` = one creative work**, not one DAW file. A project can hold an Ableton representation and later an FL representation; versions record which DAW produced them. The desktop-side `projects.desktop_id` ↔ cloud `projects.id` pairing already implements the identity bridge.

## 2. Mapping to existing Supabase tables

| Model concept | Existing table/column | Gap → additive migration |
|---|---|---|
| WaviProject | `projects` (+`desktop_id`, `daw_source`, `daw_snapshot`, `last_synced_at`) | `daw_source` is singular → new `project_daw_representations` table; keep `daw_source` as denormalized primary |
| Versions + ancestry | `project_versions` (+`parent_version_id` ✅ already exists) | add `manifest JSONB`, `daw`, `created_by` if not present; verify manifest storage location (currently in pack flow) |
| Assets | `assets` (+`source`, `project_version_id`, delivery metadata) | add `role` enum (bounce/stem/sample/midi/artwork/other) — partially expressed via `asset_types` expansion (20260613110000) |
| Collaborators/permissions | `project_collaborators`, `collaborator_invites`, collab RLS (20260612150000) | add `role` granularity check vs Link `collaboratorMode` (view/comment/edit) — align enums |
| Comments | `asset_comments` | add nullable `project_id`/`version_id` so comments can attach above asset level |
| Activity | `asset_events`, `wavi_link_events`, `contact_activity` | new thin `project_activity` view (not table) unioning existing event tables |
| Plugin dependencies | — (only inside `daw_snapshot` JSONB, unstructured) | new `project_version_dependencies` table, written at publish time by adapters |
| Links | `project_share_settings` (legacy), `project_share_links` (in-flight), project-link tokens | §5 |
| Copilot memory | desktop `memory` table only (local) | new cloud `project_memory` later; **not** in the first migration wave |
| Compatibility info | `daw_snapshot` JSONB ad hoc | `project_versions.compatibility JSONB` written by adapter `validate()` |

## 3. Mapping to local SQLite (desktop)

| Model concept | Existing table | Gap |
|---|---|---|
| Project | `projects` (+`cloud_id`, `cloud_version_id`, `desktop_id`, `daw_type`) | none structural; rename-in-place of `daw_type` semantics when representations land (keep column) |
| Local files | `files` (+`local_status`, `reconciled_from`, `cloud_asset_id`, checksum, role) | none |
| Versions | `versions` | add `parent_version_id`, `manifest_hash` |
| Sync state | `sync_queue`, `activity_log` | none (post sync-branch) |
| Restored provenance | `restored_projects` (share_id, source version, collaborator_permission, parent link) | this is the seed of child-version publishing — keep |
| Copilot memory | `memory` | none |

## 4. Mapping to TypeScript / API / IPC / UI

- **Types:** today `src/types.ts` (desktop) and wavio's types are parallel and drift. Create `shared` type package or, cheaper, a generated `contracts.ts` checked into both repos from one source (extend `docs/CROSS_REPO_CONTRACTS.md` into code). First candidates: `ProjectVersion`, `ManifestEntry`, `Link`, `SyncStatus`, `Compatibility`.
- **API routes:** the `api/desktop/index.ts` action router already speaks project-version language (`publish-project-version`, `register-asset`, `get-project-files`, link CRUD). Additions: `list-versions`, `get-version-manifest`, `publish-child-version` (uses `parent_version_id`), `list-links` (unified).
- **IPC:** existing `project:*`, `versions:getByProject`, `restore:*` map cleanly. Additions per roadmap phase, not up front.
- **UI:** the untracked `ProjectDetail.tsx` becomes the canonical-project screen (see IA doc). `Dashboard` rows, `RestoreWindow`, `StudioSyncPage` already consume the right entities.

## 5. Unifying the three link systems (Finding A3)

Today: Listen Links (`project_share_settings` + `share/[trackingId]`), Project Links (`project-link/[token]`), and the in-flight multi-link `project_share_links`. Unification concept:

**A Link = (project_id, optional version_id, audience, capabilities, token).** Capabilities: `listen`, `download`, `restore_pack`, `comment`, `edit-intent`. A Listen Link is a Link with `{listen[,download]}`; a Project Link is a Link with `{listen, restore_pack}`.

Pragmatic path (no rewrite):
1. Let the Codex `project_share_links` migration land — it is the right storage shape (per-link row, visibility, token, selected assets).
2. Additive columns on `project_share_links`: `kind TEXT CHECK (kind IN ('listen','project'))`, `project_version_id UUID NULL`, `capabilities TEXT[]`.
3. New rows only; legacy `project_share_settings` and existing project-link tokens keep resolving through their current routes (compat window ≥ 2 releases).
4. Backfill script maps existing project-link tokens into `project_share_links(kind='project')`; resolvers check the new table first, fall back to legacy.
5. `wavi_link_events` gains `link_id` referencing the unified table; old rows untouched.

**Coordination note:** step 1–2 must be negotiated with the Codex workstream that owns the uncommitted migration — do not modify their WIP; propose the two additive columns as a follow-up migration.

## 6. Migration plan (incremental, compatible)

Wave 1 (with Phase 2 of the roadmap — no behavior change):
- `project_daw_representations(project_id, daw, project_file_relpath, adapter_version, created_at)` + backfill one row per project from `daw_source`.
- `project_versions.manifest JSONB`, `.compatibility JSONB`, `.daw` — backfilled lazily on next publish.
- `project_version_dependencies` (empty until adapters emit).
- Desktop: `versions.parent_version_id`, `versions.manifest_hash` (ALTER-with-catch pattern already used in db.ts).

Wave 2 (with link unification): §5 steps 2–5.

Wave 3 (with collaborator child versions): `publish-child-version` API + desktop `restored_projects` → publish path; no schema change (ancestry column already exists).

Explicit non-goals for now: cloud Copilot memory, cross-DAW representation auto-creation, comment threading redesign, any destructive rename.

## 7. Invariants (enforced in code review from now on)

1. Versions are immutable; corrections create child versions.
2. Every published version has a manifest with hashes; restore verifies required hashes (already true for Ableton — keep true for every adapter).
3. Cloud never learns absolute local paths (privacy invariant from the sessionPath removal — extend to adapters).
4. A project's identity never changes across DAWs, versions, or links.
5. New link types are rows in the unified table, never new tables/routes.
