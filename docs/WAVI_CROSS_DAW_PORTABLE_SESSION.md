# Wavi Cross-DAW Interoperability — Portable Session

Positioning rule: **never promise native conversion.** Wavi promises that collaborators in different DAWs can work on the same music with explicit, visible fidelity levels.

## 1. Three compatibility levels

| Level | Promise | Mechanism |
|---|---|---|
| **Native** | Maximum fidelity, same DAW | Project Pack via the DAW adapter (Ableton→Ableton exists today) |
| **Portable Session** | Editable cross-DAW collaboration | Shared schema below; generated target-DAW project via `importPortableSession` |
| **Universal Pack** | Anyone can contribute something | Reference mix + stems + MIDI + key/BPM + notes/instructions; no project generation |

Every Link and restore flow displays the level and a per-element fidelity report *before* the user commits (extends the existing compatibility-metadata pattern from `6afea0a`).

## 2. Portable Session schema (v1)

```jsonc
{
  "portable_session_version": 1,
  "source": { "daw": "fl_studio", "daw_version": "21.2", "adapter_version": "1.0.0",
              "project_id": "…", "version_id": "…" },
  "timing": { "bpm": 140, "bpm_automation": false, "time_signature": "4/4",
              "sample_rate": 44100, "start_offset_beats": 0 },
  "key": { "root": "F#", "scale": "minor", "confidence": "tagged|analyzed" },
  "markers": [ { "beat": 0, "name": "Intro" } ],
  "tracks": [
    {
      "id": "t1", "name": "Lead", "role": "lead|drums|bass|vocal|fx|other",
      "kind": "audio|midi|hybrid",
      "gain_db": -3.0, "pan": 0.0, "muted": false,
      "clips": [
        { "start_beats": 32, "length_beats": 16,
          "audio": { "file": "stems/lead_wet.wav", "kind": "wet" },
          "midi":  { "file": "midi/lead.mid" } }
      ],
      "renders": { "dry": "stems/lead_dry.wav", "wet": "stems/lead_wet.wav" },   // consolidated from beat 0
      "plugin_chain": [
        { "name": "Serum", "vendor": "Xfer", "format": "vst3",
          "preset_name": "PL_Growl4", "preset_blob": "presets/t1_0.fxp|null",
          "fallback": "rendered"   // what happens if plugin missing
        }
      ]
    }
  ],
  "assets": { "reference_mix": "mix/reference.wav" },
  "notes": { "lyrics": "…", "project_notes": "…", "collaborator_instructions": "…" },
  "manifest": [ { "path": "stems/lead_wet.wav", "sha256": "…", "bytes": 123 } ]
}
```

Container: a ZIP (same infra as Project Packs) with `session.json` + `stems/ midi/ presets/ mix/`. Consolidation rule: every audio render starts at beat 0 (arrangement-aligned), so any DAW can drop files at origin and be in sync — this single rule is what makes the format survivable.

## 3. Fidelity truth table

| Element | Preserved | Approximated | Rendered to audio | Not convertible |
|---|---|---|---|---|
| BPM (static), time sig, key, markers, track names/roles/gain/pan | ✅ | | | |
| MIDI notes per track | ✅ | | | |
| Arrangement clip positions | ✅ (beat-based) | | | |
| Tempo automation | | ✅ (tempo map export where source parseable; else flatten + warn) | | |
| Instrument sound (synth + preset) | ✅ only if same plugin installed on target | preset name as breadcrumb | ✅ dry+wet renders always included | proprietary instruments (FL native plugins, Ableton devices) |
| Effect chains | plugin manifest ✅ | | ✅ wet render | device-specific automation |
| Automation (non-tempo) | | volume/pan as breakpoint export where feasible | ✅ baked into wet render | plugin-parameter automation |
| Racks/groups/routing, sends | | flattened to per-track | ✅ | nested device racks |
| Sliced/warped audio, time-stretch modes | | | ✅ (rendered as processed) | warp markers themselves |
| Pattern/playlist structure (FL) | | ✅ (patterns → linear clips) | | pattern semantics |

## 4. First proof: FL Studio → Portable Session → generated Ableton project

Why this direction: `.flp` is parseable (community-documented), Ableton `.als` is *writable* (gzip XML we already parse — writing a minimal valid Live Set is tractable), and it matches a real collaboration shape (FL beatmaker → Ableton artist/topliner).

Pipeline:
1. **Export (FL adapter):** parse `.flp` → BPM, patterns, channel names, plugin names, MIDI per channel; render per-track dry/wet stems from beat 0 (initially: require user to run FL's stem export — v1 can ingest an FL stem-export folder rather than automating FL; automation of rendering is explicitly out of scope for the proof).
2. **Session build:** patterns flattened to linear clips; playlist → arrangement positions in beats; write `session.json` + manifest hashes.
3. **Import (Ableton adapter):** generate minimal `.als`: one audio track per session track with the wet render placed at start offset; one MIDI track per track that has MIDI, clip at correct beats; tempo + time sig set; track names/colors by role; plugin chain written into track annotations (Info Text) as breadcrumbs.
4. **Verification:** open in Live (manual gate) — plays in sync with the reference mix (null-ish test: render Ableton master, cross-correlate with reference mix; tolerance threshold, not sample-null).

Acceptance for the proof: a 140 BPM, 8-track FL project round-trips into a Live set that plays in time, with editable MIDI for the tracks that had MIDI, and a visible fidelity report listing what was rendered vs preserved.

Explicit non-goals of the proof: FL native plugins reconstruction, automation curves, tempo changes, audio warping, any Ableton→FL direction (that is roadmap phase 9 — requires writing `.flp`, which is harder than reading it; if writing proves impractical, Ableton→FL ships as Portable-Session-consumed-by-a-Wavi-FL-import-tool or degrades to Universal Pack).

## 5. Where it lives

- Schema + validation: shared package consumed by both repos (`portable-session/schema.json`, TS types generated).
- Export/import: adapter methods (`exportPortableSession` / `importPortableSession`) — desktop-side, offline-capable.
- Distribution: same Link/pack infrastructure; a Link can carry `restore_pack` (native) and `portable_session` capabilities simultaneously, with the receiving client choosing by installed DAW.
