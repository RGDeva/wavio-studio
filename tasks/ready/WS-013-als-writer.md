# WS-013 · Minimal Ableton Live Set writer  [ARCHITECT]
**Product outcome:** Wavi can GENERATE an Ableton project — the receiving half of the FL→Ableton proof.
**Technical objective:** `electron/adapters/ableton/alsWriter.ts` per docs/WAVI_FL_TO_ABLETON_IMPLEMENTATION.md §5: typed-node XML builder (no string concat) → gzip; audio tracks with warp-off clips at beat offsets (RelativePathType 3 → Samples/Imported/), MIDI tracks with KeyTracks/Notes, master tempo+time-sig, Locators, names/colors, Info Text breadcrumbs; emit a full Wavi pack folder incl. `Ableton Project Info/` marker.
**Dependencies:** WS-012 (input type = PortableSession). **Repo:** wavio-studio. **Base:** trunk (+WS-012 merged). **Branch:** feat/als-writer. **Worktree:** ~/wavi-worktrees/als-writer.
**Files:** electron/adapters/ableton/alsWriter.ts, xml helpers, golden fixture .als (generated deterministic), tests.
**Exact requirements:** self-round-trip: parseAbletonLiveSet(ourOutput) returns our bpm/key; gunzip+well-formed XML; golden diff stable across runs (no timestamps/uuids in output unless seeded); output restores through the EXISTING restore machinery in a manual dev check.
**Prohibited:** automation/warping/racks emission; touching the reader; claiming Live-open validation (that's the assembly proof's founder gate).
**Unit:** builder nodes, beat math (PPQ-free — session is already beats), path safety (rel-paths only). **Integration:** vitest. **Interactive:** generated pack restores via RestoreWindow into a scratch dir without errors. **Security:** rel-path emission only.
**Commits:** xml / writer / goldens. **Handoff:** standard + a generated fixture attached path. **Stop:** if Live's schema demands fields we can't determine without a Live-made sample project — request one from the founder, don't guess silently.
**Worker:** Architect. **Reviewer:** Critic.
