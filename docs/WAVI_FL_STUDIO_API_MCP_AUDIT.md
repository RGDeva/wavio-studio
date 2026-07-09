# FL Studio Scripting API + MCP Audit

Audit date: 2026-07-09 · Desktop lane (/loop cycle 7) · Status: research + packet prep, no code
Authority: verified vendor docs > DR-015 (DAWproject Option B / Session IR) > adapter architecture.

Purpose: answer the sequencing question "what can FL Studio's *live scripting* and
public *MCP* surfaces actually do for Wavi, and what should the FL adapter rely
on?" This is the **scripting/live** dimension. The **offline `.flp` file** path is
already designed in `WAVI_FL_TO_ABLETON_IMPLEMENTATION.md` + packets WS-008
(FLP reader), WS-007 (adapter skeleton), WS-025/026 (dawproject spikes) and is
unchanged by this audit.

---

## 1. Official FL Studio scripting — what exists

FL Studio ships **two** Python scripting surfaces (Image-Line official). API
reference: the online manual + the Image-Line-group API stubs
`il-group.github.io/FL-Studio-API-Stubs`.

### 1.1 MIDI Controller Scripting (Python)
- Purpose: make an arbitrary MIDI controller drive FL. ~14 modules
  (`transport`, `mixer`, `channels`, `arrangement`, `patterns`, `playlist`,
  `device`, `ui`, `general`, `plugins`, `screen`, `launchMapPages`, `utils`,
  `callbacks`).
- Paradigm: **event-driven control of a *running* FL instance** through a
  registered controller script. Reads/sets transport, mixer levels, channel
  state, some plugin params; can trigger UI actions.
- **Hard limits for Wavi's needs:**
  - No arbitrary filesystem I/O — it is not a general Python runtime.
  - **Cannot read or write the `.flp` project file.** No "export project",
    "save as", "consolidate/render stems", or "read arrangement to disk" call
    that yields a portable artifact.
  - Requires FL **running** with the script installed in the user's FL config.
  - No headless / batch mode; no "open project X and report its contents".

### 1.2 Piano Roll Scripting (`flpianoroll`)
- Purpose: manipulate notes in the **currently open** piano roll (Python).
  `score` (notes/markers), `Note`, `Marker`, `ScriptDialog`.
- **Not** available inside MIDI Controller Scripts; runs only in the piano-roll
  context on the active clip. Scope = the open selection, not the project, not
  the filesystem.

### 1.3 Native project open
- Opening an `.flp` needs **no API**: launch FL with the file path via the OS
  handler (same mechanism as the Ableton `.als` launch). Same-DAW open is a
  shell-open, not a scripting problem.

---

## 2. Conclusion for the FL adapter

**FL live scripting is NOT a viable basis for Wavi's project foundation.** None
of folder-watching, project detection, packaging, hashing, versioning, restore,
or dependency collection can be built on the scripting API — it cannot read the
project file or touch disk, and it needs FL running.

Therefore the FL adapter must be built on the **already-designed offline path**:

| Adapter concern            | Mechanism (verified design)                                  |
|----------------------------|--------------------------------------------------------------|
| detection / classification | file walk + `.flp` extension (WS-007), same as Ableton       |
| metadata (bpm/key)         | **offline FLP TLV parse** (WS-008), not scripting            |
| dependency collection      | FLP sample-path events (WS-008) + file walk                  |
| native packaging           | copy `.flp` + referenced assets (generic packer + adapter)   |
| restore                    | generic restore + `locateProjectFile` (already extracted)    |
| same-DAW open              | OS shell-open of `.flp` (no API)                              |
| cross-DAW reconstruction   | FLP → **Session IR** → `.dawproject` (DR-015; WS-025/026)     |
| fidelity reporting         | `wavi/fidelity.json` from unknown/length-skipped FLP events  |

This confirms the existing packet strategy. **No new proprietary format** — the
FL adapter targets the Session IR / DAWproject superset (DR-015), never a second
schema.

### Proposed FL adapter `capabilities()` (honest, matches today's reader)
`{ detect: true, packageNative: true, restore: true, sameDawOpen: true,
   crossDawReconstruct: false /* until WS-025/026 land */, scanPlugins: false
   /* FLP lists plugin *names* only; no state */, fidelityReport: true }`

---

## 3. Public FL Studio MCP survey (all UNOFFICIAL — verification required)

