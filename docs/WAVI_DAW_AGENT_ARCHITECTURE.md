# Wavi Agentic DAW-Control Architecture

Implementation-grade design for a Wavi agent that can understand and act
inside DAWs. **Design doc — nothing here ships in the 90-day plan beyond
WS-018 bridge groundwork.** Binding safety rule: DR-014 — the language model
never gets unrestricted shell or arbitrary computer control.

## Layered control strategy (try in order; never skip to a lower tier)

1. **Native DAW API / scripting** — highest fidelity, safest. Reaper
   (ReaScript Lua/Python — full session control), Live 12 (Max for Live +
   the Live Object Model over a local device; also AbletonOSC), Logic
   (limited: Scripter MIDI + Logic Pro scripting is thin), FL (MIDI scripting
   20.7+, no project construction), Pro Tools (EUCON/AAX, PTSL SDK — gated).
   Only documented, stable API surfaces.
2. **Wavi adapter method** — the adapter (WAVI_DAW_ADAPTER_ARCHITECTURE)
   exposes capability methods; the agent calls those, never the DAW directly.
3. **Plugin / extension** — a Wavi M4L device / Reaper extension / (future)
   AU that opens a localhost control channel to the Wavi Studio bridge.
4. **Accessibility API automation** — macOS AX / Windows UIA to read state
   and click named controls, when 1–3 can't. Named-element only; no blind
   coordinate clicks.
5. **Screen control** — LAST resort, read-mostly, explicit per-session founder
   opt-in, every action confirmed. Never the default path.

## Components

- **Wavi Studio local bridge** (exists: `electron/bridgeServer.ts`, localhost,
  token-gated — WS-018 audits/hardens it). Becomes the single mediator: the
  DAW-side plugin/script and the agent both speak to the bridge; the model
  never speaks to a DAW socket directly.
- **Capability registry**: each DAW declares which tier-1/2 ops it supports
  (read: project snapshot, track list, tempo, plugin inventory, mixer state,
  automation; write: create MIDI clip, set gain/pan, add plugin, render stems,
  create send/sidechain). Ops are typed, versioned, and flagged read-only vs
  write.
- **Installed-plugin inventory**: scanned once per machine (paths from
  standard AU/VST/VST3 dirs), cached; used to decide what a portable session
  can reconstruct natively vs must render.
- **Snapshot/rollback**: before any WRITE op, the bridge captures a session
  snapshot (DAW save-as-copy where the API allows, else a Wavi project pack)
  → op runs → verify → on failure or user "undo", restore snapshot. No write
  op without a captured rollback point.

## Agent tool contract (extends the Copilot envelope, DR-002)

Every DAW action is a typed Copilot tool: `{daw, op, args}` → validated →
permission-checked (write ops require signed-in + project-owned) →
**write ops are confirmation-gated out-of-band** (card shows DAW, op,
affected tracks/clips, reversibility) → executed via the highest available
tier → audited to activity_log with tier used + rollback id → typed result.
Read ops: no confirmation, audited. Failure: typed error + automatic rollback
for writes; never partial-silent.

## Safe execution boundaries (hard limits)

- Allowlist of op types per DAW; anything not in the registry is refused.
- No arbitrary code execution: ReaScript/M4L payloads are Wavi-authored
  templates parameterized by validated args, never model-authored strings.
- No filesystem writes outside the project root; no network from DAW scripts.
- Screen/AX tiers are opt-in per session and per-op-confirmed, with a visible
  "Wavi is controlling <DAW>" indicator.
- Rate-limited; a single request maps to a bounded op count.

## Rollout (post-90-day, gated per stage)

Stage 1 read-only (snapshot/inspect) on Reaper+Live via tier 1 → Stage 2
low-risk writes (create MIDI clip, set track name/gain) with rollback →
Stage 3 render/stem export → Stage 4 vocal-chain/sidechain templates.
Each stage: its own acceptance suite + founder sign-off. WS-018 only builds
the bridge/capability-registry groundwork and the read-only Reaper spike.
