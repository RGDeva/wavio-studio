# Sync-Scalability Validation Harness

Real-process validation for the sync engine (`fix/studio-sync-scalability`).
Everything here runs against **disposable data only**: generated fixture WAVs,
scratch SQLite databases, and scratch user-data directories. Nothing touches
the user's real music files or the production database.

All scripts default their scratch space to `$TMPDIR/wavi-validate/` (override
with `WAVI_VALIDATE_DIR`). Electron-run scripts execute the **actual compiled
modules** from `dist-electron/`, so run `npm run build:electron` first.

## Prerequisites

```bash
npm ci                       # once
npm run build:electron       # compile electron/*.ts → dist-electron/
node scripts/validate-sync-scalability/generate-fixtures.mjs 5000
```

For `two-process-test.js` the renderer build is not required (main-process
assertions only), but `dist-electron/` must exist.

## Scripts

| Script | Runs via | What it proves |
|---|---|---|
| `generate-fixtures.mjs <count> [dir]` | node | Creates N tiny, valid, hash-unique WAVs in project-like folders |
| `benchmark-main.js` | `npx electron` | 5,000-file db-open / discovery / serial-import / rescan timings; unchanged-file requeue count; duplicate active-queue groups (headless, real db.js + discovery.js) |
| `scheduler-test.js` | `npx electron` | **Mocked-network** scheduler behavior with the real compiled SyncAgent: drain throughput, immediate slot refill, selected-project prioritization latency, pause/resume mid-drain. *These numbers are scheduler benchmarks — NOT real upload performance.* |
| `watcher-storm-test.js` | `npx electron` | Real WatcherManager against real filesystem events: create/modify/rename/move/delete, rapid save bursts, DAW-style temp-then-atomic-rename; asserts no duplicate active jobs, no unchanged-file requeue, rename/move reconciliation, Backup/ exclusion |
| `two-process-test.js` | node (spawns 2 full Electron apps) | Single-instance lock: second process exits, first survives as sole DB writer; `wavi-dev://open-project` argv from the blocked second launch is forwarded to the primary (observed in `~/.wavi/main.log`); DB passes `PRAGMA integrity_check` afterwards |
| `db-integrity-check.js` | `npx electron` (helper) | Opens a db path read-only-ish and prints integrity_check + WAL state |
| `real-network-test.js` | `npx electron` | **Real fetch** against real API endpoints with a small (default 10) disposable file set. Requires `WAVI_AUTH_TOKEN` (and optionally `WAVI_API_BASE_URL`). Measures actual upload concurrency, slot-refill gap, retries, and realistic items/sec. Skips with instructions when no token is provided. Never run this with 5,000 files. |

## Typical full run

```bash
V=scripts/validate-sync-scalability
node $V/generate-fixtures.mjs 5000
npx electron $V/benchmark-main.js
npx electron $V/scheduler-test.js
npx electron $V/watcher-storm-test.js
node $V/two-process-test.js
WAVI_AUTH_TOKEN=wv_... npx electron $V/real-network-test.js   # optional, uploads ~10 tiny files
```

Each script prints a single `*_RESULT_JSON:{...}` line for machine parsing and
exits non-zero on assertion failure.

## Interpreting throughput numbers

`scheduler-test.js` mocks `global.fetch` to resolve instantly. Its items/sec
figure measures **scheduler overhead only** (how fast freed slots refill). It
regression-guards the poll-gated-refill bug (~0.4 items/sec cap at concurrency
2 / 5s poll). Real upload throughput is bounded by network and server latency:
expect roughly `maxConcurrent / mean_upload_seconds` from
`real-network-test.js`. Never quote the mocked number as product performance.
