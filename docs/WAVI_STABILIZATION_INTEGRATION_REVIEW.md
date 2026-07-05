# Wavi Stabilization Integration Review & Handoff

Principal review closing the Fable session. Every claim here was verified
against actual git state / test runs, not branch summaries. Repos: web =
`~/CascadeProjects/wavio` (RGDeva/wavio), control tower = `wavio-studio`.

---

## 1. DAWproject branch review (`spike/dawproject-adoption`)

Commits (off wavio-studio trunk `a2f3a069`, pushed):
- `19b54b00` — docs + architecture + task packets
- `fa41f692` — isolated prototype

**Verified against the four acceptance questions:**
1. **No conflict with the canonical Wavi model.** Musical data lives once in
   `project.xml`; the decision doc and Session IR spec explicitly forbid
   putting identity/permissions/analytics in the artifact (DR-001/DR-006
   cited throughout).
2. **DAWproject = musical interchange only.** `wavi/session.json` carries
   Wavi-only data; permissions/links/comments/analytics are deliberately
   NOT in the file — the manifest carries identity so the client asks the
   server for live state.
3. **Wavi Project stays authoritative** for identity, versions,
   collaborators, permissions, links, comments, analytics, provenance,
   Copilot context — stated normatively in the adoption decision and DR-015.
4. **Prototype cannot become production.** `electron/adapters/dawproject/
   spike/` is self-contained: own `vitest.spike.config.ts`, own fixtures,
   a "Not wired into the app" header, zero references from package.json,
   build config, or any non-spike electron module. Its 5 tests
   (round-trip + malicious-ZIP/XXE rejection) pass in isolation.
5. **WS-023..026 are implementation-grade** and self-contained per
   tasks/README.md schema.

**Recommendation:**
- **Merge `19b54b00` (docs only) into the control-tower trunk now.** It is
  pure documentation + task packets, contradicts nothing, and DR-015 should
  be visible to every future worker. Low risk, high coordination value.
- **Keep `fa41f692` (prototype) isolated on the spike branch.** Do NOT merge
  it to trunk or any app branch. It is a throwaway proof; WS-023 rebuilds
  the reader/writer properly with the security model. Merging it would
  create the exact "prototype silently becomes production" risk item 4
  guards against.

DR-015 (BINDING) records the decision: **Option B — superset.**

---

## 2. Docs-merge vs isolated-spike decision

| Artifact | Action | Why |
|---|---|---|
| `19b54b00` docs + WS-023..026 | merge to trunk now | docs-only, binding decision, no code |
| `fa41f692` prototype | stay on spike branch | throwaway; WS-023 supersedes; isolation is a feature |

(Not executed in this session — left as a founder-approved action so the
trunk merge is a deliberate, reviewed step.)

---

## 3. P0 branch dependency graph (VERIFIED)

```
b49f4ac (Codex tip, shared base)
├── fix/vault-library-recovery   6c15302 e16b5a6 352f6b8   (base b49f4ac ✓)
├── fix/upload-persistence       d4a3ed5                   (base b49f4ac ✓)
└── fix/founder-entitlements     4595013 4ba4269           (base b49f4ac ✓)

147517583 (DIFFERENT, older ancestor)
└── fix/subscription-remove-client-admin-email  831d071 a960958
        ⚠ NOT based on b49f4ac — missing 78 commits that are in b49f4ac
```

**Real dependencies (not assumed):**
- vault, upload, entitlements: **independent** — no shared files, merge in
  any order with zero conflicts (verified by merging all three).
- subscription → **soft-depends on entitlements** conceptually (it routes
  admin resolution to the server `getEntitlement` the entitlements branch
  hardens), but its client code (`apiGetEntitlement` in vaultApi.ts) is
  **self-contained** — it adds its own function. The real blocker is its
  **wrong base**, not a code dependency.

---

## 4. Reviewed merge order (VERIFIED by execution)

