# Principal-Engineer Review — `fix/studio-sync-scalability`

Date: 2026-07-01, updated 2026-07-02 after the remediation pass. Worktree `/private/tmp/wavio-studio-sync-fix`; original commits `ad4fa8ea..0c7168d8`, remediation commits `3ead68e6..7657ad1d` (13 total on top of `feature/ableton-daw-companion`). 379 tests pass; `tsc --noEmit` clean (renderer + electron configs).

**Verdict (updated): SAFE TO MERGE**, with two explicitly-tracked residuals: (1) the limited real-network test is written but unexecuted — it needs a user-supplied `WAVI_AUTH_TOKEN` (automated credential lookup was correctly refused by policy); (2) human smoke of the D1 confirmation dialog in the running QA app (the flow logic is unit-tested; the rendered dialog is not). Neither blocks the merge itself; run the network test before the next beta build.

**Remediation status:** D1–D4 below are FIXED and validated. The validation harness also surfaced a fifth, previously unknown defect (D5, fixed): the watcher enqueued with a pre-generated file id that the path-keyed upsert never persisted, so every rescan of an already-indexed, not-yet-synced path defeated file_id-keyed dedup and grew the queue (measured: +21 rows on a 22-file folder re-add; 0 after the fix). This is a second real-world contributor to the ~4,511-item backlog alongside the poll-gated refill cap, and `repairStalledQueue` gained a startup pass that prunes the dangling-id duplicates the old bug left in real user databases. Section 7's measured results are appended at the end.

## 1. What the branch gets right

