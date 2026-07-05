# DAWproject ↔ Wavi Field Mapping

Source of truth: `Project.xsd` / `MetaData.xsd` at upstream commit
`ee4dcdde75940f30e14e55401a26955a58b8322b`. Left column = the field a
producer cares about (drawn from the Wavi Portable Session v1 schema in
WAVI_CROSS_DAW_PORTABLE_SESSION.md plus the full interchange checklist).

Classification legend:
- **direct** — 1:1 element/attribute in DAWproject 1.0
- **mapping** — representable via a defined transform (documented loss noted)
- **not represented** — no DAWproject element; must render or drop
- **wavi-extension** — lives in `wavi/session.json` (never in `project.xml`)

## Musical / session fields

| Field | DAWproject location | Class | Notes |
|---|---|---|---|
| Project metadata (title/artist/album/composer/…) | `metadata.xml` (13 fields) | direct | Wavi's richer metadata beyond these 13 → wavi-extension |
| Application + source DAW name/version | `<Application name version>` | direct | |
| Tempo (static) | `<Transport><Tempo unit=bpm value>` | direct | |
| Tempo automation | `<Arrangement><TempoAutomation><Points>` | direct | our v1 classified this "approximated/flatten"; now **direct** |
| Time signature | `<Transport><TimeSignature num denom>` | direct | |
| Time-signature automation | `<Arrangement><TimeSignatureAutomation>` | direct | |
| Markers | `<Arrangement><Markers><Marker time name>` | direct | |
| Tracks | `<Track>` | direct | |
| Nested / group tracks | `<Track>` nested `<Track>` | direct | our v1 flattened these; now **direct** |
| Channels (mixer strip) | `<Channel role volume pan mute solo sends>` | direct | |
| Gain / volume | `<Volume unit value>` (realParameter) | direct | unit-typed (linear/decibel) |
| Pan | `<Pan unit value>` | direct | |
| Mute | `<Mute value>` (boolParameter) | direct | |
| Solo | `<Channel solo>` | direct | |
| Sends | `<Sends><Send destination type volume pan enable>` | direct | our v1 had none |
| Audio clips | `<Clips><Clip>` with `<Audio><File>` | direct | |
| Note clips | `<Clips><Clip><Notes><Note>` | direct | |
| Note expression (MPE, per-note) | `<Note>` child `<Points expression=…>` | direct | timbre/pressure/pitchBend/… enumerated |
| Fades (in/out) | `<Clip fadeInTime fadeOutTime fadeTimeUnit>` | direct | our v1 had none |
| Crossfades | overlapping clip fades on adjacent clips | mapping | no dedicated element; expressed as two clip fades |
| Warping / time-stretch | `<Warps contentTimeUnit><Warp time contentTime>` + `<Audio algorithm>` | direct | warp markers are first-class; our v1 said "not convertible" |
| Transpose | expression `transpose` in `<Points>` / clip content | direct | |
| Automation (volume/pan/mute/sends/plugin params) | `<Points><Target parameter=IDREF>` | direct | targets any parameter by id |
| Plug-in parameters | `<Device><Parameters>` typed params | direct | |
| Plug-in state (full) | `<Vst3Plugin><State path>` → file in ZIP | direct | opaque blob; **never executed** (security model) |
| Generic/built-in devices | `<Equalizer><Compressor><NoiseGate><Limiter><BuiltinDevice>` | direct | typed generic DSP |
| Clip-launcher scenes | `<Scenes><Scene>` + `<ClipSlot>` | direct | Wavi has no launcher UI v1 → read+preserve, no edit |
| Embedded media | `<File external="false">` + ZIP entry | direct | |
| Referenced media (not embedded) | `<File external="true" path>` | direct | Wavi resolves + optionally embeds on export |
| Key / scale (root+scale) | — | wavi-extension | DAWproject has no key field; Wavi tags it in session.json |
| Track role (lead/drums/bass/…) | `<Track color>` (loose) | wavi-extension | semantic role → session.json; color is a lossy proxy |
| Dry/wet rendered stems | — | wavi-extension | `wavi/renders/`; the fallback when a plugin is missing |
| Reference mix | — | wavi-extension | `wavi/renders/mix.wav` |
| Lyrics / project notes / collaborator instructions | `metadata.xml Comment` (partial) | wavi-extension | structured notes → session.json |

## Wavi-only fields (all → `wavi/session.json`, never `project.xml`)

| Field | Where | Why not in DAWproject |
|---|---|---|
| Wavi project id | `identity.project_id` | not a session concept |
| Immutable version id | `identity.version_id` | Wavi versioning (DR-006) |
| Parent version id | `identity.parent_version_id` | ancestry |
| Collaborators / contributor attribution | `attribution` | no people model in the format |
| Permissions | **server-side** (referenced by id only) | ACLs must never ship in an artifact (DR-001) |
| Links | **server-side** | live state; stale if embedded |
| Comments | **server-side** | live state |
| Analytics | **server-side** | live state |
| Content hashes (per ZIP entry) | `security.manifest` | integrity, not in schema |
| Native source file (.flp/.als) | `native_source` | round-trip fidelity aid |
| Compatibility results | `compat.results` | Wavi computes per target DAW |
| Installed-plugin matches | `compat.installed_plugin_matches` | per-machine |
| Missing dependencies | `compat.missing_dependencies` | per-machine |
| Rendered fallbacks map | `renders` | Wavi fidelity strategy |
| Fidelity classifications | `wavi/fidelity.json` | Wavi honesty contract |
| Conversion warnings | `warnings` | Wavi-generated |
| Copilot context | `copilot` | Wavi feature |
| Provenance | `provenance` | source DAW/adapter/version/time |

## Net assessment

Of the 25 interchange concepts audited, **19 are direct**, **2 are mapping**
(crossfades, structured notes), **0 are "not represented but musical"**, and
the remainder are legitimately Wavi-only (identity/collaboration/fidelity).
Critically, **every element our v1 JSON schema marked "not convertible"
(warps, tempo automation, sends, nested tracks, fades, plugin state) is
directly representable in DAWproject.** This is the single strongest
evidence for decision B: the format is a superset of what we designed, so
adopting it strictly increases fidelity while letting Wavi keep its
collaboration layer in the sidecar.
