# Wavi Session IR Specification (v1)

The Session IR is the single internal model every adapter targets: native
readers produce it, native writers and the DAWproject writer consume it. It
is a plain-TypeScript object graph — **no XML-library types may appear in
its public interface** (DR-015). Package: `electron/adapters/sessionIR/`
(pure TS, no Electron imports, fixture-testable).

## 1. Design rules

1. Musical truth appears exactly once. The IR mirrors DAWproject's semantic
   model closely enough that IR→dawproject is near-mechanical, but uses
   Wavi-idiomatic types (numbers not stringly-typed doubles, discriminated
   unions not abstract XML classes).
2. Every entity carries a stable `irId` (string). IR ids map 1:1 to
   DAWproject `id`s on write and are regenerated deterministically
   (content-hash-seeded) so identical IR ⇒ byte-identical XML output.
3. Every entity may carry `fidelity?: FidelityTag` (§5) and
   `foreign?: ForeignData` (unknown XML preserved on read, re-emitted on
   write — forward compatibility with DAWproject 1.x).
4. Optionality mirrors reality: adapters must never invent data. Absent =
   absent, with a fidelity entry saying why.

## 2. Core types (normative shape; full `.d.ts` lands in WS-023)

```ts
interface SessionIR {
  irVersion: 1;
  source: { application: string; version: string;      // DAWproject <Application>
            wavi?: WaviProvenance };                    // §4 — never required
  metadata: SongMetadata;                               // 13 MetaData.xsd fields, camelCased
  transport?: { tempoBpm?: ParamReal; timeSignature?: { numerator: number; denominator: number } };
  tracks: TrackIR[];                                    // recursive (nested tracks preserved)
  channels: ChannelIR[];                                // flat list; tracks reference by irId
  arrangement?: { lanes: LaneIR[]; markers?: MarkerIR[];
                  tempoAutomation?: AutomationIR; timeSignatureAutomation?: AutomationIR };
  scenes?: SceneIR[];                                   // clip-launcher (read+preserve; no Wavi UI v1)
  mediaPool: MediaRefIR[];                              // every file the session references
}

interface TrackIR   { irId: string; name?: string; color?: string; comment?: string;
                      contentTypes: ('audio'|'notes'|'automation'|'video'|'markers'|'tracks')[];
                      channelId?: string; children: TrackIR[]; loaded?: boolean;
                      waviRole?: 'lead'|'drums'|'bass'|'vocal'|'fx'|'other';  // Wavi-only, → wavi/session.json
                      fidelity?: FidelityTag; foreign?: ForeignData }

interface ChannelIR { irId: string; role: 'regular'|'master'|'effect'|'submix'|'vca';
                      audioChannels?: number; destinationId?: string; solo?: boolean;
                      volume?: ParamReal; pan?: ParamReal; mute?: ParamBool;
                      sends: SendIR[]; devices: DeviceIR[]; fidelity?: FidelityTag; foreign?: ForeignData }

type DeviceIR =
  | { kind: 'vst2'|'vst3'|'clap'|'au'; deviceId?: string; deviceName: string; vendor?: string;
      pluginVersion?: string; role: 'instrument'|'noteFX'|'audioFX'|'analyzer';
      enabled?: ParamBool; statePath?: string; stateExternal?: boolean;   // path into ZIP
      parameters: ParamIR[]; irId: string; fidelity?: FidelityTag; foreign?: ForeignData }
  | { kind: 'builtin'; builtinType: 'generic'|'equalizer'|'compressor'|'noiseGate'|'limiter';
      irId: string; deviceName: string; role: 'instrument'|'noteFX'|'audioFX'|'analyzer';
      enabled?: ParamBool; statePath?: string; parameters: ParamIR[];
      eq?: { bands: EqBandIR[]; inputGain?: ParamReal; outputGain?: ParamReal };
      dynamics?: { attack?: ParamReal; release?: ParamReal; threshold?: ParamReal; ratio?: ParamReal;
                   inputGain?: ParamReal; outputGain?: ParamReal; autoMakeup?: ParamBool; range?: ParamReal };
      fidelity?: FidelityTag; foreign?: ForeignData };

interface SendIR    { irId: string; destinationId?: string; type?: 'pre'|'post';
                      volume: ParamReal; pan?: ParamReal; enable?: ParamBool }

interface EqBandIR  { type: 'highPass'|'lowPass'|'bandPass'|'highShelf'|'lowShelf'|'bell'|'notch';
                      order?: number; freq: ParamReal; gain?: ParamReal; q?: ParamReal; enabled?: ParamBool }

interface LaneIR    { irId: string; trackId?: string; timeUnit?: 'beats'|'seconds';
                      items: TimelineItemIR[] }
type TimelineItemIR =
  | { kind: 'clips'; irId: string; trackId?: string; timeUnit?: 'beats'|'seconds'; clips: ClipIR[] }
  | { kind: 'notes'; irId: string; trackId?: string; notes: NoteIR[] }
  | { kind: 'audio'; media: MediaRefIR }
  | { kind: 'warps'; warps: WarpsIR }
  | { kind: 'automation'; automation: AutomationIR }
  | { kind: 'markers'; markers: MarkerIR[] }
  | { kind: 'lanes'; lanes: LaneIR };                   // nested lanes

interface ClipIR    { irId?: string; name?: string; time: number; duration?: number;
                      contentTimeUnit?: 'beats'|'seconds'; playStart?: number; playStop?: number;
                      loopStart?: number; loopEnd?: number;
                      fade?: { timeUnit?: 'beats'|'seconds'; inTime?: number; outTime?: number };
                      enable?: boolean; referenceId?: string;             // shared-content clips
                      content?: TimelineItemIR; fidelity?: FidelityTag; foreign?: ForeignData }

interface NoteIR    { time: number; duration: number; channel: number; key: number;
                      velocity?: number; releaseVelocity?: number;
                      expressions?: AutomationIR[] }                     // per-note MPE lanes

interface WarpsIR   { contentTimeUnit: 'beats'|'seconds'; content: MediaRefIR;
                      points: { time: number; contentTime: number }[] }  // beat↔content-time map

interface MarkerIR  { irId?: string; name?: string; color?: string; time: number }

interface AutomationIR { irId: string; target: { parameterId?: string;
                         expression?: 'gain'|'pan'|'transpose'|'timbre'|'formant'|'pressure'|
                                      'channelController'|'channelPressure'|'polyPressure'|
                                      'pitchBend'|'programChange';
                         channel?: number; key?: number; controller?: number };
                       unit?: Unit; points: PointIR[] }

interface PointIR   { time: number;
                      value: number | boolean | string;   // real|integer|enum-index|bool|timeSig
                      interpolation?: 'hold'|'linear';
                      timeSignature?: { numerator: number; denominator: number } }

interface MediaRefIR { irId: string; zipPath?: string;      // embedded (inside .dawproject)
                       external?: boolean;                  // referenced, not embedded
                       durationSec?: number; sampleRate?: number; channels?: number;
                       algorithm?: string;                  // warp/stretch algorithm name
                       sha256?: string; bytes?: number;     // Wavi manifest data (→ wavi/session.json)
                       originalNativePath?: string }        // sanitized; Wavi-only

interface ParamReal { irId?: string; value?: number; min?: number; max?: number; unit: Unit; name?: string }
interface ParamBool { irId?: string; value?: boolean; name?: string }
type   ParamIR    = ParamReal | ParamBool
     | { kind: 'integer'; irId?: string; value?: number; min?: number; max?: number }
     | { kind: 'enum'; irId?: string; value?: number; count: number; labels?: string[] };
type   Unit       = 'linear'|'normalized'|'percent'|'decibel'|'hertz'|'semitones'|'seconds'|'beats'|'bpm';

interface SongMetadata { title?: string; artist?: string; album?: string; originalArtist?: string;
                         composer?: string; songwriter?: string; producer?: string; arranger?: string;
                         year?: string; genre?: string; copyright?: string; website?: string; comment?: string }

interface ForeignData { tag: string; attrs: Record<string,string>;
                        children: ForeignData[]; text?: string }   // verbatim unknown XML subtree

type FidelityClass = 'exact'|'approximated'|'rendered'|'metadata_only'|'unsupported';
interface FidelityTag { class: FidelityClass; reason: string; fallback?: string }
```

