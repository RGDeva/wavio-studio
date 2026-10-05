# Wavi Project Brain v1

Continuously scan, index, organize, remember and retrieve context across local music
projects — with **deterministic local state as the source of truth**, and a clean interface
for a later local LLM agent.

The agent is explicitly **not** part of v1. What is built here is everything the agent will
stand on, so that swapping or removing the model never changes what the app believes.

---

## 1. What already existed

Three of the five verbs were already real, and are reused rather than rebuilt:

| Verb | Where it lives | State |
|---|---|---|
| **Scan** (continuously) | `electron/watcher.ts` | writes incrementally — `upsertProject`, `upsertFile`, `createVersion`, `reconcileMovedFile`, `markFileMissing` |
| **Index** | `electron/db.ts` | `projects` / `files` / `versions` / `asset_associations` in SQLite |
| **Organize** | `electron/projectAssociation/` | association engine + an ambiguous-case review queue |

Two were not:

- **Remember** was a flat `memory` blob in electron-store: no project scope, no provenance,
  no history, and no query beyond an exact key. That is a scratchpad, not a memory — there
  was no way to ask *where did this come from* or *is this still true*.
- **Retrieve** was `searchFiles`: a three-column `LIKE` ordered by mtime. No ranking, no
  cross-project context, no explanation of why anything matched.

v1 builds those two, and the interface over them.

---

## 2. The two rules everything follows

**The index wins.** A fact is either `derived` (recomputable from deterministic local state)
or `stated` (an assertion by a person or an agent). A derived fact that disagrees with the
index is *stale* — the index is not corrected to match it. An agent is structurally
forbidden from minting a derived fact (`validateFact` rejects `kind:'derived'` unless
`origin:'index'`). Without that, a model could write one wrong "fact" and have the brain
repeat it forever.

**Memory is append-only.** Writes supersede rather than overwrite, so *what did we believe
last month, and why did it change* stays answerable — the same reasoning that makes project
versions immutable. Re-writing an identical value is a no-op, because the watcher re-derives
constantly and recording "still 128 BPM" ten thousand times would bury the moments that
actually changed.

---

## 3. Modules

All pure — no I/O, no Electron, no clock (`now` and `referenceYear` are injected so the same
query parses identically today and next year).

| Module | Responsibility |
|---|---|
| `brain/query.ts` | the structured query language: terms, quoted phrases, field filters (`daw:` `role:` `bpm:` `after:june 22` …) |
| `brain/retrieval.ts` | integer-scored, explainable, **totally ordered** ranking |
| `brain/memory.ts` | fact validation, append-only write planning, reconciliation against the index |
| `brain/contextPack.ts` | the bounded, attributed snapshot a model consumes |
| `brain/service.ts` | composes the above over injected row-getters |

`service.ts` takes its dependencies by injection rather than importing `db.ts`, because
`db.ts` binds the Electron-ABI better-sqlite3 and cannot load under vitest. That same
constraint is what produced this codebase's hand-copied test mirrors (and the bugs they
hid); injection avoids adding another one.

### Why no embeddings in v1

Vector similarity would make retrieval depend on a model's state and on floating-point
ordering — the opposite of a deterministic source of truth, and unexplainable when a user
asks why something matched. Natural language belongs **above** the query layer: the agent's
job is to turn *"that vocal take from the Midnight session in June"* into
`vocal take project:midnight after:june before:june`, which the brain answers identically
every time.

---

## 4. Retrieval guarantees

- **Total ordering** — score, then recency, then id. Ties broken only by score would let
  SQLite row order leak into the answer; the suite asserts that reversing the input does not
  change the output.
- **AND semantics** — every term must match somewhere. OR floods results with
  one-common-word hits and makes "why did this match?" useless.
- **Filters are gates, never score** — `daw:ableton` never returns an FL project because its
  name matched well.
- **Every hit explains itself** via `matchedOn`.
- **No filesystem paths.** A `BrainRecord` carries an opaque id and a name. Results may cross
  into a model's context; a path is user data it never needs. Asserted in tests.

---

## 5. The agent interface (`wavi.context/1`)

The context pack is a **data structure, not a prompt**. The brain decides what is true and
what is relevant; the model decides only how to say it. That split is what makes the brain
testable and keeps a model swap from changing what the app believes.

It is:

- **Bounded** — explicit item and byte budgets, with files kept per role and a round-robin
  allocation so no role is starved. A flat truncation would drop whole roles invisibly.
- **Never silently truncated** — `truncation.notes` says exactly what was dropped, so a model
  can hedge instead of answering confidently from a half-view.
- **Attributed** — every fact carries `origin:producer` (e.g. `user:ui`, `index:watcher`).
- **Private** — no paths, no tokens, no account ids.

