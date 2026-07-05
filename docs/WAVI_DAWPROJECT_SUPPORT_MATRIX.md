# DAWproject Support Matrix

Native-support claims are taken **only** from the upstream README at commit
`ee4dcdde75940f30e14e55401a26955a58b8322b`. Anything not listed there is
marked "unverified" and must be proven with an actual fixture test before
Wavi claims it in product copy. **Do not claim import vs export granularity
that the upstream source does not state** — the README lists DAWs that
"support DAWproject 1.0" without splitting import/export; treat each as
"unverified direction" until a fixture round-trips.

## Native DAWproject support (per upstream README)

| DAW | Min version (README) | Direction | Wavi obligation |
|---|---|---|---|
| Bitwig Studio | 5.0.9 | unverified (assume import+export; it is the reference impl) | none — native; best fixture oracle |
| PreSonus Studio One | 6.5 | unverified | none — native |
| Steinberg Cubase | 14 | unverified | none — native |
| Steinberg Cubasis | 3.7.1 | unverified | none — native |
| Steinberg VST Live | 2.2 | unverified | none — native |
| n-Track Studio | 10.2.2 | unverified | none — native |

For every "native" DAW, Wavi still writes a valid `.dawproject`; whether the
Wavi extension (`wavi/` dir) survives a round-trip through that DAW is
**unverified** and a WS-023 fixture-test item (conforming importers should
ignore unknown ZIP entries, but this must be proven per DAW, not assumed).

## DAWs Wavi cares about that are NOT natively supported

| DAW | Native DAWproject? | Path for Wavi | Packet |
|---|---|---|---|
| Ableton Live | **No** | Wavi `SessionIR → .als` writer (already the FL→Ableton target) | WS-026 |
| FL Studio | **No** | Wavi `flpReader → SessionIR → .dawproject` | WS-025 |
| Logic Pro | **No** | Wavi adapter (future; closed format, conservative) | future |
| Pro Tools | **No** | Wavi adapter (future; closed format) | future |
| REAPER | **No** (not in README) | git-moss **ProjectConverter** (LGPL-3.0) — fixtures/comparison only, not vendored | fixtures |
| Studio One | Yes (6.5) | native | — |
| Cubase | Yes (14) | native | — |
| Bitwig | Yes (5.0.9) | native | — |

## Reading the matrix

- The big three Wavi audiences — **Ableton, FL, Logic — have no native
  DAWproject support.** This does NOT weaken decision B: Wavi provides the
  adapter (SessionIR↔native) exactly as it would have for any interchange
  format, and DAWproject buys native interop with the Steinberg/PreSonus/
  Bitwig ecosystem *for free* on top. The adapter work was always required;
  the format choice only changes the artifact those adapters emit/consume.
- "Native support" is a moving target — re-check the upstream README at each
  WS-023/025/026 kickoff and update this table with the commit reviewed.
- **No support claim ships to users without a committed fixture test.** A
  green round-trip against a real project file from that DAW is the only
  evidence that counts; the README is a starting hypothesis.

## Converter tools (audited — neither is a dependency)

| Tool | License | Runtime | Approved use | Prohibited |
|---|---|---|---|---|
| DawVert (SatyrDiamond) | **GPL-3.0** | Python | offline fixture generation, FLP-event research | linking/vendoring into Wavi (copyleft) |
| ProjectConverter (git-moss) | **LGPL-3.0** | Java | REAPER-side fixtures, compatibility comparison | runtime dependency (no JRE in app) |
