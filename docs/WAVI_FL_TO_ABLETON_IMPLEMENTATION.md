# FL Studio → Portable Session → Ableton: Implementation Design

Implementation-grade companion to WAVI_CROSS_DAW_PORTABLE_SESSION.md (schema
v1 lives there). Target packets: WS-008 (FLP inspection), WS-012 (schema
package), WS-013 (.als generator), then the assembly proof.

> **UPDATED for DAWproject adoption (DR-015).** The output format is no longer
> the v1 `session.json` JSON — it is a `.dawproject` superset (see
> WAVI_CROSS_DAW_ARCHITECTURE_V2.md). The FL extraction and classification in
> this doc are unchanged and still correct; only the *target container*
> changes: extraction now populates the Session IR (WAVI_SESSION_IR_SPEC.md),
> the `.als` generation in §5 is driven by that IR, and the fidelity report in
> §6 becomes the typed `wavi/fidelity.json`. Packet mapping: WS-012 →
> WS-023/WS-024; the FL→Ableton proof splits into WS-025 (FL→dawproject) +
> WS-026 (dawproject→Ableton). `session.json` → `wavi/session.json`.

## 1. FLP inspection strategy (WS-008)

`.flp` is a TLV event stream: 4-byte magic "FLhd" header (format, nChannels,
PPQ) then "FLdt" data block of events: id <64 = byte, <128 = word, <192 =
dword, ≥192 = variable-length (text/data). Parse ONLY documented, stable
events; unknown events are length-skipped and counted for the fidelity report.

Extract (event ids per community FLP spec — verify against fixtures, never
trust blindly): PPQ (header) · tempo (event 156, BPM*1000 dword; fallback 66
legacy word) · time signature (events 33/34 numerator/denominator, per-pattern
markers → global = first) · project title/comments (192/193 UTF-16) ·
channel names (203) + channel sample paths (196, UTF-16, may contain FL
env vars like %FLStudioFactoryData%) · playlist items (event 233 blocks:
position ticks, pattern/channel id, track index, length) · pattern notes
(event 224 blocks of 24-byte note structs: pos, len, channel, key, velocity,
pan, release) · channel volume/pan (219 mixer params where decodable —
else metadata-only) · markers (205/206 name+position).

Confidence policy: every extractor returns `{value, confidence:
'exact'|'derived'|'absent'}`; anything not 'exact' is listed in the fidelity
report. Parser is pure TS (`electron/adapters/flstudio/flpReader.ts`), no
Electron imports, fixture-tested against 3 committed tiny .flps (generated in
FL by the founder once; hash-pinned; PLUS synthetic TLV fixtures we build in
tests for edge cases).

## 2. Sample-path resolution

Order: absolute path if exists → substitute FL env tokens
(%FLStudioFactoryData%, %USERPROFILE%) from a per-machine map → relative to
project dir → basename search within project dir tree → basename search in
the local Wavi library index (files table) → UNRESOLVED (fidelity report,
never guess across projects). Every resolved file is hashed into the session
manifest; unresolved entries ship as `missing_samples[]` with the original
path string (sanitized of user home prefix).

## 3. Renders: consolidated stems, dry/wet