All times are numbers in the owning timeline's `timeUnit`. `ParamReal.unit`
takes the XSD `unit` enum verbatim; `min`/`max` preserved from source so a
writer can round-trip a DAW's own parameter ranges.

## 3. DAWproject binding

- **Read:** `project.xml` → IR is total for schema-valid 1.0 files. Any
  element the reader does not model semantically is captured in `foreign`
  and re-emitted (attribute order preserved, namespace-free — matches
  upstream JAXB output style verified in the README example).
- **Write:** IR → `project.xml` must validate against `Project.xsd` (CI
  oracle, WS-023) and re-import losslessly (round-trip test).
- `metadata.xml` ↔ `SongMetadata` is a trivial 13-field map.
- **The IR is a superset of DAWproject's model, not a subset:** it carries
  `foreign` and Wavi-only annotations (`waviRole`, `sha256`,
  `originalNativePath`) that never serialize into `project.xml` — they go to
  `wavi/session.json` on write.

## 4. Wavi extension manifest — `wavi/session.json` (inside the ZIP)

Everything Wavi-only. **NEVER duplicates musical content from project.xml.**

```jsonc
{
  "wavi_session_version": 2,
  "identity":   { "project_id": "…", "version_id": "…", "parent_version_id": "…" },
  "provenance": { "source_daw": "fl_studio", "source_daw_version": "21.2",
                  "adapter": "flstudio@1.0.0", "exported_at": "…", "exported_by_user": "…" },
  "attribution": { "collaborators": [{ "user_id": "…", "role": "…", "split": 0.5 }] },
  "security":   { "manifest": [{ "path": "audio/x.wav", "sha256": "…", "bytes": 1 }] },  // every ZIP entry
  "compat":     { "installed_plugin_matches": [], "missing_dependencies": [],
                  "results": [] },                    // per-target-DAW CompatibilityReport
  "renders":    { "reference_mix": "wavi/renders/mix.wav",
                  "tracks": { "<trackIrId>": { "dry": "wavi/renders/t1_dry.wav",
                                               "wet": "wavi/renders/t1_wet.wav" } } },
  "fidelity_report": "wavi/fidelity.json",            // §5 document
  "native_source":  { "path": "wavi/native/project.flp", "sha256": "…" },  // optional original
  "copilot":    { "context_notes": "…" },
  "warnings":   [ { "code": "…", "message": "…" } ]
}
```

