# Wavi Model Routing

Who does what. "Architect" = frontier model (Fable-class). "Builder" =
cheaper Claude (Sonnet-class; Haiku for mechanical edits). "Critic" = GPT
reasoning model (independent review). "Codex" = isolated implementation
branches when that agent/access is available.

## Routing matrix

| Work type | Primary | Reviewer | Notes |
|---|---|---|---|
| Architecture, schema/migrations, security, concurrency, cross-DAW algorithms, DAW-agent design, unblocking stuck workers | Architect | Critic | Scarce — spend only here |
| Bounded UI/React, IPC plumbing, CRUD, styling, empty states | Builder | Critic or Architect (spot) | Task packets only |
| Test expansion, mirror-SQL tests, fixtures | Builder | Architect (assertions must be meaningful) | |
| Docs, handoffs, changelogs | Builder/Haiku | — | |
| Independent spec/architecture critique, adversarial test design, UI/product critique | Critic | Architect adjudicates | Paste the doc + packet; ask for failure modes |
| Repetitive multi-file changes, isolated bugfix branches | Codex | Architect | Own branch + PR-style handoff |
| Mechanical renames, import cleanup, comment fixes | Haiku | Builder | |

## In-environment delegation (what actually works here)

Claude Code sessions can spawn subagents via the Agent tool with
`model: "sonnet" | "haiku"` — REAL delegation, verified. Rules: one packet
per subagent; give it the packet file content as the prompt; require worktree
isolation (`~/wavi-worktrees/<branch>`) and a handoff file; the parent session
reviews the diff before any merge. GPT/Codex are NOT invokable from this
environment — for those, paste the packet's WORKER PROMPT into their own UI
and require the same handoff format back into `handoffs/`.

## Per-ready-task assignments

| Task | Worker | Reviewer |
|---|---|---|
| WS-001 links-server-labels groundwork | Builder | Architect |
| WS-002 canonical link compat layer (wavio) | Architect (schema) + Builder (routes/tests) | Critic |
| WS-003 links page server sync | Builder | Architect |
| WS-004 project detail packaged smoke fixes | Builder | Critic |
| WS-005 wavi-media safe protocol (bounce playback) | Builder | Architect (security) |
| WS-006 Ableton adapter E2E + restore dispatch | Architect | Critic |
| WS-007 FL adapter skeleton + fixtures | Builder | Architect |
| WS-008 FLP parser (timing/MIDI/names) | Architect | Critic |
| WS-009 collaborator child versions (server) | Architect (RLS) + Builder | Critic |
| WS-010 copilot card polish + overlay card | Builder | Critic |
| WS-011 copilot context provider (selected project/version) | Builder | Architect |
| WS-012 portable-session schema package | Architect | Critic |
| WS-013 .als generator (minimal Live Set writer) | Architect | Critic |
| WS-014 links page analytics columns (after WS-002/003) | Builder | Builder |
| WS-015 dashboard/dead-code cleanup | Haiku | Builder |
| WS-016 public link shell audit prep (wavio, read-only until Codex idle) | Builder | Architect |
| WS-017 real-network validation run docs+wrapper | Builder | Architect |
| WS-018 bridge server audit (DAW agent groundwork) | Architect | Critic |
| WS-019 acceptance-test automation harness index | Builder | Architect |
| WS-020 restore UX error taxonomy | Builder | Critic |
