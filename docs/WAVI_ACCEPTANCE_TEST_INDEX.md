# Wavi Acceptance Test Index

Every gate a change must pass, by layer. Run automated gates from the repo
root (cwd matters!). Prereq: arm64 sqlite at /tmp/wavio-sqlite-test (see
AI_CONTROL_TOWER bootstrap).

## A. Automated (every PR/merge)
1. `npx tsc -p tsconfig.electron.json` and `npx tsc --noEmit -p .`
2. `npx vitest run` — 434 baseline on trunk 83b5a82e; 24 files. New features add, never skip.
3. `npm run build` (vite + electron tsc)
4. QA build: `npx electron-builder --mac --config electron-builder.qa.json`;
   assert CFBundleIdentifier `stream.wavi.studio.qa`; `git status` unchanged sources.

## B. Real-process harness (sync-affecting changes)
`scripts/validate-sync-scalability/` — README has exact commands:
fixtures(5000) → benchmark-main (rescan growth 0, dup groups 0) →
scheduler-test (drain + selected-project-first + pause/resume) →
watcher-storm (all-assert pass) → two-process (single writer, deep-link
forward, integrity ok) → real-network (needs founder WAVI_AUTH_TOKEN, ≤25 files).

## C. Interactive renderer smokes (UI-affecting changes)
Dev app: `npx vite &` + `WAVI_USER_DATA_DIR=<fresh-under-~/wavi-worktrees> WAVI_QA_OVERRIDE=1 ./node_modules/.bin/electron .`;
DevTools `await window.waviAPI.auth.setToken('wv_smoke_local'); location.reload()`.
- Folders: safe add / Splice warning / ratio confirm / Cancel-no-index / Add-Anyway-indexes / visible errors.
- Links: seeded active+revoked+expired render; rename persists; revoke-with-server-failure shows error AND row stays Active (DR-001); copy; duplicate gating.
- Project Detail: row→panel; tab loads; gating of publish/link when unsynced; Sync This Project honest outcomes; bounce = graceful error in dev (until WS-005), MUST play in packaged smoke.
- Copilot: overlay context loads; "search …" runs local tool offline; gated tool → card appears; **Cancel ⇒ no execution**; Confirm ⇒ executes; model-emitted confirmed:true never bypasses (also covered by unit test + headless chain script pattern from the review).

## D. Product E2E (release gates)
- **Ableton Project Link E2E** (required to un-hold refactor/ableton-adapter):
  disposable project → publish → link → browser preview → restore to fresh
  dir → SHA-256s match → opens in Ableton → NO "Temp Project" → no missing
  media → duplicate-restore dialog on second restore → revoke kills resolve.
  (Passed on trunk pre-adapter 2026-07-01; must re-pass on the adapter branch.)
- Real-library smoke (production build, founder machine): backup DB first;
  startup repair counts logged; no unchanged-file requeue; queue never grows;
  CPU settles <2%; projects visible; zero SQLite errors. (Passed 2026-07-02.)
- Restore permission variants: revoked / expired / wrong-password / invalid
  token all fail closed with clear copy (server tests exist web-side; desktop
  copy check manual).

## E. Security review points (any IPC/link/copilot change)
No token characters in any log/audit; no absolute local paths sent to cloud;
new IPC validates inputs; gated tools use confirmedOutOfBand only (DR-002);
restore paths stay within chosen destination; no new `shell.*` surface
reachable from model output.