`summarizePack()` produces the headline deterministically, so the model never has to infer
it.

### IPC

| Channel | Purpose |
|---|---|
| `brain:search` | deterministic retrieval across every indexed project |
| `brain:contextPack` | the bounded snapshot for one project |
| `brain:recall` | everything currently believed about a project, attributed |
| `brain:remember` | record a **stated** fact |

`brain:remember` forces `origin:'user'` in main — a renderer must not be able to claim index
provenance for an assertion.

---

## 6. Storage

`project_facts(id, project_id, key, value, kind, source_origin, source_producer,
observed_at, superseded_at)`, with a partial unique index on `(project_id, key) WHERE
superseded_at IS NULL` — one believed fact per key, with history still queryable.

Every column is declared in the `CREATE`, not bolted on by a later `ALTER`. The
`links.account_id` bug — an `ALTER` that ran *before* its `CREATE`, failed silently on fresh
installs, and left Project Link creation broken for every new user — came from exactly that
pattern.

---

## 7. Not done in v1

- The local LLM agent itself. The interface is ready; the model is not wired.
- Derived-fact population from the watcher. The pathway and the rules exist
  (`origin:'index'`), but nothing writes derived facts automatically yet — so today the
  reconciliation path is exercised by tests rather than by live data.
- The legacy electron-store `memory:*` channels still exist and are untouched. They should be
  migrated onto `project_facts` and removed, but doing that in the same change would have
  mixed a refactor into a new subsystem.
- Nothing here ran inside Electron (ENV-1). The pure modules and the service are proven
  headlessly; the IPC wiring is compile-checked and reviewed, not executed.

---

## 8. Capability audit (2026-10-04)

| Capability | Existing implementation | State | Gap closed in this pass |
|---|---|---|---|
| Project discovery | `discovery.ts` + `watcher.ts` | **PASS** | — (reused) |
| File discovery | `discoverAudioFiles` | **PASS** | — (reused) |
| Project association | `projectAssociation/` + review queue | **PASS** | — (reused) |
| File classification | `adapters/common.classifyFileRole`, `fileClassifier.ts` | **PASS** | — (reused) |
| Version detection | `createVersion`, `versionExistsByChecksum` | **PASS** | — (reused) |
| Duplicate detection | checksum + path uniqueness, unique index on `(project_id, checksum)` | **PASS** | — (reused) |
| Activity history | `activity_log` + `getActivityLog(limit)` | **PARTIAL** | **time-ranged / per-project / changed-since queries added** — a LIMIT-based log cannot answer "what changed yesterday?" without silently lying when the window is busier than the limit |
| Text search | `searchFiles()`: 3-column `LIKE` ordered by mtime | **WEAK** | **replaced** by ranked, explainable, totally-ordered retrieval |
| Recent projects | `getProjects()` ordered by `modified_at` | **PARTIAL** | **windowed** `getRecentProjects(since)` |
| Recent files | `getAllFiles(limit, offset)` | **PARTIAL** | **windowed** `getRecentFiles(since)` |
| Project context | `copilot.ts` single-project `ProjectContext` | **PARTIAL** | **bounded, attributed `wavi.context/1` pack** |
| Assistant retrieval | 14 tools, **none reading the brain** | **MISSING** | **6 read-only brain tools wired** |
| Semantic search | none | **ABSENT** | deliberately deferred (see §3) |
| Persistent memory | `memory:*` on electron-store JSON | **WEAK** | **`project_facts`**: scoped, attributed, append-only |

No second index was created. `projects` / `files` / `versions` / `activity_log` are extended,
not duplicated. Two columns were added to `files` (`discovered_at`, `last_seen_at`) because
`created_at`/`modified_at` are the FILE's own timestamps and say nothing about what Wavi
knows — "indexed since" and "missing since" were previously unanswerable.

## 9. Episodic memory

`getActivityInRange`, `getActivityForProject`, `getFilesChangedSinceVersion`, plus
`brain/timeRange.ts`, which resolves "yesterday", "this week", "last month", "last 7 days"
against an **injected** now. Weeks start Monday: asked on a Sunday night, "this week" must
mean the week just worked — a Sunday-start week would answer with an almost-empty window.

An unrecognised range returns `null` rather than defaulting, so the assistant says "I don't
know that range" instead of confidently answering a different question.

## 10. Derived project memory

`brain/derive.ts` recomputes what the index already implies, keeping **facts** and
**inferences** in separate buckets all the way out to the tool result:

- **Facts** — counts, latest version, last change, `changed-since-publish` (both timestamps
  belong to the index, so it is not a guess).