Permissions, links, comments and analytics are intentionally **NOT** in the
file: they are live server-side state on the canonical Wavi Project
(DR-001/DR-003); baking them into an artifact would instantly make them
stale and would leak ACLs into anything shared. The manifest carries
identity so the receiving client can *ask the server* for that state.

## 5. Fidelity model (machine-readable)

`wavi/fidelity.json`:

```jsonc
{ "version": 1,
  "overall": "approximated",   // worst classification present
  "entries": [
    { "subject": { "type": "track|device|automation|media|clip|global", "irId": "…" },
      "class": "exact|approximated|rendered|metadata_only|unsupported",
      "reason": "human-readable why",
      "fallback": "wavi/renders/t1_wet.wav"   // optional pointer to substitute
    } ] }
```

`FidelityTag` in the IR is the same `{class, reason, fallback?}` triple; the
report is generated by walking the IR. Classification rules:
- `exact` — value survives conversion bit-meaningfully
- `approximated` — semantic mapping with defined loss (e.g. FL pattern →
  linear clips)
- `rendered` — replaced by audio render (plugin sound without the plugin)
- `metadata_only` — recorded (name/vendor/preset) but not functional
- `unsupported` — present in source, absent in target; listed, never silent

A report with zero entries is invalid — honesty is the feature (inherited
rule from WAVI_FL_TO_ABLETON_IMPLEMENTATION §6). The `overall` field is the
worst class present, so a UI can show one badge before the user commits.
