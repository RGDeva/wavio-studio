# WS-026 — DAWproject → Ableton spike

- **ID:** WS-026 · **Priority:** cross-DAW proof (post-freeze)
- **Product outcome:** a `.dawproject` (from FL via WS-025, or any native
  DAWproject DAW) opens as an editable Ableton Live set, in time, with an
  honest fidelity report.
- **Technical objective:** wire the WS-023 reader's Session IR into the
  `.als` generator (WS-013) path.
- **Dependencies:** WS-023 (reader), WS-024 (IR), WS-013 (alsWriter),
  WAVI_FL_TO_ABLETON_IMPLEMENTATION §5 (.als generation). **Repo:**
  wavio-studio. **Base:** WS-023+WS-024 merged tip. **Feature branch:**
  `spike/dawproject-to-ableton`. **Worktree:** `~/wavi-worktrees/dawproject-to-ableton`.

## Exact requirements
1. Consume Session IR → `alsWriter` typed nodes: one AudioTrack per IR track
   with a wet-render clip at `start_beats` (RelativePathType 3 sample refs
   into `Samples/Imported/`), one MidiTrack per track with NoteIR, MasterTrack
   tempo + timesig, Locators from markers, names/colors by role.
2. Where the IR carries data Ableton generation can't reconstruct (plugin
   state, warps, automation curves), fall back to the `wavi/renders/` wet
   stem and record `rendered`/`unsupported` fidelity.
3. Ship inside a standard Wavi pack (reuses existing hash/no-Temp-Project
   machinery). Emit `wavi/fidelity.json`.

## Acceptance
Automated headless: `.dawproject` → IR → `.als` → round-trip our own `.als`
parser asserts tempo/track-count/notes. Founder gate: open the 8-track
fixture in Live 12 — no Temp Project banner, plays in sync with reference mix
(<20 ms onset skew), MIDI editable, fidelity report lists exactly the known
approximations (the WAVI_FL_TO_ABLETON_IMPLEMENTATION §7 proof, now via the
DAWproject IR).

## Prohibited
Reconstructing FL/Ableton native plugin state; production publish path;
weakening the no-Temp-Project guarantees.

## Commit / handoff / stop
Conventional commits; push; handoff. STOP at the spike. Recommended:
Architect (this is the .als-generation-grade packet), Builder assist.
