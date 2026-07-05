# WS-024 — Session IR + adapter contract migration

- **ID:** WS-024 · **Priority:** cross-DAW foundation (post-freeze)
- **Product outcome:** all adapters speak one internal model; no behavior
  change to shipping Ableton pack/restore.
- **Technical objective:** introduce `electron/adapters/sessionIR/` as the
  canonical IR and retype the adapter interop methods to it.
- **Dependencies:** WAVI_SESSION_IR_SPEC.md; pairs with WS-023. **Repo:**
  wavio-studio. **Base:** `spike/dawproject-adoption` tip (or WS-023 branch
  if stacking). **Feature branch:** `refactor/session-ir`. **Worktree:**
  `~/wavi-worktrees/session-ir`.
- **Files:** new `electron/adapters/sessionIR/{types.ts,index.ts,*.test.ts}`;
  `electron/adapters/types.ts` (`DawAdapter.exportPortableSession` /
  `importPortableSession` signatures → `SessionIR`).

## Exact requirements
1. Move the Session IR types (WAVI_SESSION_IR_SPEC §2) into a pure-TS package,
   no Electron imports.
2. Retype `DawAdapter.exportPortableSession(projectRoot): Promise<SessionIR>`
   and `importPortableSession(ir: SessionIR, destDir): Promise<string>`.
   These were previously typed to the v1 `PortableSession` JSON — remove that
   type or alias it deprecated.
3. **No behavior change** to the existing Ableton native pack/restore/launch
   paths — those do not go through the IR yet (they stay native Project
   Packs). Only the *interop* methods change type. Prove with the existing
   adapter contract test suite staying green.
4. Update WAVI_DAW_ADAPTER_ARCHITECTURE.md's interface block to match
   (already noted there; keep in sync).

## Prohibited
Changing Ableton pack/restore semantics; introducing DAWproject I/O here
(that is WS-023); any production data path.

## Tests
IR type construction + a fixture SessionIR round-tripped through
JSON.stringify (structural stability); adapter contract suite unchanged/green;
tsc clean.

## Commit / handoff / stop
Conventional commits; push; handoff per schema. STOP if the Ableton contract
tests change behavior — that means the refactor leaked. Recommended: Builder,
Architect review.
