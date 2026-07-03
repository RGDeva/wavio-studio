# Wavi 90-Day Execution Plan (from 2026-07-02)

Baseline truth: trunk `83b5a82e` ships sync-at-scale, Project Links (Ableton,
production-proven), Links page, Project Detail, Copilot v1 with safe
confirmation. Held: adapter branch (E2E). Blocked: wavio work while Codex is
active. Detailed packets: `tasks/ready/`. Routing: WAVI_MODEL_ROUTING.

## Days 0–10 — Consolidate & unblock (mostly Builder + one Architect slot)
- WS-004 packaged-app smoke of merged trunk (bounce, card visuals) → founder-visible build.
- WS-005 `wavi-media://` safe protocol → bounce plays in dev+prod.
- WS-006 **Ableton E2E on adapter branch + restore/launch dispatch → un-hold and merge** (Architect).
- WS-010/011 Copilot nav fix, overlay card, context provider.
- WS-015 dead-code sweep. WS-017 real-network run (needs founder token, DR-012).
- Founder: DR-004 (main), DR-011 (rotate keys), DR-013 (Backup/Backups).
**Exit:** one trunk containing everything, all E2Es green, no held branches.

## Days 10–30 — Canonical Link + server sync (the fragmentation kill)
- WS-002 canonical link compat layer in wavio the moment Codex idles
  (kind/version/capabilities columns on project_share_links, compat resolvers,
  backfill of listen+project tokens, per-link analytics view) — Architect schema, Builder routes.
- WS-003 `list-links` desktop action + Links page server reconciliation
  (registry becomes a cache per DR-001; other-device links appear; labels sync via server column).
- WS-014 real plays/downloads columns.
- WS-016→Phase E: shared public Link shell consolidating the four pages (with Codex coordination).
**Exit:** one Link model server-side; Links page shows ALL links with live status/analytics; legacy URLs still resolve.

## Days 30–55 — Second DAW + collaboration loop
- WS-007/008 FL Studio native packs: fixtures → detection/root/samples →
  manifest/pack → restore/launch → E2E with a real disposable .flp.
- WS-009 collaborator child versions (publish-child-version + RLS + ancestry
  UI in Project Detail) — closes the core promise loop: restore → edit → publish back.
- WS-020 restore error taxonomy (human copy for every failure).
**Exit:** an FL user and an Ableton user can each share natively; a collaborator can restore and publish a child version the owner sees.

## Days 55–80 — Cross-DAW proof + Copilot depth
- WS-012 portable-session schema package (shared, versioned).
- WS-013 minimal `.als` generator (Architect).
- FL→Ableton proof per WAVI_FL_TO_ABLETON_IMPLEMENTATION.md acceptance
  (8-track fixture opens in Live, in time, MIDI editable, honest fidelity report).
- Copilot: `create_project_link`, `compare_versions`, `summarize_project_activity`
  through the same envelope; context enriched from canonical link/version data.
**Exit:** the demo — publish FL project, collaborator opens generated Ableton session — works on fixtures.

## Days 80–90 — Hardening & beta gate
- WS-018/agent groundwork only (bridge audit; no DAW-control shipping).
- Full acceptance-index sweep, real-network numbers, packaged smokes on both channels.
- Beta checklist: DR-011 rotated, notarization, main reconciled, docs committed.
**Explicitly NOT in 90 days:** marketplace, Open Sessions, multiplayer, mobile, tokenization, Logic/REAPER adapters, Ableton→FL generation (design only), broad launch.
