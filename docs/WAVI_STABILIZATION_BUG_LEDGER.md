# Wavi Stabilization Bug Ledger

War Room ledger — every known defect, its proven root cause, and its fix
status. Severity: P0 = user-blocking in production. Update on every fix
commit; nothing leaves this ledger until verified in production or a
clean-browser smoke.

| ID | Sev | Area | Root cause (proven) | Fix branch / commit | Tests | Status |
|----|-----|------|---------------------|--------------------|-------|--------|
| WAVI-P0-A | P0 | Library load | `loadData` wrote the FULL asset collection to localStorage inside the same try that set state; QuotaExceededError (~791 assets ≈ >1.6 MB) threw into a catch that reset assets to the empty cache → "No files found" while server truth was intact | `fix/vault-library-recovery` `6c15302` | 9 (quota, 1k/5k assets, legacy purge, offline, server error, corrupt cache, empty-vs-failed, stale reload) | fixed, pending merge + founder smoke |
| WAVI-P0-B | P0 | Data integrity | NO DATA LOSS. Founder reconciliation (read-only, service role): 791 assets, all status `ready`; 0 missing file_url; 0 missing storage_path; 74 projects; 0 orphaned ownership; count endpoint vs list endpoint agree. Discrepancy banner ("26 files") = plan-limit fallback, not data | n/a — no repair needed | reconciliation queries archived in session log | closed (verified 2026-07-04) |
| WAVI-P0-C | P0 | Entitlements | Founder has ZERO `user_plans` rows → Free fallback (26 files/500 MB); admin gating is an email allowlist in `api/_lib/entitlements.ts`, not durable server state | `fix/founder-entitlements` `4595013`+`4ba4269` (WS-022; second commit widens the user_plans CHECK constraint the seed would have violated) | 8 (id-keyed grant, email-change immunity, client-cannot-grant, unauth default, canceled fallback) | fixed in code, pending merge; seed migration requires founder approval |
| WAVI-P0-D | P0 | Link analytics | link_insights 500: four `.in()` queries on `wavi_link_events` with ~800 ids exceed PostgREST URL length → 400 "Bad Request" surfaced as 500 | `fix/vault-library-recovery` `352f6b8` (chunked queries, 150 ids/chunk) | covered by tsc + manual query-shape review; API test pending | fixed, pending merge |
| WAVI-P0-E | P0 | Audio player | Teardown assigned `src=''` (resolves to page URL) and play() ran without a source → MEDIA_ELEMENT_ERROR spam, stray requests | `fix/vault-library-recovery` `e16b5a6` | guarded paths tsc-verified; behavior test pending | fixed, pending merge |
| WAVI-P0-F | P0 | Uploads | Live 500s: client sent timestamp ids (`<ms>-<rand36>`) to the UUID `assets.id` column (22P02) and `status='uploading'` placeholder rows with no `file_url` (23502) | `fix/upload-persistence` `d4a3ed5` (UUID ids, deferred sync, 4xx mapping, never-strip-id) | 6 (id format/uniqueness, syncability gating) | fixed, pending merge; `file_url` nullable migration written NOT applied |

## Founder-account reconciliation (P0-B detail, 2026-07-04)

Read-only via service role; no rows modified. Canonical founder key:
Privy DID resolved through creator_profiles (email lookup used once,
read-only; not committed as an identifier anywhere in code).

- Total asset rows owned: **791** — all `status='ready'`
- Rows missing `file_url`: **0** · missing `storage_path`: **0**
- Projects owned: **74**
- Archived/deleted rows: **0** · RLS-blocked from own account: **0**
- `user_plans` rows: **0** → server fell back to Free limits (max_files 26),
  which produced the misleading over-limit banner while the Library showed
  empty (P0-A). The two symptoms had independent root causes.

Conclusion: files were never lost; no identity/ownership repair migration is
needed. P0-B closed.

## Integration status (2026-07-05)

All six P0s are integrated on **`stabilize/product-core-v1`** (b49f4ac +
vault-library-recovery + upload-persistence + founder-entitlements), merged
with zero conflicts, tsc clean, 26 files / 245 tests green. `paywall.test.ts`
verified **green (6/6)** — not a pre-existing failure. Full review, migration
staging/rollback plan, and smoke checklists: WAVI_STABILIZATION_INTEGRATION_REVIEW.md.
`fix/subscription-remove-client-admin-email` is on the wrong base (needs
rebase onto b49f4ac before it can be the 4th merge). DAWproject spike
complete on `spike/dawproject-adoption` (DR-015 = Option B).

## Pending verifications

- Founder-account clean-browser smoke of Library/player/insights (blocked on
  founder sign-in).
- API-level tests for link_insights (empty summary / 401 / 404 / malformed
  rows) and player behavior tests — next packet.
- Migrations awaiting founder approval before ANY application:
  `20260704090000_assets_file_url_nullable.sql`, WS-022 entitlements seed.

## Explicitly out of scope until zero P0/P1

Cross-DAW, FLP parsing, Ableton generation, new Copilot tools, DAW control,
marketplace, Open Sessions, tokenization, Collect, distribution, visual
redesign.
