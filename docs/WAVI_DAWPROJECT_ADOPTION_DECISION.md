# DAWproject Adoption Decision

**Decision: B — use DAWproject 1.0 inside a Wavi Portable Session superset.**
Ratified as DR-015 in WAVI_DECISION_REGISTER.md.

## Audit provenance (reproducible)

- Repo: https://github.com/bitwig/dawproject
- **Commit reviewed: `ee4dcdde75940f30e14e55401a26955a58b8322b`** (2025-07-12,
  "added mention of n-Track Studio in README"), 150 commits total, single
  release tag `v1.0.0`. License: MIT (© 2020 Bitwig) — compatible.
- Artifacts inspected directly (not just README): `Project.xsd` (843 lines,
  ~40 complex types), `MetaData.xsd` (13 optional string fields),
  `Reference.html`, Java DOM (`src/main/java/com/bitwig/dawproject/**`,
  JAXB-annotated classes as the source of truth for schema generation),
  `DawProject.java` (save/load/validate API), tests (`DawProjectTest` — 11
  @Test methods that generate projects programmatically and round-trip them;
  `test-data/` holds only a wav fixture), history/PRs (Java 21 modernization
  merged 2024 via PR #87/#88; `enable` attribute added post-1.0 in `23ba268`).
- Maintenance assessment: **stable, low-churn, credible**. Bitwig +
  Steinberg + PreSonus ship it in production DAWs; the format is explicitly
  frozen at 1.0 ("stable"). Low commit velocity is a feature here, not
  abandonment risk: the asset is the schema, not the Java library.

## What DAWproject is (verified against the XSD, not the README)

`.dawproject` = ZIP containing `project.xml` + `metadata.xml` + arbitrary
DAW-chosen media/plugin-state paths. `project.xml`: Application, Transport
(tempo/timesig as parameters), Structure (recursive Tracks + Channels with
Devices/Mute/Pan/Sends/Volume), Arrangement (nested Lanes per track → Clips
→ Notes/Warps+Audio/Points automation, Markers, TempoAutomation,
TimeSignatureAutomation), Scenes (clip launcher). Devices: Vst2/Vst3/Clap/Au
plugin (with `State` file reference — full plugin state in the ZIP) + generic
BuiltinDevice + typed Equalizer/Compressor/NoiseGate/Limiter. Automation
targets parameters by `IDREF`, or expression types (gain/pan/transpose/MPE
per-note expressions/pitchBend/CC…). Time in beats or seconds, mixable per
timeline; warps map beat-time↔content-time.

## Why B (superset), not the alternatives

- **Not A (adopt as THE Portable Session):** DAWproject has no fields for
  anything that makes Wavi Wavi — project/version identity, collaborators,
  permissions, links, comments, analytics, hashes, fidelity reports,
  dry/wet rendered fallbacks, Copilot context, provenance. The XSD is closed
  (no `xs:any`, `xs:ID` single-namespace): none of that can be legally
  embedded in `project.xml`. Adopting it "directly" would silently delete
  Wavi's collaboration layer or push it back into ad-hoc sidecars.
- **Not C (concepts only):** the concrete win is interop with shipping DAWs
  (Bitwig/Studio One/Cubase today) and every future DAWproject adopter, plus
  a community converter ecosystem. Copying concepts without the container
  buys none of that and still costs the modeling work.
- **Not D:** rejecting it means Wavi invents a redundant proprietary format
  that no DAW will ever read natively — exactly the trap this spike exists
  to avoid. The v1 Portable Session JSON (WAVI_CROSS_DAW_PORTABLE_SESSION.md)
  was headed there; DAWproject's model is a strict superset of its timing/
  track/clip semantics AND adds warps, fades, automation, plugin state,
  sends, nested tracks, scenes — all things our v1 schema classified as
  "not convertible" mostly because our container couldn't say them.
- **B challenged, and it survives:** the risk in B is dual-model drift
  (DAWproject XML vs Wavi manifest disagreeing). Mitigation: the Wavi
  extension NEVER duplicates musical content — it holds only identity,
  provenance, hashes, fidelity, renders, and compatibility data. Musical
  truth lives in `project.xml` once, period. Second risk: DAWproject's
  ecosystem stalls. Mitigation: even then, the schema is a better-designed
  IR target than our v1 JSON, MIT-licensed and frozen; worst case Wavi owns
  a well-specified format with three shipping implementations to test
  against. B's downside is bounded; A/C/D each throw away something real.

## The adopted layering (normative)

```
native DAW project ──(Wavi source adapter)──▶ Wavi Session IR
Wavi Session IR ──(dawproject writer)──▶ project.xml/metadata.xml
                                          + media + plugin states + wavi/ ─▶ .dawproject ZIP
.dawproject ZIP ──(dawproject reader, untrusted-input hardened)──▶ Wavi Session IR
Wavi Session IR ──(target adapter)──▶ native target project (.als first)
```

- **Container:** the Wavi Portable Session v2 IS a valid `.dawproject` file
  (extension `.dawproject`, opens directly in Bitwig/Studio One/Cubase) that
  additionally contains a `wavi/` directory: `wavi/session.json` (extension
  manifest — see WAVI_SESSION_IR_SPEC.md §4), `wavi/renders/` (dry/wet
  fallback stems), `wavi/fidelity.json`. Extra ZIP entries are ignored by
  conforming importers (verified: the Java loader reads only the entries it
  is asked for; the spec explicitly leaves ZIP layout to the exporter).
- **Wavi Project stays canonical.** DAWproject artifacts are versioned
  *outputs* attached to immutable Wavi versions (DR-006), carried over the
  existing Link/pack infrastructure. Identity, permissions, analytics,
  comments, Copilot all continue to hang off the Wavi Project — never off
  the interchange file.
- **No pairwise converters** (unchanged principle): adapters only ever speak
  Session IR; the DAWproject reader/writer is just another adapter pair.
- v1 Portable Session JSON is superseded before it ever shipped externally
  (it was design-only) — see updated WAVI_CROSS_DAW_PORTABLE_SESSION.md.

## TypeScript implementation decision

**Option 1+5: hand-written TypeScript types for the full 1.0 surface,
subset-validated semantics initially.** Rationale:
- The schema is small and frozen (~40 types, one 843-line XSD). Hand-porting
  is a day of careful work and yields idiomatic discriminated unions;
  generators (xsd2ts etc.) produce hostile output for `xs:choice`-heavy
  recursive schemas and add a toolchain for a schema that will not change.
- **No Java subprocess.** Shipping a JRE inside the Electron app for a ZIP+
  XML format we can parse natively is indefensible (size, startup, security
  surface). The Java library remains a *test oracle*: CI can optionally run
  it to cross-validate fixtures, never at runtime.
- No existing TS package is mature (npm survey: nothing with meaningful
  adoption as of the audit date — re-verify at WS-023 kickoff).
- Concrete choices (locked for WS-023): package `electron/adapters/
  dawproject/` (pure TS, no Electron imports, mirroring `flpReader`
  placement); XML parse `fast-xml-parser` (already vetted class of dep;
  DTD/entities disabled — it does not expand external entities) with
  attribute-preserving round-trip config; XML write: dedicated typed
  serializer (same builder-from-typed-nodes strategy as `alsWriter`); ZIP:
  `yauzl`/`yazl` (streaming, size-capped; NOT `extract-zip` — no traversal
  guards); validation: structural TS validators generated by hand per type +
  the official XSD run in CI via the Java oracle, not at runtime; unknown
  elements/attributes preserved in an `unknown` bag per node so a
  re-emitted file keeps foreign data byte-meaningful (forward compatibility
  with 1.x); `Project@version` accepted `1.0` exactly, warn-and-attempt on
  `1.x`, refuse `>=2`.

## Consequences for current architecture

Exact deltas (details in WAVI_CROSS_DAW_ARCHITECTURE_V2.md):
1. `DawAdapter.exportPortableSession/importPortableSession` re-typed to
   produce/consume **Session IR** (not the v1 JSON).
2. New `electron/adapters/dawproject/` reader+writer pair (WS-023).
3. WS-012 (portable-session schema package) is **superseded**: the schema
   work becomes the Session IR + wavi/session.json spec.
4. WS-008 (FLP inspection) unchanged as a parser but its output target
   becomes Session IR (WS-025 covers the delta).
5. WS-013 (.als generator) unchanged in mechanics; its input becomes Session
   IR (WS-026 covers the delta).
6. Fidelity reporting moves from ad-hoc JSON to the typed model in
   WAVI_SESSION_IR_SPEC.md §5 and ships inside `wavi/fidelity.json`.

## Converter ecosystem audit

- **DawVert** (SatyrDiamond) — Python multi-format converter, reads .flp,
  writes .dawproject. License: **GPL-3.0** → **must never be linked or
  vendored** into Wavi (proprietary app). Approved uses: research reference
  for FLP event semantics, and *offline generation of test fixtures* on a
  dev machine (GPL output files are not GPL). Maintenance: active hobbyist,
  single maintainer — treat as unstable reference, pin a commit when citing.
- **ProjectConverter** (git-moss) — Java, Reaper↔DAWproject. License:
  **LGPL-3.0**; Java anyway, so production reuse is out for the same
  no-JRE reason. Approved uses: generating REAPER-side fixtures and
  compatibility comparison during WS-023 testing. Actively maintained by a
  credible author (moss/DrivenByMoss).
- Neither becomes a dependency. Both become fixture factories + oracles.

## Stop conditions honored

Production stabilization freeze untouched; no production code modified;
spike code (if any) lives only on `spike/dawproject-adoption`.
