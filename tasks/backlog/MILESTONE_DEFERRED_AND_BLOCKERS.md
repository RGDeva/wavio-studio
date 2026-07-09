# Ableton Reference Milestone — deferred tasks & live blocker

Date: 2026-07-09 · Scope note: this loop is limited to proving/fixing/integrating
the Ableton reference milestone. Broader items below are **recorded, not
implemented here** (per instruction). Authority: verified code/tests > DR-015 >
task packets > execution plan > interop plan. DR-015 canonical portable session
stays `project.dawproject` + native project + `wavi/session.json` +
`wavi/fidelity.json` + referenced assets — **no second musical-session schema.**

## Live blocker (why the milestone can't complete autonomously)

- **Authentication expired.** The stored desktop `authToken` (all channels)
  returns **HTTP 403** from `POST /api/desktop/index`. Re-auth requires a Privy
  browser sign-in (credentials), which the agent is prohibited from doing.
- Consequently **every cloud milestone step is blocked**: publish immutable
  version, create Project Link, resolve link, download package, restore,
  contribution return. The milestone merge condition (Project Link creation +
  native Ableton restore + child-version return) therefore cannot be exercised.
- **GUI capability is Class A** (full: screenshot + activate + keystroke + menu,
  proven), and **Ableton Live 12.4.2 Suite** is installed — so once a valid
  session exists, most of the flow is autonomously drivable. Unblock = founder
  signs in, then run `docs/WAVI_ABLETON_E2E_RUNBOOK.md` (or re-run the loop).
- Environment note: launch the dev app and query GUI state via the **`Electron`**
  process name in dev (not `Wavi Studio`); the window is 1280×800. The unsigned
  packaged build showed 0 windows under `open` — prefer `npm run dev` for live
  checks.

## Milestone items still to prove (blocked on the sign-in above)

- [ ] Sender: sync → publish immutable version → create Project Link → recipient URL resolves
- [ ] Recipient: deep link → authz → download → manifest+SHA-256 verify → restore native `.als`+deps → Ableton opens, no "Temp Project", no Wavi-caused missing media
- [ ] Restore safety: duplicate-destination choice (no silent overwrite); revoke kills resolve/import
- [ ] Contribution return: child version references original, parent recorded, contributor recorded, original immutable, no unrelated project, owner sees it
- [ ] Live visual smoke: compatibility card + summary render without overlap; playback/pause/seek/switch via `wavi-media://`; assistant Open-in-DAW confirmation card (model can't self-confirm). *(Logic already covered by 493 unit tests + 10/10 real-Electron wavi-media E2E; needs a live-window pass.)*

## Deferred broader requirements (NOT this loop — later tasks)

- **Recipient project-style page** (Codex/web): source DAW, version, file sections,
  compatibility summary, Open-in-DAW / Download Project Pack / Open in Wavi Studio.
  Contract already specified in `docs/handoffs/CODEX-HANDOFF-recipient-and-projectpack-contracts.md`.
- **ZIP / Project Pack download** (Codex/web): authorized-assets-only, safe paths,
  hashes, `project.dawproject` + `wavi/` layout; exact shapes in the handoff packet.
- **Short-lived import-token issuance** (Codex/web) for Open-in-DAW deep links.
- **Contribution submission contract** (Codex/web): child-version endpoint with
  `parentVersionId` + contributor + permission gating.
- **Additional DAWs**: FL Studio adapter (WS-007/008) + FL→FL native handoff —
  deferred until after the Ableton reference milestone (see
  `docs/WAVI_FL_STUDIO_API_MCP_AUDIT.md`). No FL code during this milestone.
- **Cross-DAW reconstruction** (FL↔Ableton via Session IR / `.dawproject`,
  WS-023..026) — later; not part of the reference milestone.
- **Broader desktop UI passes** (Home/Projects/Library/Links/Activity/Assistant
  polish, version branch graph, package-completeness 3D) — execution plan §13
  Pass 2–4; only the Project-Detail-supporting surfaces were touched this loop.

## Proven & integration-ready (this session)

Release candidate `integration/ableton-reference-milestone @ b0a6e672`
(feature/ableton-daw-companion @ 6600cfa5 + 7 branches): both tsc clean, **493
tests / 0 skips**, adapters 24, restore.security 37, copilot 21, real-Electron
wavi-media E2E 10/10, unsigned packaged build ok, root Electron SQLite untouched,
test-native loads under Node 22, no secrets / no new absolute paths / opaque
`wavi-media://` only in renderer. **Not merged** into the target branch (gated on
the live E2E per the milestone merge condition).
