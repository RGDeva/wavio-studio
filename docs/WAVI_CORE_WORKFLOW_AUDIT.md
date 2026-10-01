# Wavi core workflow — current-state audit (2026-09-30)

Scope: the basic product loop only — local project → discover → organize → sync → Project Link →
recipient opens → same-DAW native / cross-DAW portable → work returns as a child version.

**Explicitly out of scope for this milestone** (not blockers): Ableton control, Ableton MCP, voice
control, DAW overlay/screen understanding, plugin parameter control, AI mixing/mastering, beat
generation, sample search, live DAW state, simultaneous multiplayer, remote DAW control.

Everything below is from source, tests and live endpoint probes — not from prior milestone labels.

---

## 1. Workflow map

### Local
| Step | State | Evidence |
|---|---|---|
| Watched folders (add/remove/exclude/rescan) | **PASS** | `folders:*` IPC (10 handlers), `watchedFolders` store |
| Folder scan + DAW project detection | **PASS** (Logic defect fixed 2026-09-30) | `discovery.ts`; driven over real Ableton trees. **`.logicx` was broken**: absent from `AUDIO_EXTS` so a Logic project was never found, and absent from the bundle skip list so the walk recursed INSIDE the package and indexed `Song.logicx/Media/take1.wav` as loose user audio. It was also missing from `KNOWN_DAW_PROJECT_EXTENSIONS`, so a Logic folder counted zero project files and could be misread as a sample library. Package projects are now recorded as one project and never descended into |
| Sample-library guard before import | **PASS** | `classifyFolderForImport` — name + ratio heuristic, never count alone |
| Project association + ambiguous review | **PASS** | `association:getPending/confirm/reject/undo`, `association_queue` |
| Rename / move reconciliation, missing state | **PASS** | `files.local_status`, `reconciled_from`, `pending-resync.test.ts` |
| Local DB (projects/files/versions) | **PASS** | real-schema integration suite |

### Sync
| Step | State | Evidence |
|---|---|---|
| Hash before enqueue, duplicate prevention | **PASS** | `versionExistsByChecksum`, unique index on `(project_id, checksum)` |
| Upload queue + retry gate | **PASS** | `sync_queue`, `next_retry_at`, `max_retries` |
| Resumable upload columns | **PARTIAL** | `upload_offset`/`upload_url` exist and now round-trip in tests; actual resume path runs in the main process and is unproven without Electron |
| Canonical project / version on server | **PASS** | `doPublishVersion`, `publish-project-version` live |

### Share
| Step | State | Evidence |
|---|---|---|
| Project Link create / list / revoke / reconcile | **PASS** | `projectLinks:*`, `projectLinkService.ts`; fresh-install blocker fixed 2026-09-30 |
| Permissions, expiry, revoked states | **PASS** | honest state model in `linksView` |

### Receive
| Step | State | Evidence |
|---|---|---|
| Deep link `wavi://open-project` | **PASS** | `queueOrHandleDeepLink`, duplicate-suppression, `deepLinkValidator` |
| Resolve token → manifest | **PASS** | `restore:resolve` → `resolve-project-link`, **live on production** (handler 404 for a fake token; a bogus action 401s, so resolve is handled before auth exactly as the server source states) |
| Download + extract + hash verify | **PASS** | `restore:start`; zip-slip validation repaired 2026-09-30 |
| Register as a local Wavi project | **WAS MISSING → implemented this branch** | see §3 |

### Open
| Step | State | Evidence |
|---|---|---|
| Same-DAW open of restored project | **PARTIAL** | `RestoreWindow` calls `shell.openPath` (OS handler), which works for any registered extension. But `shell:openWithApp` — the configured-DAW path — requires `requireIndexed`, which restored files failed until adoption |
| Per-DAW "Open in <DAW>" surface | **PASS (2026-09-30)** | thin adapters added for FL Studio, Logic, Pro Tools and Reaper — all five target DAWs now report `sameDawOpen: true`, and `daw:getCapabilities` resolves the installed application bundle by name prefix (versions/editions vary: "FL Studio 2024.app", "Ableton Live 12 Suite.app") |
| Cross-DAW portable handoff | **MISSING** | `crossDawReconstruct: false` and `fidelityReport: false` on **every** adapter; no `project.dawproject`, `wavi/session.json` or `wavi/fidelity.json` is produced or consumed anywhere in `electron/` or `src/` — those names appear only in `docs/` |

### Return
| Step | State | Evidence |
|---|---|---|
| Detect collaborator's edits | **WAS MISSING → implemented** | restored folder is now watched |
| Publish as child version | **WAS BLOCKED → unblocked** | `publishContributionAuthoritative` needs a `projects` row with `cloud_id` + synced `files`; a restored checkout had none |
| Lineage preserved (parent → child) | **PASS (now reachable)** | `restored_projects.parent_version_id`, and adoption writes `cloud_version_id` as the parent |

