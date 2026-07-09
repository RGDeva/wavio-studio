# Wavi Cross-DAW Architecture V2

Supersedes the pairwise/JSON-schema thinking in
WAVI_CROSS_DAW_PORTABLE_SESSION.md v1. Ratified by DR-015. This is the
target architecture for all cross-DAW work; the v1 doc is retained for
history with a superseded banner.

## 1. The hub-and-spoke model (one IR, no pairwise converters)

```
  FL .flp ─┐                                      ┌─▶ Ableton .als
  Ableton .als ─┤                                  │
  DAWproject ───┼─▶  Wavi Session IR  ─────────────┼─▶ DAWproject (.dawproject)
  (Studio One/  │   (the ONLY internal model)      │
   Cubase/…)   ─┘                                  └─▶ FL .flp (later)
```

- **Native adapters** convert `native ⇄ Session IR` only. To add a DAW you
  write one reader and (optionally) one writer against the IR — never a
  converter for each other DAW. N DAWs ⇒ ≤2N adapter halves, not N².
- **DAWproject reader/writer** is just another adapter pair
  (`electron/adapters/dawproject/`), distinguished only by being the
  standards-compatible interchange artifact and by carrying the Wavi
  extension sidecar.
- The **Session IR** (WAVI_SESSION_IR_SPEC.md) is the contract. No
  XML-library type ever crosses an adapter boundary (DR-015).

## 2. The interchange artifact

The Wavi Portable Session v2 **is a valid `.dawproject` ZIP** (opens in
Bitwig/Studio One/Cubase directly) plus a `wavi/` directory holding the
extension manifest, fidelity report, and rendered fallbacks
(WAVI_SESSION_IR_SPEC §4–5). Musical truth lives once, in `project.xml`.
Wavi-only data lives in `wavi/`. The two never duplicate.

## 3. The three compatibility levels (unchanged promise, new mechanism)

| Level | Promise | Mechanism (v2) |
|---|---|---|
| Native | max fidelity, same DAW | Project Pack via the native adapter (Ableton→Ableton today) |
| Portable Session | editable cross-DAW | `.dawproject` superset via Session IR; native import where the DAW supports it, Wavi-generated native project (.als) where it doesn't |
| Universal Pack | anyone contributes | reference mix + stems + MIDI + key/BPM + notes (the `wavi/renders/` subset alone) |

Every Link/restore still shows the level and per-element fidelity **before**
commit — now driven by the typed `wavi/fidelity.json` instead of ad-hoc JSON.

## 4. Canonical-object boundary (unchanged, reaffirmed)

The **Wavi Project remains the canonical** collaboration/versioning/identity/
permission/analytics/Copilot object (DR-006, DR-001). A `.dawproject` is a
versioned *output* attached to an immutable Wavi version and distributed over
the existing Link/pack infrastructure. Permissions/links/comments/analytics
stay server-side and are referenced by id from the manifest, never embedded.

## 5. Impact on the existing roadmap

| Old packet | Fate |
|---|---|
| WS-012 portable-session JSON schema package | **superseded** → Session IR spec + `wavi/session.json` (WS-023/024) |
| WS-008 FLP inspection | unchanged parser; **output retargeted** to Session IR (WS-025) |
| WS-013 `.als` generator | unchanged mechanics; **input retargeted** to Session IR (WS-026) |
| Adapter `exportPortableSession/importPortableSession` | **retyped** to Session IR (WS-024) |

New packets: WS-023 (dawproject reader/writer), WS-024 (Session IR + adapter
migration), WS-025 (FL→dawproject spike), WS-026 (dawproject→Ableton spike).

## 6. Why this is strictly better than v1

The v1 JSON schema marked warps, tempo automation, sends, nested tracks,
fades, and plugin state as "not convertible" — largely because its container
couldn't express them. DAWproject expresses all of them (see
WAVI_DAWPROJECT_FIELD_MAPPING.md). Adopting it as the IR target raises the
fidelity ceiling, gives free interop with a shipping-DAW ecosystem, and
preserves Wavi's differentiation (collaboration + honest fidelity) in the
sidecar. The cost is bounded: a hand-written TS reader/writer for one small,
frozen, MIT-licensed schema, hardened against untrusted input.