There is **no Image-Line / official FL Studio MCP server.** Multiple community
projects exist; every one observed wraps the **MIDI Controller Scripting** and/or
**piano-roll** surface (i.e. live control of a running FL), not project
file/packaging access:

| Project (community, unverified) | Surface it wraps |
|---|---|
| `karl-andres/fl-studio-mcp` | MIDI comms + piano-roll scripts |
| `calvinw/fl-studio-mcp` | piano-roll interaction |
| `szichedelic/fl-studio-mcp` | transport/pattern control via MIDI |
| `ohhalim/flstudio-mcp` | virtual MIDI ports |
| `quinnjr/fruityloops-mcp` | FL Python API + MIDI |

**Assessment (answers the open question in the interoperability plan §30):**
- None is a verified, authoritative reference. Before any dependency, each needs
  a review of **license, maintenance status, security posture (arbitrary control
  of a running DAW), and pinned provenance** — treat as untrusted third-party
  code (mirror the DAWproject-import security posture, WAVI_DAWPROJECT_SECURITY_MODEL).
- Because they all wrap live control, **an MCP cannot supply the portable
  session, project model, folder-watching, packaging, versioning, or
  permissions** (consistent with DR-015 and interoperability-plan Decision 10).
- **Correct role of an FL MCP (future, optional):** a Wavi-Agent *structured
  action* surface — "in the open FL project, add a MIDI clip / set tempo" —
  layered behind DR-014's permission-gated automation, **after** the offline
  adapter + Session IR foundation exists. It is not on the reference-milestone
  critical path.

---

## 4. Bounded FL packets (sequencing — do NOT start during the Ableton milestone)

Existing packets stay authoritative; this audit adds the scripting/MCP framing
and one new spike packet. Order:

1. **WS-007 — FL adapter skeleton** (exists). Offline `DawAdapter` for `.flp`
   (detect/classify/Backup-exclusion/`capabilities()` per §2). Now also: wire
   `capabilities()` and `locateProjectFile` (contract methods added in WS-006
   step 2). No FLP parsing.
2. **WS-008 — FLP reader** (exists). Offline TLV parse for bpm/key/title/channel
   names/sample paths/playlist; unknown events length-skipped + counted for
   fidelity. Feeds `extractMetadata` + dependency collection.
3. **FL→FL native same-DAW handoff** (covered by the generic pipeline + WS-007;
   validate as a bounded E2E once WS-007/008 land — mirrors the Ableton round
   trip; needs founder session for the network steps).
4. **WS-025 — FL → dawproject spike** (exists). FLP → Session IR → `.dawproject`.
5. **WS-026 — dawproject → Ableton spike** (exists). Closes Ableton↔FL cross-DAW.
6. **NEW · WS-FL-MCP-SPIKE (deferred, post-milestone):** evaluate ONE community
   FL MCP for a *Wavi-Agent structured-action* PoC only — license/security/
   maintenance review first; sandboxed; permission-gated per DR-014; explicitly
   **not** a data-model or packaging dependency. Blocker-gated on that review.

**Cross-DAW reconstruction (WS-025/026) is NOT part of the Ableton reference
milestone** and must not begin during it (per the loop's non-goals).

---

## 5. Handoff / blockers

- **No web/backend contract needed** for the FL adapter foundation — it is fully
  local (file parse + shell-open). Cross-DAW reconstruction later reuses the
  existing Project Pack / import-token contracts already noted for Codex.
- **Blocked (not polled):** any *live* FL scripting/MCP validation needs FL
  Studio installed + a running session (founder-attended), exactly like the
  Ableton E2E. The offline adapter + FLP reader (WS-007/008) need neither and
  are the correct next FL work — **after** the Ableton reference milestone.

## Sources
- FL Studio MIDI Scripting (Python) — Image-Line manual: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/midi_scripting.htm
- Piano Roll Scripting API — Image-Line manual: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll_scripting_api.htm
- FL Studio Python API stubs (Image-Line group): https://il-group.github.io/FL-Studio-API-Stubs/
- Community FL MCP servers (unverified): https://github.com/karl-andres/fl-studio-mcp · https://github.com/calvinw/fl-studio-mcp · https://github.com/szichedelic/fl-studio-mcp · https://github.com/ohhalim/flstudio-mcp · https://quinnjr.github.io/fruityloops-mcp/
