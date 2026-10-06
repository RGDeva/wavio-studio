# Cross-DAW portable handoff v1

**Status:** implemented at source/headless level (2026-10-06).
**Branch:** `feat/cross-daw-portable-handoff-v1`.

## 1. What was actually there before

| Capability | State before | Actual implementation | Gap |
|---|---|---|---|
| Source DAW detection | Working | `adapters/` + `projects.daw_type` | — |
| Target DAW selection | **Caller-supplied only** | `daw:planHandoff` took a `targetDawType` argument | No UI ever called it |
| Cross-DAW planner | Working, pure | `crossDaw.ts` — tiers, usable sets, losses | Never reached disk |
| Fidelity report | **In-memory only** | `buildFidelityReport()` returned an object | Nothing ever wrote it |
| Restore / download | Working | `restore:start`, hash-verified extraction | — |
| Restore adoption | Working | `restoreAdoption.ts` + `restored_projects` | — |
| Stems / MIDI / renders | **Classified, never collected** | `collectPortableAssets()` | Left scattered in the creator's layout |
| Native project | Working | indexed as role `project` | — |
| Plugin / dependency metadata | **Absent** | `scanPlugins: false` on every adapter | Still absent; now stated |
| `project.dawproject` | Detected if present | matched by extension | Never produced — correctly |
| `wavi/session.json` | **Spec only** | `WAVI_SESSION_IR_SPEC`, `WAVI_DAWPROJECT_FIELD_MAPPING` | No implementation |
| `wavi/fidelity.json` | **Spec + builder, no writer** | `buildFidelityReport()` | No writer |
| Manifest / package handling | Project Packs for sync | — | No portable package |
| UI compatibility surface | Capability rows only | `compatibilityView.ts` | No handoff, no tier, no assets |

So: the thinking existed and the plumbing did not. The verdict lived in whatever
UI rendered it and vanished with the window; the assets stayed in the creator's
own folder layout.

## 2. What was genuinely missing

A package. Everything else was a consequence of that.

## 3. Layout

```
<root>/
├── Song.als                     original, for reference; same-DAW opens it
├── project.dawproject           ONLY if one genuinely travelled
├── wavi/
│   ├── .wavi-portable-handoff   marker: this is a DERIVED checkout
│   ├── session.json             wavi.session/1
│   ├── fidelity.json            wavi.fidelity/2
│   └── PORTABLE.md              the same, for a person
├── stems/
├── midi/
└── renders/
```

It is a **derived checkout**. The planner refuses a root that overlaps the
source in either direction, every write is containment-checked at the moment of
writing, and no source file is read-modified — the original project folder comes
out byte-for-byte unchanged, which is asserted rather than assumed.

## 4. `wavi/fidelity.json` — `wavi.fidelity/2`

`tier`, `summary`, `sourceDaw`, `targetDaw`, `sourceVersion`, plus
`available.{nativeProject, dawproject, dawprojectAbsentReason,
structuredImportSupported, stems, midi, renders}`,
`dependencies.{scanned, known, missing, note}`, `losses`, `warnings`,
`checksumMismatches`, `rejected`.

Two deliberate choices. `dawprojectAbsentReason` states *why* there is none
rather than leaving a null to be misread as a bug. `dependencies.scanned:
false` exists because an empty `known` list would otherwise read as "no plugins
needed" when the truth is "Wavi has never looked".

No tokens, no Privy DID, no absolute paths, no internal database ids. Asserted
by a test that greps every written file for the home directory, the temp root
and the usual credential shapes.

## 5. `wavi/session.json` — `wavi.session/1`

It was **spec only**, so this implements the minimum: identity, source DAW,
tempo *when genuinely known*, lineage refs, and an asset inventory with real
measured bytes and sha256. It is the wavi-extension sidecar from
`WAVI_SESSION_IR_SPEC` — and it carries no tracks, devices, channels, clips or
automation. A test asserts those keys are absent, because a sidecar that grew
track state would be the second proprietary session format DR-015 forbids.

## 6. DAWproject

Included and listed when one genuinely travelled. **Never generated.** And its
presence does not promote the tier: none of Wavi's five target DAWs imports the
format out of the box, so `DAWPROJECT_IMPORT_SUPPORT` is all-false and a
travelling `.dawproject` yields `tier: stems` with a loss line saying the target
cannot import it. Promoting on the file's mere existence is the single most
tempting dishonesty available here.

## 7. Asset selection

Only assets indexed against the authoritative project, taken from Wavi's own
index rather than from the caller — a renderer cannot ask for a package
describing files it invented. Each path is containment-checked twice (by pattern
and by resolution, which fail differently). Buckets come from the cross-DAW
planner, so layout and fidelity claim cannot disagree. A previous `wavi/` is
excluded, so a rebuild never ingests its own output. Collisions are renamed
(`vocal.wav`, `vocal-2.wav`) rather than silently overwritten.

Tier is **never** promoted from a filename: `stems-final-master.wav` alone is
`render`, asserted directly.

## 8. Integrity and path safety

Reuses the existing sha256 convention; no second hashing architecture. Bytes are
hashed before writing, the written size is verified after, and a recorded
checksum that disagrees marks the asset unreliable **and fails the handoff**.
An indexed file that cannot be read is a reported failure, never a skip.
Traversal, absolute paths and `..` segments are rejected and written into
`fidelity.json` so the refusal is inspectable.

`ok: false` means incomplete or unreliable. A handoff with a corrupt stem is not
a success with a note attached.

## 9–10. Same-DAW and different-DAW

Same DAW resolves to `native`, the original sits at the root, losses are empty,
and the UI says "nothing is lost" rather than nudging anyone toward a
reconstruction they do not need. Different DAW retains the original for
reference, collects what exists, and claims nothing was converted. One planner
serves all five DAWs in both directions — there are no bespoke conversion paths,
and the FL→Ableton test exists to prove the inverse is the same code.

## 11. UI

Added to the existing Compatibility tab in `ProjectDetail`: a target selector,
one button, then Source / Open with / Compatibility, an *Available* list, a *Not
preserved* list, and — separated — a warning block for files that are missing or
unreliable. A broken handoff must not read as more boilerplate next to
"automation does not transfer". Presentation logic is pure and tested in
`src/lib/handoffView.ts`; only `native` is allowed the reassuring tone.

## 12. Project Brain and adoption

`portable_handoff_built` is logged as activity on the **existing** project, so
Brain reads tier, target and counts with no separate index.

One real defect was found and fixed here. A handoff built anywhere the user has
asked Wavi to watch would have been **discovered as a new project** — a
duplicate carrying a stale copy of the creator's project file, which could then
sync and publish as if it were original work. The marker file plus
`isPortableHandoffDir()` in the discovery walk stops that, and the marker
explains itself so deleting it is an informed choice.

## 13. Return workflow

Untouched. `session.json` carries `lineage.{sourceVersion, sourceProjectRef,
sourceVersionRef}` from `restored_projects`, so the checkout still knows the
canonical parent a child version must descend from, and `adoptionAllowsContribution`
remains the single rule for who may publish back — building a handoff is not a
licence to publish. For a project of your own, lineage is recorded as null
rather than fabricated.

## 14. What still needs a working Mac

Everything above is proven at source level against a real filesystem. Not
proven: the Electron IPC path end to end (ENV-1 still SIGKILLs the bundle), and
that any of the five DAWs actually opens what was produced — no DAW was run, and
no claim is made that one did.