---

## 2. Blocker table

| Flow | State | Blocker | Repo owner | Next implementation |
|---|---|---|---|---|
| Local discovery | PASS | — | desktop | — |
| Auto organization | PASS | — | desktop | — |
| Upload | PARTIAL | resume path unprovable headlessly | desktop | manual check on a working Mac |
| Download | PASS | — | desktop/server | — |
| Version publish | PASS | — | desktop | — |
| Version restore | PASS | — | desktop | — |
| Project Link create | PASS | fresh-install defect fixed | desktop | — |
| Project Link receive | PASS | — | desktop/server | — |
| Desktop import (adopt locally) | **FIXED this branch** | was the top blocker | desktop | UI affordance (below) |
| Same-DAW launch | **PASS** | — | desktop | — |
| Cross-DAW handoff | **MISSING** | no portable package exists in code | desktop | build the package per DR-015 (reuse DAWproject; do **not** invent a second session schema) |
| Return child version | **UNBLOCKED this branch** | adoption was the dependency | desktop | surface "Publish changes back" in the UI |

### Not a blocker, but wrong
`electron-builder.staging.json` points at `wavi-staging-kvbq16xd5-…`, where `resolve-project-link`
returns *"Unknown or missing X-Desktop-Action"* — the action is simply not on that deployment.
Production has it. The staging QA build would fail to receive a link; the baked URL needs
repointing before any staging smoke is believed.

---

## 3. What this branch implemented

`electron/restoreAdoption.ts` — a pure planner that turns a restored checkout into a real local
project, plus wiring in `restore:start`.

Before: restore wrote one `restored_projects` row and stopped. Change detection never saw the
restored folder, so the collaborator's edits were invisible; and
`publishContributionAuthoritative()` requires a `projects` row with `cloud_id` plus `files` rows
that are synced with a `cloud_asset_id`, so returning work was structurally impossible, not merely
unwired.

After: adoption writes the `projects` and `files` rows, starts watching the restored directory, and
carries the canonical ids across — `cloud_id = sourceProjectId`, `cloud_version_id =
sourceVersionId` — so a later publish is a **child of the version received**, never an overwrite.

Rules the planner enforces (all tested):
- Fails closed with no parent version, so a return can never be mistaken for a new root version.
- Refuses a project file outside the restored directory; skips assets that resolve outside it
  rather than indexing them (an indexed path is trusted by `requireIndexed` callers).
- Contribution rights only for the `comment` mode (`contributionAllowedForRole`); legacy `edit`,
  `owner`, `contribute`, empty and unknown all fail closed to read-only.
- A view-only checkout is still adopted — it just cannot publish. Adoption and contribution are
  separate decisions.
- Adoption failure never fails the restore: the restore already succeeded, so it is logged and
  reported, not thrown.
- Files are adopted as `pending`, not `synced` — the collaborator's own edits genuinely are not
  uploaded yet, and the normal sync pipeline handles them.

---

## 4. Manual live validation (needs a Mac where Electron runs)

ENV-1 blocks Electron execution here, so the following is prepared rather than performed. Do not
record any of it as passed until it is actually run.

1. Repoint `electron-builder.staging.json` at a deployment that serves `resolve-project-link`.
2. Creator machine: add a folder with a DAW project → confirm detection, association, sync, and
   **Publish Version**.
3. Create a Project Link with `comment` permission and download allowed. Copy the URL.
4. Recipient machine (separate OS user or QA build): open the link in a browser → confirm the
   recipient page renders, states the source DAW, and offers "Open in Wavi Studio".
5. Click it → `wavi://open-project` → RestoreWindow resolves and shows name/version/DAW/size.
6. Restore to a fresh directory. Watch progress reach `verify_complete` → `restore_complete`.
7. **New:** confirm the restored project now appears in the local project list, and that its folder
   is in watched folders.
8. Open the native project (same DAW) and make a trivial change; save.
9. Confirm Wavi detects the change and the project goes to `pending`/`changed`.
10. Sync, then publish — confirm it lands as a **child** of the received version, and that the
    parent version is unchanged on the server.
11. Repeat 5–7 with a `view` link and confirm no publish affordance appears.
12. Confirm hash table of the restored directory matches the sender's originals.

---

## 5. Honest limits

- Cross-DAW handoff does not exist. Nothing in the app produces or reads a portable package, and
  every adapter reports `crossDawReconstruct: false`. The compatibility UI is honest about this —
  it never claims a capability that is not implemented — so the gap is visible to users rather than
  faked, but it is the single largest missing piece of the stated milestone.
- Only Ableton has a real adapter. The other four DAWs are indexed and restorable but advertise no
  same-DAW open.
- Nothing in this branch was executed inside Electron. The planner and DB effects are proven
  headlessly against the real schema; the IPC wiring is compile-checked and reviewed, not run.
