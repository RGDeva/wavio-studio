# WS-025 — FL Studio → DAWproject spike

- **ID:** WS-025 · **Priority:** cross-DAW proof (post-freeze)
- **Product outcome:** an FL project becomes a standards-compatible
  `.dawproject` a collaborator can open, with an honest fidelity report.
- **Technical objective:** wire `flpReader` (WS-008) output into the Session
  IR and emit a `.dawproject` via the WS-023 writer + `wavi/` manifest.
- **Dependencies:** WS-023 (writer), WS-024 (IR), WS-008 (flpReader),
  WAVI_FL_TO_ABLETON_IMPLEMENTATION.md (extraction/classification). **Repo:**
  wavio-studio. **Base:** WS-023+WS-024 merged tip. **Feature branch:**
  `spike/fl-to-dawproject`. **Worktree:** `~/wavi-worktrees/fl-to-dawproject`.

## Exact requirements
1. Map flpReader extraction → Session IR: tempo, timesig, markers, channel
   names→tracks, MIDI notes→NoteIR, playlist clips→ClipIR (patterns
   flattened, fidelity `approximated`), plugin names→DeviceIR metadata_only,
   sample paths→MediaRefIR.
2. Emit a valid `.dawproject` with `wavi/session.json` (identity/provenance/
   manifest), `wavi/renders/` (dry/wet stems from the FL stem-export folder,
   per the existing v1 flow — user provides them), `wavi/fidelity.json`.
3. Fidelity report is total: every approximated/rendered/metadata_only/
   unsupported element listed; zero-entry report is a test failure.

## Fixtures
Use FL-generated fixtures (founder supplies a tiny `.flp` once, hash-pinned)
PLUS synthetic TLV fixtures. **DawVert (GPL-3.0) may be run offline on a dev
machine to generate comparison `.dawproject` output** for cross-checking —
its output files are usable as fixtures, but DawVert is NEVER linked or
vendored.

## Prohibited
Automating FL rendering (out of scope, as in v1); vendoring DawVert;
production wiring.

## Acceptance
Headless: `.flp` → IR → `.dawproject` → WS-023 reader re-parses → asserts
tempo/track-count/note-count/marker set. The generated file validates against
Project.xsd. Founder gate (optional): open in Bitwig/Studio One.

## Commit / handoff / stop
Conventional commits; push; handoff. STOP at the spike — no production FL
publish path. Recommended: Builder, Architect review.
