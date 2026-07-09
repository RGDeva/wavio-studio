# `refactor/ableton-adapter` branch audit & classification

Audit date: 2026-07-09 · Auditor: Claude (desktop lane, /loop cycle 2)
Integration branch: `feature/ableton-daw-companion` @ `6600cfa5`
Adapter branch: `refactor/ableton-adapter` @ `5d8562ba`

## Ancestry

The adapter branch is **one commit** (`5d8562ba`, "refactor(adapters): extract
Ableton logic behind the DAW adapter interface (Phase F)") branched from
`9731f873` — **before** ~22 trunk commits (Node-22 SQLite harness, wavi-media
WS-005, links registry, copilot tools, project-detail). It carries no trunk
drift of its own; the divergence is entirely trunk-ahead.

## Trial-merge evidence (throwaway worktree, nothing merged into real branches)

- `git merge feature/ableton-daw-companion` into the adapter tip → **exactly one
  textual conflict: `vitest.config.ts` (1 hunk)** — both sides appended a test
  to the `include` list. `electron/main.ts` (the −94-line extraction) and every
  other file **auto-merged cleanly**, contrary to the WS-006 packet's prediction
  of main.ts conflicts (trunk's main.ts additions — links/copilot IPC and
  `registerWaviMediaProtocol` — live in different regions than the removed
  Ableton helpers).
- With that one conflict resolved as a **union** of both include lists,
  **electron tsc and renderer tsc both pass (exit 0, zero errors)** on the merged
  tree. So the extraction is semantically compatible with trunk — trunk added no
  caller of a helper the extraction removed.
- Full vitest on the merged tree was **not** run in this audit (the throwaway
  worktree lacks the Node-ABI SQLite fixture); it is required in the integration
  cycle before any real merge.

## Per-change classification

| Change | Classification | Notes |
|---|---|---|
| `electron/adapters/types.ts` (`DawAdapter` contract, `ManifestEntry`) | **Still required — reusable as-is** | Honest to today's behavior (detection/classification/manifest helpers/metadata); no speculative packaging/restore/launch methods; pure (vitest-importable outside Electron); `safeRelativePath` privacy invariant (never absolute). DR-015-consistent. |
| `electron/adapters/common.ts` | **Still required — reusable as-is** | Shared `safeRelativePath` / `classifyFileRole` / `findPreviewCandidate` extracted from main.ts. |
| `electron/adapters/ableton.ts` | **Still required — reusable** | Ableton adapter incl. `manifestExtras` for the `Ableton Project Info/` marker. Must preserve manifest content/order (DR-013 is a founder decision; WS-006 prohibits changing it). |
| `electron/adapters/index.ts` (registry + `KNOWN_DAW_PROJECT_EXTENSIONS`) | **Still required — reusable** | Generic fallback preserves pre-extraction behavior for non-Ableton projects. |
| `electron/adapters/adapters.test.ts` (contract suite) | **Still required — reusable** | Must be added to the `vitest.config.ts` include list on merge. |
| `electron/ableton.ts` (−162, slimmed) | **Still required — reusable** | Coexists with trunk (tsc-clean). |
| `electron/main.ts` (−94, extraction) | **Reusable after adaptation** | Auto-merges + tsc-clean, but the real merge MUST re-run full vitest (copilot-tools and wavi-media handler regions) to confirm behavior parity. |
| `electron/discovery.ts` (+`KNOWN_DAW_PROJECT_EXTENSIONS`) | **Still required — reusable** | Extension membership identical to the previous hardcoded list. |
| `vitest.config.ts` (+adapters test) | **Conflicting (trivial)** | 1 hunk; resolve as the **union** (keep copilotTools + wavi-media + guard + adapters). |
| restore/launch dispatch behind adapter methods | **Still required — NOT YET ON BRANCH** | The contract deliberately omits these; WS-006 step 2 adds them. Future bounded task. |

**None** of the changes are *obsolete*, *already-implemented-elsewhere* (trunk
has no `electron/adapters/`), or *unsafe* (behavior-preserving; privacy invariant
intact; no secrets; no raw paths; no broad deletions).

## Overall verdict

**Reusable after (light) adaptation.** The Phase-F extraction is a sound, honest,
DR-015-aligned foundation. It is safe to integrate via a small, well-scoped merge
— it does **not** need to be rebuilt.

## Recommended integration path (next bounded cycles — NOT done in this audit)

1. **WS-006 step 1 (merge):** on `refactor/ableton-adapter`, merge trunk
   (`6600cfa5`) in; resolve the single `vitest.config.ts` hunk as a union; add
   `electron/adapters/adapters.test.ts` to the include list. Run the full gate
   (both tsc, full vitest zero-skip, adapters contract suite, `git diff --check`).
2. **WS-006 step 2 (behavior-preserving):** move restore-time (post-extract
   validation incl. `Ableton Project Info/`) and launch-time Ableton specifics
   behind adapter methods. Golden manifests unchanged (DR-013). Extend the
   contract suite for the restore/launch hooks.
3. **WS-006 step 3 (E2E):** full Ableton round-trip per
   `docs/WAVI_ACCEPTANCE_TEST_INDEX.md §D`.

## Blocker (reported once, not polled)

WS-006 step 3 — the full Ableton E2E (publish → link → preview 200 → restore to
fresh dir → shasum table → **opens in Ableton** → no Temp-Project screen →
duplicate-restore dialog → revoke kills resolve) — requires **(a) a
founder-authorized signed-in desktop session** for the network steps and **(b) a
real Ableton Live install + a disposable project** for interactive verification.
Neither is available to an autonomous desktop cycle. Steps 1–2 (merge + adapter
extraction + unit/integration/security tests + packaged build) are fully
automatable and are the genuinely non-overlapping desktop work to proceed with;
step 3 is deferred to a founder-attended session.