- **Root cause is real and correctly fixed.** The old `_tick()` was only invoked from a 5s `setInterval`; with `MAX_CONCURRENT=2` this hard-caps drain at ~0.4 items/s regardless of network. The fix (refill from each item's `.finally()`, poll timer demoted to safety net) is the right shape. Re-entrancy is safe: the selection loop (`getPendingSyncItems` → `activeUploads.add`) runs synchronously with no interleaving `await`, and the `activeUploads.has(item.id)` guard covers the DB-status lag window before `processItem` marks a row `uploading`.
- **Bounded concurrency** (`setMaxConcurrent`, clamped 1–8) including a genuine bug the new tests caught: `Math.floor(n) || DEFAULT` treated `0` as falsy; fixed to explicit clamping.
- **Cancellation** threads a real `AbortController` per item through `fetchWithTimeout`; aborted items land in a distinct terminal `cancelled` status (already handled by DB pruning), not misclassified as retry/failure.
- **Pause semantics** correctly separate `user` from `auth`/`limit`; `resumeUser()` cannot clear an auth or plan-limit block.
- **Queue dedup was already correct** — the branch proves it (rescan growth 0, duplicate groups 0 at 5,000 files) rather than re-fixing it.
- **Deep-link fix is real:** the `second-instance` argv filter previously dropped `://open-project` links from a blocked second launch.
- **Folder protection** heuristics are sound: vendor-name match OR (≥200 audio, 0 DAW project files); a project file always defeats the sample-library classification; never file-count-alone.

## 2. Defects found (all fixed — original findings kept for the record)

Fixes: D1 `3ead68e6`, D2 `79cddb1c`, D3 `3e427c05`, hardening `877403e6`, D4 `82c3fff8`, D5 `d0501466`, tests `7657ad1d`. D3's shipped semantics: pending/retrying → HIGH_PRIORITY; transient failures → requeued at HIGH_PRIORITY with retry state cleared; permanent (401/403/404/INVALID_TOKEN/PLAN_LIMIT/permission/not-found) and missing-file rows stay blocked and are reported to the UI; >25 retryable failures requires explicit user confirmation before committing network usage.

**D1 — BLOCKER. FoldersPage ignores the confirmation contract.** `folders:add`/`folders:addPath` now return `{needsConfirmation, classification}` and *do not add the folder*, but `src/pages/FoldersPage.tsx:98-113` still treats the result as fire-and-forget. Net behavior: a user adds their Splice folder → main process classifies it, returns `needsConfirmation:true` → **UI shows nothing, folder is silently not added.** No component anywhere calls `folders:confirmAmbiguous`. This is a functional regression versus trunk (where the add succeeded). Fix: confirmation dialog in FoldersPage (and any other add path) wired to `confirmAmbiguous`.

**D2 — Pause does not survive restart.** `pauseUser()` sets in-memory `pausedReason` only; nothing persists it (`main.ts` startup restores `maxConcurrent` from the store but not paused state). A user who pauses sync and relaunches gets silent full-speed uploading — precisely the trust-destroying behavior the pause feature exists to prevent. Fix: persist `syncPausedByUser` in the store; restore before `syncAgent.start()`.

**D3 — "Sync This Project" is a no-op for failed projects.** `Dashboard.tsx:545` shows the button for `sync_status ∈ {pending, failed}`, but `bumpProjectPriority` only updates rows with `status IN ('pending','retrying')`. A fully-failed project has no such rows → the click does nothing, with a spinner that implies it worked. Fix: `prioritizeProject` should first reset that project's `failed` rows to `pending` (scoped, not global `retryFailed`) and then bump.

**D4 — Test integrity gap.** `syncScalability.test.ts` tests *SQL mirrors* and a *pure-JS `MirrorScheduler` replica*, not the real `db.ts`/`syncAgent.ts` (forced by the better-sqlite3 Electron-ABI constraint; consistent with the repo's existing convention). Mirrors drift. The compensating control — the headless-Electron harness that runs the **real compiled SyncAgent** (`benchmark-main.js`, `throughput-test.js`) — lives uncommitted in `/tmp/wavi-sync-bench/`. Fix: commit the harness under `bench/` with a `package.json` script, and state in the test file which assertions are mirror-level.

## 3. Secondary findings (fix in fast-follow, not blocking)

- **S1:** `getStatus()` string `paused:user` etc. is a stringly-typed contract consumed by tray + renderer; fine for now, should become a typed union when the IA work lands.
- **S2:** Pause does not abort in-flight uploads (by design — they complete). Acceptable, but the UI copy should say "finishing current uploads."
- **S3:** `cancelItem` only reaches in-flight items; a pending row cannot be cancelled from the UI. Acceptable for now since nothing exposes per-item cancel yet.
- **S4:** `processItem`'s 401/402 detection is substring matching on error messages; brittle. Carry a structured error code from `fetchWithTimeout`.
- **S5:** `sync:now` calls `retryFailed()` globally — a tray click resets *all* failed rows. Pre-existing behavior, but interacts oddly with D3's fix; revisit together.

## 4. Benchmark honesty

The advertised 0.53 → ~885–935 items/s is a **scheduler benchmark with instant mocked network**. It proves exactly one thing (and does prove it): slot refill no longer waits for the poll interval. It says nothing about real cloud throughput, which will be bounded by presign+PUT+confirm latency and the 1–8 concurrency cap. Realistic expectation for real uploads: throughput ≈ `maxConcurrent / mean_upload_latency`; the fix removes up to ~5s of dead time per slot per item (which at concurrency 2 was the dominant term — the ~4,511-item backlog draining at ~0.4/s ≈ 3+ hours of pure scheduler idle). Treat the mocked number as a regression guard, never a marketing number.

## 5. Areas audited with no findings

Scheduler correctness/races (§1), SQLite transaction safety (single-writer main process; WAL; `repairStalledQueue` window-function dedup is atomic enough under one writer), retry state machine (`next_retry_at` gate + in-memory timer belt-and-suspenders), renderer IPC frequency (unchanged by branch), Settings integration (`maxConcurrent` persisted and applied at startup and on change), single-instance lock usage (correct API; untested at OS level — see §7).

## 6. Test-gap matrix

Covered (real SQLite, arm64 binary): 5,000-file enqueue, restart-no-requeue, duplicate insertion, crash-recovery dedup, priority bump isolation, missing/rename/move reconciliation. Covered (mirror only): immediate refill, bounded concurrency, pause/resume, cancel, clamping. Covered (real class, uncommitted harness): end-to-end drain throughput. **Not covered anywhere:** two real process launches, real WAL contention from a second process, watcher-event storms, renderer TTI under load, D1's confirmation UI flow.

## 7. Real validation plan (pre-merge gate + post-merge soak)

All against a disposable `WAVI_USER_DATA_DIR`; mock uploads by default; never the production DB or real music files.

1. **Fixture library:** existing generator → 5,000 WAVs in ~625 folders + 3 sample-library-named folders + 1 ambiguous folder.
2. **Scheduler determinism (mocked uploads):** committed `throughput-test.js` at queue sizes 100/1,000/5,000; assert linear drain, zero duplicate rows, zero requeues.
3. **Real Electron app, cold start:** packaged QA build against the fixture dir. Measure: time to window, time to interactive (first Dashboard paint with data), discovery duration, db-open, startup CPU (sample `ps` at 1Hz for 120s), steady-state CPU at 5 min, RSS at start/5min, queue size at start and +5min, unchanged-files-requeued (must be 0).
4. **Watcher reality:** while running, script 200 file creates + 50 modifies + 20 renames + 10 deletes into watched folders; assert queue grows only for real changes, renames reconcile without re-upload, deletes mark missing.
5. **Two-instance test:** launch the binary twice against the same userData; assert second exits, first receives argv, and a `wavi://open-project/...` in the second launch reaches the renderer. Then `kill -9` the first mid-upload and relaunch; assert `repairStalledQueue` recovers zombies and WAL replays clean.
6. **Selected-project latency:** with 5,000 pending, click Sync This Project on a 10-file project; measure time until its 10 items complete vs backlog (target: < 10 × mean upload time + 2s). Repeat on a *failed* project (regression test for D3).
7. **Limited real uploads:** 50 real files ≤1MB against a QA/preview API on a throttled network (Network Link Conditioner, 1 Mbps up): verify retry/backoff on injected 500s, auth-pause on token revocation, resume, cancellation mid-PUT.
8. **UI under load:** with 5,000 queued, interact with Library/Search/Dashboard; input latency subjectively <100ms and no unbounded re-render (React profiler spot check).

## 8. Merge sequencing

1. ✅ Fix D1, D2, D3 on the branch with tests.
2. ✅ Commit the harness (D4) — `scripts/validate-sync-scalability/` (fixtures generator, 5,000-file benchmark, mocked scheduler test, watcher-storm, two-process, limited real-network, db-integrity helper, README).
3. ✅ Run the mocked/real-process validations; results below.
4. Merge to `feature/ableton-daw-companion` (fast-forward-safe; branch is strictly ahead). Then run `real-network-test.js` with a user-supplied token against the QA build.
5. Only then fast-forward/reconcile `main` (audit Finding A1).

## 9. Measured validation results (2026-07-02, all disposable data)

- **Full suite:** 21 files / 379 tests pass; `tsc` clean; QA build (`Wavi Studio QA.app`, `stream.wavi.studio.qa`, `wavi-qa://`) builds signed with zero source-file mutation (git status clean post-build).
- **5,000-file benchmark** (real db.js/discovery.js, headless Electron): db-open 18.8ms · discovery walk 33.8ms · serial import (hash+upsert+enqueue) 2.80s · rescan of 5,000 unchanged files 1.79s with **queue growth 0** · duplicate active groups **0** · RSS 86.6→120.2MB.
- **Mocked scheduler test** (real compiled SyncAgent, instant fetch): 510-item drain in 228ms (~2,237 items/s — **scheduler overhead only, NOT upload performance**); "Sync This Project" on 10 items enqueued behind a 500-item backlog completed in **7ms** vs 228ms total (selected-first confirmed); pause froze the queue at 54 remaining across the pause window, resume drained fully.
- **Watcher storm** (real WatcherManager, real fs events): 20 creates indexed once · Backup/ ignored · 10-write save burst → 1 row · `.tmp`-then-atomic-rename → 0 temp artifacts, promoted file indexed once · rename and move reconciled in place (`local_status=present`, same row id) · delete marked missing · duplicate active groups 0 · **folder re-add queue growth 0** (was +21 before the D5 fix).
- **Two-process test** (full app ×2, one disposable `WAVI_USER_DATA_DIR`): second instance exited (code 0), first stayed alive as sole writer, `wavi-dev://open-project` argv from the blocked second launch was forwarded (observed `open-project-deep-link` in the main log), `PRAGMA integrity_check` ok, WAL mode confirmed.
- **Limited real-network test:** script committed; SKIPPED this run — requires a user-supplied `WAVI_AUTH_TOKEN` (uploads ~10 tiny disposable WAVs; measures real concurrency, refill gap, retries, throttling). This is the one number set still owed: real items/sec ≈ `maxConcurrent / mean_upload_latency`; the mocked figure must never be quoted as product performance.
