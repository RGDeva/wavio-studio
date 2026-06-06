# Wavi Studio — Phase 3 Plan: Audio Fingerprinting & Duplicate Detection

## Goal
Extend the Association Engine with acoustic similarity signals so it can detect
duplicate exports, alternate masters, and re-used loops — without any filesystem
changes and requiring explicit user confirmation for every action.

---

## 1. Audio Fingerprinting Pipeline

### 1a. Chromaprint / fpcalc integration
- Ship `fpcalc` (static binary) bundled in `resources/bin/fpcalc` for macOS / Win.
- Add `electron/audioFingerprint.ts`:
  - `generateFingerprint(filePath): Promise<{ fingerprint: string; duration: number }>`
  - Spawns `fpcalc -json <file>`, parses stdout.
  - Returns `null` on non-audio files or spawn errors.
- Write to `files.audio_fingerprint` (column already in schema) via
  `updateFileClassification` or a new `updateAudioFingerprint(fileId, fp)`.
- Wire into `handleDependencyFile` in `watcher.ts` after BPM/key detection —
  only for `wav`, `mp3`, `flac`, `aif`, `aiff`, `ogg`, `m4a` extensions.
- Cap fingerprint generation to files ≤ 300 MB; skip silently otherwise.

### 1b. AcoustID lookup (optional, network-gated)
- If the user enables "Cloud lookup" in Settings, POST the fingerprint to
  `api.acoustid.org/v2/lookup` and cache the returned `recordingId` in a new
  `files.acoustid_id` column.
- Gate behind a settings flag `acoustid_lookup_enabled` (default off) — never
  make network calls without user opt-in.

---

## 2. Duplicate Detection

### 2a. Exact-duplicate detection (same fingerprint)
- After fingerprinting, query:
  ```sql
  SELECT id, file_path FROM files
  WHERE audio_fingerprint = ?
    AND id != ?
  LIMIT 10
  ```
- If matches exist → create an `association_queue` entry with:
  - `relationship = 'duplicate_of'`
  - `confidence = 0.95`
  - `signals = { exactFingerprint: true, fileCount: N }`
- The user sees "These files appear to be identical exports" in File Review.

### 2b. Near-duplicate detection (high cosine similarity)
- Parse the raw Chromaprint integer array.
- Compute bit-distance between fingerprints stored in the DB.
- Group pairs with Hamming distance < 5% of total bits → `confidence = 0.75–0.90`.
- Only run pairwise comparison within the same folder cluster (already grouped by
  Phase 2 signals) to bound O(n²) cost.

### 2c. Deduplication UI action
- Add a "Mark as duplicate" resolve action to `FileReviewPage` alongside confirm/
  reject/defer.
- Confirmed duplicates write `asset_associations` with `relationship = 'duplicate_of'`
  and set a `files.is_duplicate` flag (new column, migration-guarded).
- **Never delete files** — only tag metadata.

---

## 3. Loop / Sample Reuse Detection

- After fingerprinting stems, compute sub-sequence fingerprint windows (30-second
  overlapping slices).
- Store slice hashes in a new `file_fingerprint_slices` table:
  ```sql
  CREATE TABLE file_fingerprint_slices (
    file_id TEXT REFERENCES files(id),
    offset_sec REAL,
    slice_hash TEXT
  );
  ```
- Match slice hashes across files → surface as `relationship = 'reference_for'`
  with signal `{ loopReuse: true, offsetSec: N }`.
- Present in File Review as "This sample appears in X other projects."

---

## 4. Similarity-Boosted Grouping (Engine Enhancement)

Extend `projectAssociationEngine.ts` `scoreGroup()`:

| New signal | Weight | Condition |
|---|---|---|
| `exactFingerprint` | +0.40 | two files share identical fingerprint |
| `nearDuplicate` | +0.25 | Hamming distance < 5% |
| `loopReuse` | +0.15 | slice hash match across projects |

These stack with existing Phase 2 signals (folder, token, timestamp, role).

---

## 5. Performance Safeguards

- Fingerprinting runs in a **worker thread** (`worker_threads`) to avoid blocking
  the main process during large batch imports.
- Queue depth cap: process at most 20 fingerprints per watcher cycle; remainder
  deferred to next idle tick.
- `files.audio_fingerprint IS NULL` index for efficient un-fingerprinted file
  queries.
- Fingerprint generation is skipped if `classification_version` already encodes
  fingerprint presence (new bit flag in version integer).

---

## 6. Schema Migrations (migration-guarded)

```sql
ALTER TABLE files ADD COLUMN audio_fingerprint TEXT;   -- already exists
ALTER TABLE files ADD COLUMN acoustid_id TEXT;
ALTER TABLE files ADD COLUMN is_duplicate INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS file_fingerprint_slices (
  id       TEXT PRIMARY KEY,
  file_id  TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  offset_sec REAL NOT NULL,
  slice_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slice_hash ON file_fingerprint_slices(slice_hash);
```

---

## 7. Testing Plan

| Test | Coverage |
|---|---|
| `fingerprint.test.ts` | fpcalc spawn mock, duration parsing, error handling |
| `duplicate.test.ts` | exact match → queue entry, near-match threshold |
| `sliceHash.test.ts` | slice window computation, hash collision check |
| Engine integration | fingerprint signal boosts confidence past auto-confirm |
| UI | File Review shows "identical export" badge for `duplicate_of` items |

All tests use the existing pure-JS mock DB pattern from Phase 2 — no native
modules in the test runtime.

---

## 8. Forbidden Actions (carry-forward)

- Do not move, rename, or delete files on disk.
- Do not add autonomous mixing, plugin automation, or DAW control.
- Do not enable AcoustID network calls without explicit user opt-in in Settings.
- Do not add cloud sync of the association graph (deferred to Phase 4).