Integration branch **`stabilize/product-core-v1`** (pushed) already contains,
in this order, all merging cleanly with **zero conflicts**:

1. `fix/vault-library-recovery` (P0-A cache-wipe, P0-D insights chunking, P0-E player)
2. `fix/upload-persistence` (P0-F UUID ids + deferred sync + 4xx mapping)
3. `fix/founder-entitlements` (P0-C server-authoritative entitlements)

4. **`fix/subscription-remove-client-admin-email` — DO NOT MERGE AS-IS.**
   It would revert 78 commits (186 files, −23,415 lines). Required fix by
   the owning session: **rebase its `a960958` onto `b49f4ac`** (or
   cherry-pick `a960958` and resolve the `src/lib/subscription.ts` conflict —
   confirmed the cherry-pick conflicts on that one file because of the
   divergent ancestor; `vaultApi.ts` applies clean). The *code change itself
   is correct*: removes the client `ADMIN_EMAILS` list, routes admin/premium
   through `apiGetEntitlement` (server-authoritative). Once rebased onto
   b49f4ac it becomes a clean 4th merge.

Integration branch status: **tsc clean, 26 test files / 245 tests green.**

---

## 5. Migration staging plan (TWO migrations, NEITHER applied)

Both are on `stabilize/product-core-v1` under `supabase/migrations/`.

### 5a. `20260704090000_assets_file_url_nullable.sql`
- Effect: `ALTER TABLE public.assets ALTER COLUMN file_url DROP NOT NULL`.
- Additive ✓ (relaxes a constraint; existing rows unaffected).
- Reversible ✓ (reversal documented inline: backfill NULLs to '' then re-add
  NOT NULL).
- Constraint compat ✓ (only touches NOT NULL; no CHECK/FK).
- RLS impact: **none**. Free/admin behavior: **unchanged** (this is upload
  plumbing, not entitlement).

### 5b. `20260704091500_internal_unlimited_plan.sql`
- Effects (in order): widen `user_plans_plan_check` to include
  `internal_unlimited`; insert `internal_unlimited` into `plan_limits`;
  create RLS-locked `user_roles` (service-role-only, no policies); seed
  founder DID into `user_roles` + `user_plans`.
- Additive ✓ · Reversible ✓ (full rollback block inline incl. the constraint
  revert).
- **Constraint compat — CRITICAL, already fixed:** without the widening
  `ALTER`, the seed INSERT fails the pre-existing CHECK. The widening step
  (commit `4ba4269`) makes it apply cleanly. **Verify column names in the
  `plan_limits` INSERT match production before applying** (assumed from the
  fallback shape).
- RLS impact: new table is service-role-only by omission of policies —
  confirm this posture is intended (clients cannot read/write roles = good;
  it means admin state is only ever resolved server-side).
- Free behavior: **unchanged** (no rows touched for non-founder users).
- Admin behavior: founder DID → admin + internal_unlimited.

### Staging apply procedure (founder runs; agents may not)
1. Point Supabase CLI at **staging** project (NOT `bbjfaqzbbjrlhpzdxnlm`
   production).
2. `supabase db push` (or apply the two files in filename order:
   `...090000` then `...091500`).
3. Verify 5b: `SELECT * FROM plan_limits WHERE plan='internal_unlimited';`
   returns 1 row; `SELECT role FROM user_roles WHERE user_id='did:privy:cml15rbvv015al40cdvfmb1cm';`
   = admin; `SELECT plan FROM user_plans WHERE user_id='did:privy:cml15rbvv015al40cdvfmb1cm';`
   = internal_unlimited.
4. Verify 5a: `\d assets` shows `file_url` nullable.
5. Run the app against staging; execute the founder smoke checklist (§8).
6. Only after staging passes: schedule production apply as a **separate
   founder-approved** step.

---

## 6. Rollback plan

- **Code:** integration branch is additive; to roll back, deploy the prior
  trunk build. No destructive code changes. Player/cache/upload fixes
  degrade safely (error states, deferred sync) if reverted.