- **Inferences** — `likely-master`, `has-stem-set`, each carrying its evidence and a
  strength. Nothing in a filesystem marks a file as the master; returning that as a fact
  would let a confident wrong guess propagate downstream.

Output is byte-stable for the same rows in any order — an unstable recompute would look like
a change on every pass and flood the append-only store.

## 11. Assistant integration

Six read-only, offline tools in `copilotTools/brainTools.ts`: `search_music_library`,
`find_files`, `recent_activity`, `recent_projects`, `project_memory`,
`changed_since_version`.

The direction of the arrow is the point: **the assistant asks, the brain answers.** The model
never scans the filesystem, never computes a time window, and never decides what is true.
Tools are omitted entirely when no brain is supplied rather than registered as stubs — a tool
the model can see is a tool it will try.

No mutation was added; delete/move/rename/publish/share keep their existing approval flows.

## 12. Local-model boundary

`brain/llmProvider.ts` defines the seam and ships `NullProvider` as the **default
configuration, not a test stub** — every question answered today is answered without a model.

A provider receives already-retrieved context and returns prose. It cannot read the
filesystem, the database or the network: a provider that could fetch its own context could
answer from something the index never saw, and the determinism guarantee would be gone.
`phraseAnswer()` requires a deterministic answer up front, so a failing or absent model
degrades to real output rather than taking the answer down with it.

## 13. Golden path

`brain/goldenPath.integration.test.ts` walks the spec fixture end to end against a REAL
file-backed SQLite database built from db.ts's own SQL — file-backed rather than `:memory:`
because "restart" has to mean closing and reopening, or the persistence step proves nothing.

Covered: scan → 2 projects discovered → classified → associated → persisted → search
"Sunshine vocal" (correctly preferring Sunshine's `vocal.wav` over Faith's `vocals.wav`) →
`master-v7` identified as an inference → change detected → activity recorded → "today"
window queried, with "yesterday" correctly empty → **restart** → same facts → file moved →
reported missing → reconciled with no duplicate row.

## 14. Scale

25,000-record ranking stays interactive (~110ms), growth is linear rather than quadratic,
ordering is order-independent at scale (where ties actually surface), and deriving memory for
a 5,000-file project never recomputes a hash. Thresholds are deliberately loose — they catch
an accidental quadratic, not a busy machine.

## 15. Live refresh — the brain stays current by itself (2026-10-05)

Derived memory previously only existed when something asked for it: the watcher
updated the index, but nothing recomputed what the index now *implied*, so remembered
facts went stale until a manual rescan.

`brain/liveRefresh.ts` closes the loop. The watcher's existing `onEvent` callback marks the
touched project dirty; a coalescing timer recomputes `deriveProjectMemory` and writes only
the facts whose values actually moved.

**Hooked without touching `watcher.ts`.** The callback already carried `projectId`, so the
watcher stays unaware the brain exists — one less coupling in a file that handles ingestion.

Three properties make it safe to call on *every* file event:

- **Coalescing.** A DAW save touches dozens of files; 40 events produce one recompute. The
  integration test asserts no fact key is written more than once per burst.
- **Only real changes are written.** `planFactWrite` no-ops an unchanged value, so a
  recompute that finds nothing leaves no trace. That is what makes over-notifying safe.
- **Failures never reach the watcher.** Every flush is isolated per project and the
  `markDirty` call is wrapped — refreshing memory is strictly secondary to indexing a file.

Fairness is explicit: dirty projects are processed oldest-first so a quiet project cannot be
perpetually overtaken, the interval floor is **per project** so one long export cannot starve
the rest, and `maxPerBatch` caps a single flush. Deferred projects stay queued and the timer
re-arms rather than stranding them.

Manual Rescan is kept for recovery and **bypasses the throttle** via `forceRefresh` — a user
clicking Rescan is asking explicitly, and making them wait out a debounce they cannot see
would look broken.

Everything the refresher writes is attributed `kind:'derived', origin:'index',
producer:'watcher'` — asserted in the integration test, because a derived fact may only
originate from the index. That is what stops a model's opinion being laundered into ground
truth.

Timing is driven by an injected scheduler, so the coalescing behaviour is tested instantly
and deterministically rather than by waiting on real timers.

## 16. Live refresh completion — lifecycle fields, coalesced activity, proofs

### The gap that was left behind

`discovered_at` / `last_seen_at` were added as columns **with helper functions to stamp
them — and nothing ever called those helpers.** Both columns sat permanently NULL.

The fix moved the behaviour into the upsert statements themselves rather than the call
sites. Stamping at call sites meant six places to remember, and every one of them was
forgotten; putting it in the SQL makes it impossible to miss.

- **First discovery** sets both, in the INSERT.
- **Later observation** advances `last_seen_at`; `discovered_at` is `COALESCE`d so a rescan
  cannot make a long-known file look newly found.
