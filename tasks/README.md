# Wavi Task Packets

Lifecycle and rules: see `docs/AI_CONTROL_TOWER.md`. Each packet in
`ready/` is self-contained — a worker model needs only the packet + the docs
it references, not this conversation.

## Packet schema (every WS-### file)
ID · title · product outcome · technical objective · dependencies · repo ·
base branch · feature branch · worktree path (`~/wavi-worktrees/<branch>`) ·
files likely affected · exact requirements · prohibited work · DB/API
implications · unit tests · integration tests · interactive acceptance ·
security review · commit requirements · handoff report format · stop
conditions · recommended worker · recommended reviewer.

## Handoff (write to `handoffs/<ID>-<yyyy-mm-dd>.md` on completion)
Summary · branch+commits pushed · files changed · tests added & result ·
acceptance result (each criterion) · deviations from packet · blockers ·
remaining risk · reviewer + decision requested.

## Priority order (also in WAVI_90_DAY_EXECUTION_PLAN)
WS-004, WS-005, WS-006 (un-hold adapter) → WS-002, WS-003 (canonical link) →
WS-007, WS-008 (FL) → WS-009 (child versions) → WS-010, WS-011 (copilot) →
WS-012, WS-013 (portable) → rest.