v1 does NOT automate FL rendering. Export flow requires a stems folder the
user renders from FL (File→Export→Wave, "Split mixer tracks"), dropped into
the export dialog. We then: match stem files to channels/mixer tracks by
name-token overlap (report ambiguities), verify all stems share sample-rate
and length (pad-report otherwise), and treat every stem as starting at beat 0
(FL's split export is timeline-aligned — assert length ≥ playlist span).
`dry` variants only when the user provides a second folder (optional);
otherwise wet-only with `renders.dry = null`. The session's `reference_mix`
is FL's full master export (required input).

## 4. What maps where (classification)

- **Preserved exactly:** BPM (static), PPQ→beats conversion, time signature,
  markers (name+beat), track/channel names, MIDI notes (pos/len/key/vel/pan),
  playlist clip positions (ticks→beats = ticks/PPQ), project title/notes,
  channel volume/pan WHEN event decoding is exact.
- **Approximated:** patterns flattened to linear arrangement clips (loss:
  pattern reuse semantics); mixer-track gain when only insert-level data
  exists; note pan→clip-level when Ableton MIDI clip import can't map per-note pan (it can via MPE? no — approximate).
- **Rendered to audio:** all synth/effect sound (stems), automation results,
  sliced/Fruity-specific processing.
- **Metadata-only:** plugin list (generator/effect names per channel/insert
  from events 201/212 where present) with preset names when stored; sidechain
  and routing topology (recorded, not reconstructed).
- **Impossible/unsafe (declared, never attempted):** FL-native plugin state
  reconstruction, automation curves v1, audio warping, per-note slides.

## 5. Ableton generation (WS-013)

Write gzip XML directly — no Ableton runtime needed. Template strategy:
`alsWriter.ts` builds from typed nodes, NOT string concat: header
(MajorVersion 5, MinorVersion "12.0_x" — pick the fixture's), LiveSet →
Tracks: one AudioTrack per session track (wet stem as a single warped-OFF
clip at start_beats via CurrentStart/CurrentEnd in beats, RelativePathType 3
sample refs into `Samples/Imported/`), one MidiTrack per track with MIDI
(KeyTracks/Notes from session MIDI, loop off), MasterTrack Tempo Manual =
session bpm + TimeSignature; Locators from markers; track name/color by role;
Info Text carries plugin-manifest breadcrumbs. Ship inside a standard Wavi
pack: `<name> Project/` + .als + `Ableton Project Info/` marker dir +
Samples/Imported/* — restore path then reuses ALL existing proven pack
machinery (hashes, no-Temp-Project rules).

Validation of generated .als: (a) round-trip our own parser (parse-what-we
wrote: tempo/key/track count), (b) gunzip+XML well-formedness, (c) golden
fixture diff, (d) MANUAL open in Live 12 (founder gate) for the proof, (e)
cross-correlation: render Live master (manual) vs session reference_mix —
onset offset < 20ms.

## 6. Fidelity report

Emitted as `session.fidelity.json` + human panel in the receiver UI: three
lists (preserved / approximated / rendered) + missing_samples + unknown FLP
events count + any stem-matching ambiguities. NEVER an empty report; honesty
is the feature.

## 7. Acceptance (the proof)

Fixture: 8-track, 140 BPM FL project (2 MIDI synth channels, 4 audio, kick
loop, one marker set, one renamed mixer track), stems exported from FL.
PASS = generated Live set opens in Live 12 with no Temp Project banner, plays
in sync with reference mix (<20ms onset skew), MIDI tracks editable with
correct notes, track names/colors correct, fidelity report lists exactly the
known approximations. Automated portion runs headless (parse→session→als→
re-parse asserts); the Live-open step is a founder gate.

## 8. Reverse direction (Ableton → FL) — DESIGN ONLY, do not implement

Reading .als is easy (we already parse); the hard half is FL import. Writing
.flp is higher-risk than writing .als (undocumented interdependent events,
FL is forgiving of missing events but silently mis-loads malformed note
blocks). Strategy when green-lit: (1) spike: minimal .flp with header + one
channel + tempo + one pattern of notes + playlist entry, opened in FL — 1-week
timebox; (2) if the spike fails, fallback ship = Portable Session consumed by
a "Wavi Import" FL companion (FL supports MIDI scripting from 20.7+ but not
full project construction — so the fallback is: generate a folder with
stems + MIDI files + an .flp containing ONLY audio clips in playlist order
(audio-only .flp is the low-risk subset) + instructions); (3) same fidelity
report contract. Classification mirrors §4 with FL-specific impossibles
(Ableton racks, warp modes, Max devices → rendered/metadata only).