- **Migration 5a rollback:** `UPDATE assets SET file_url='' WHERE file_url IS
  NULL; ALTER TABLE assets ALTER COLUMN file_url SET NOT NULL;`
- **Migration 5b rollback:** run the inline reversal block (delete founder
  user_plans/user_roles rows, delete internal_unlimited plan_limits row, drop
  user_roles if empty, restore the original CHECK constraint).
- **Entitlement code after 5b rollback:** `getEntitlement` falls back to the
  `ADMIN_EMAILS` allowlist automatically — founder keeps admin via email,
  no code change needed. This is why the email fallback was *demoted, not
  deleted*.
- No production data was modified in this entire session (all founder DB
  access was read-only via MCP; migrations written, never applied).

---

## 7. Automated test results (run on `stabilize/product-core-v1`)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| Full `npx vitest run` | **26 files / 245 tests, 0 failures** |
| Cache quota + 1,000 + 5,000 asset sims | ✓ `vaultLoadRecovery.test.ts` (9 tests) |
| Empty/missing audio URL, offline, corrupt cache | ✓ same file |
| Upload UUID / deferred-sync / bad-payload | ✓ `uploadIdentity.test.ts` (6) |
| Founder admin / Free / client-can't-grant / unauth / email-change | ✓ `entitlements.test.ts` (8) |
| **`paywall.test.ts`** | ✓ **6/6 PASS** — NOT red. The `[STRIPE] Error creating checkout session: Authentication required` console line is an **asserted negative-path** (the test proves the auth guard fires), not a failure. The "known pre-existing paywall failures" concern is **stale/does not reproduce on this base.** |
| link analytics empty/malformed events | ⚠ **gap** — chunking fix (`352f6b8`) is code-level; no API-level test yet asserting empty-summary/401/404/malformed-row. Listed as P1 in §10. |
| cross-account authorization | partial — `collaborationRls.test.ts` (6) covers RLS; a dedicated cross-account fetch test is a §10 gap. |

Not runnable without founder credentials: live founder sign-in, real
Supabase entitlement resolution, real link-insights against 791 assets.

---

## 8. Founder browser smoke checklist (run AFTER staging deploy + both migrations)

1. Sign in as `rishmanx@gmail.com`.
2. Library shows all **791** assets.
3. **74** projects appear.
4. Reload the page — Library stays populated (no "No files found").
5. Upgrade/over-limit banner is **gone** (internal_unlimited).
6. Account/limits show **unlimited** files/storage/projects.
7. Audio playback works (play a track; no MEDIA_ELEMENT_ERROR in console).
8. No `QuotaExceededError` in console during load.
9. Open a link's insights — loads, or fails non-fatally (no 500, degrades to
   empty summary).
10. Upload a file — the created asset has a UUID id; no 500 in network tab.
11. (Separate Free test account) still shows Free limits (26 files / 500 MB).
12. Free account cannot load another account's asset/project by id.

---

## 9. Ordinary Free-account smoke checklist

1. Sign in as a non-admin, non-paid account.
2. Library loads (its own assets only).
3. Limits reported = Free (26 files / 500 MB / 5 projects).
4. Uploading past 26 files is blocked with the Free-limit message.
5. Admin-only surfaces are absent.
6. `getUserTier` returns `free` (no client email override path remains once
   the subscription branch lands).
7. Attempting to read another user's asset id → empty/403, never another
   user's data.

---

## 10. Remaining P0 / P1 bug ledger (post-integration)

**P0: none open in code.** All six (P0-A..F) are fixed on
`stabilize/product-core-v1`. Residual P0 *operational* items are founder
gates, not code:
- Apply both migrations to staging then production (§5).
- Rebase + land the subscription branch (§4.4).
- Founder browser smoke (§8) — the only thing that can confirm the 791-asset
  recovery end-to-end.