- **A move** reconciles the existing row *in place by id*, so the identity and
  `discovered_at` survive a rename — no fake new file.
- **A missing file** keeps its row, so it still knows when it was first seen and when it was
  last actually there.
- **A reappearance** advances `last_seen_at` only.

This is why both pairs of timestamps exist: `created_at`/`modified_at` belong to the FILE,
`discovered_at`/`last_seen_at` belong to Wavi's knowledge of it. "Indexed since" and
"missing since" were previously unanswerable.

Proven against the **real shipped SQL**, extracted from db.ts rather than copied.

### Activity coalescing happens at READ time

One DAW save writes dozens of low-level rows. Those are kept — each is a real observation,
and deleting them would discard history. `brain/activityView.ts` groups them when read, so
"what did I work on this week?" is an answer rather than a transaction dump.

Grouping is bounded by a time window and never crosses project or event type: "changed this
morning" and "changed last Tuesday" are two different facts, and flattening them would answer
"when did this change?" wrongly. A single event still reads as itself rather than "1 × …",
and group counts always sum to the raw total — nothing is lost.

### Proofs

`liveGoldenPath.integration.test.ts` runs the full sequence against a **file-backed**
database: initial state → `master-v8.wav` appears → the only call is `markDirty` → memory and
search both reflect v8 → "what changed recently?" returns the event → **restart** → derived
memory, activity and `discovered_at` all survive → the first event after restart updates the
same project without duplicating memory → rename reconciles in place → delete shows missing →
restore converges, with the file never losing its identity.

Burst behaviour is asserted **logically, not by timing**: 200 events across 10 projects
produce exactly **10** derive calls. A timing assertion would be brittle on a busy machine.

## 17. Memory unification — one persistent store (2026-10-05)

Four `memory:*` IPC handlers still wrote an electron-store JSON blob, leaving Wavi with two
independent memory systems. They now write `project_facts`. The channel names and observable
behaviour are unchanged; only the storage moved, so no UI rewrite was needed.

### Audit

| API/channel | Was | Caller | Semantics | Migration |
|---|---|---|---|---|
| `memory:list` | electron-store | `CopilotPage`, overlay `CopilotPanel` (count) | all entries, global | `listMemory(null)` |
| `memory:get` | electron-store | — (available via preload) | value by key | `getBelievedMemoryRow(null, key)` |
| `memory:set` | electron-store | `CopilotPage` (`last_chat`, user notes) | upsert, preserves `createdAt` | supersede + insert |
| `memory:delete` | electron-store | `CopilotPage` | hard delete | supersede (hidden, not destroyed) |

Source search found **no assistant tool** reading the legacy store, so §10's "eliminate any
bypass" required no change — only verification. Nothing writes the blob any more.

### Scope — why global is modelled, not faked

The legacy store was app-wide. Filing those entries under an arbitrary project would
misclassify them, so `project_facts.project_id` is now **nullable**, where NULL means global.

This required the smallest compatible extension, and one non-obvious correction:

> A plain `UNIQUE(project_id, key)` does **not** dedupe global rows, because SQLite treats
> NULLs as **distinct** in a unique index. Verified empirically before relying on it — every
> write of `last_chat` would otherwise have piled up a new row forever. The index is now on
> `COALESCE(project_id, '')`.

Legacy databases declared `project_id NOT NULL`, so the table is rebuilt on migration — the
same approach the `files` table already uses to drop its own NOT NULL.

### Provenance

User memory migrates as `kind: 'stated'`, `origin: 'user'` — explicit human assertion, never
derived. Collapsing it into derived facts would make something a person typed
indistinguishable from something the watcher computed. Global memory is additionally
forbidden from being `derived` at all: it has no project to recompute from, so a derived
global fact could never be falsified.

### Conflict semantics

- **Inference vs fact** — unchanged: a derived observation cannot overwrite a stated fact
  (`planFactWrite` rejects it).
- **Migration vs existing** — a newer Project Brain record wins; by then the legacy blob is
  the stale copy. A `derived` fact occupying the same key is reported, not overwritten.
- **Two explicit memories** — last write supersedes, and the prior value stays queryable, so
  provenance and history survive the disagreement.

### Delete

`memory:delete` supersedes exactly one record **by id**. It disappears from `list()`/`get()`
as the user expects, nothing unrelated is touched, and there is no key- or scope-wide delete
anywhere in the path.

### The legacy blob is not destroyed

Migration is idempotent (gated on `migratedMemoryV1`), non-fatal, and leaves the original
JSON on disk. The transfer succeeds without it, but keeping it costs nothing and is the only
rollback path. Nothing reads it again.
