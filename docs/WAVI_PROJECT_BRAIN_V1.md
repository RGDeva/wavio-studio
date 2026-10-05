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