**P1 (open):**
| ID | Area | Gap |
|---|---|---|
| P1-1 | link analytics | No API-level test for empty-summary / 401 / 404 / malformed-event on link_insights (fix is code-only). |
| P1-2 | cross-account | No dedicated automated cross-account authorization-denial test. |
| P1-3 | subscription | Client `ADMIN_EMAILS` removal correct but stranded on a mis-based branch; not yet integrated. |
| P1-4 | migrations | `plan_limits` INSERT column set assumed from fallback; unverified against live schema. |
| P1-5 | Privy/auth | Reported (not yet reproduced this session): Solana login without connectors, `AuthProvider i.on is not a function`, embedded-wallet JSON errors, duplicate auth init — needs a clean-browser repro pass. |

---

## 11. Prioritized cheaper-model task packets (create in tasks/ready as WS-###)

1. **WS-027 link-insights API tests** (P1-1) — assert empty→valid empty
   summary, unauthorized→401/403 not 500, missing→404, malformed legacy rows
   skipped/normalized; against the chunked query in `api/vault/index.ts`.
   Sonnet. Bounded to test files + any thin normalization helper.
2. **WS-028 cross-account authorization tests** (P1-2) — one user cannot read
   another's asset/project/link via API; RLS + handler ownership guards.
   Sonnet.
3. **WS-029 subscription branch rebase + integrate** (P1-3) — rebase
   `a960958` onto b49f4ac, resolve the `subscription.ts` conflict, verify
   `getUserTier` has no client email path, merge into
   `stabilize/product-core-v1` as the 4th branch. Sonnet, careful review.
4. **WS-030 Privy/auth clean-browser repro** (P1-5) — reproduce in a fresh
   profile, capture exact errors, isolate connector/duplicate-init causes.
   Fable/Opus (diagnostic).
5. **WS-031 Product-Stabilization route audit** — multi-select, Shift-select,
   drag-into-folder, bulk move, folder ops, artwork persistence, link
   pinned-vs-follow-latest, comments on/off, mobile responsive, loading/
   empty/error states, upload feedback, analytics resilience. Split into
   bounded child packets per route; Sonnet workers, Fable review.

(These are described here; author them as files at the start of the next
session so each is self-contained.)

---

## 12. Exact continuation prompt for the next model

> Continue the Wavi Product Stabilization War Room as principal reviewer.
> STATE (all verified, pushed): `stabilize/product-core-v1` = b49f4ac +
> vault-library-recovery + upload-persistence + founder-entitlements, zero
> conflicts, tsc clean, 26 files/245 tests green, paywall.test.ts green
> (its Stripe console line is an asserted negative path, not a failure).
> Two migrations written, NOT applied (assets file_url nullable; founder
> internal_unlimited + user_roles). `fix/subscription-remove-client-admin-email`
> is on the WRONG base (147517583, missing 78 commits) — must be rebased
> onto b49f4ac before it can be the 4th merge; its code change is correct.
> DAWproject spike complete on `spike/dawproject-adoption` (DR-015 = Option
> B superset; docs commit 19b54b00 recommended for trunk merge, prototype
> fa41f692 stays isolated). Founder DB access stays READ-ONLY; no migrations
> applied; no production deploys. NEXT, in order: (1) author packets
> WS-027..031 as files in wavio-studio/tasks/ready (specs in
> WAVI_STABILIZATION_INTEGRATION_REVIEW.md §11). (2) Do WS-027 + WS-028
> yourself or delegate to Sonnet, reviewing every diff. (3) Once the founder
> approves, guide the subscription rebase (WS-029). (4) Hold WS-023 (and all
> cross-DAW/FLP/ALS/Copilot/marketplace/tokenization/Collect work) until
> zero P0/P1. (5) The founder must run the §8 and §9 smoke checklists after
> staging; surface blockers, don't work around them. Do not touch Codex's
> uncommitted `src/lib/vaultAssetAudioActions.ts` in ~/CascadeProjects/wavio.
