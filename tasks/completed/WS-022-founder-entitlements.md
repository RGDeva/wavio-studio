# WS-022 — Server-authoritative founder entitlements

- **ID:** WS-022 · **Priority:** P0-C (War Room)
- **Product outcome:** the founder account gets admin + unlimited internal plan, granted by the server from the authenticated user ID — never by client state or a hardcoded email in React.
- **Technical objective:** additive, reversible entitlement model in the wavio web repo keyed on user ID, honored by all plan/limit checks.
- **Dependencies:** none. **Repo:** wavio (`https://github.com/RGDeva/wavio.git`).
- **Base branch/commit:** `b49f4ac`. **Feature branch:** `fix/founder-entitlements`. **Worktree:** `~/wavi-worktrees/founder-entitlements`.
- **Files likely affected:** `api/_lib/entitlements.ts`, `api/_lib/plan-limits.ts`, new `supabase/migrations/*_internal_unlimited_plan.sql`, new tests under `api/`.

## Exact requirements
1. Write (do NOT apply) a migration seeding: a `plan_limits`/plan row `internal_unlimited` with unlimited files/storage/projects/stems/links/versions and all premium flags; a `user_plans` row assigning it to user ID `did:privy:cml15rbvv015al40cdvfmb1cm`; a durable admin role record keyed by that user ID (use an existing roles/profiles table if suitable, else a new `user_roles` table). Reversal statements documented in the file.
2. Extend the entitlement service so `getEntitlement`/`getUserPlan` resolve plan + admin from the DB by user ID first; the `ADMIN_EMAILS` allowlist stays only as a fallback and gets a deprecation comment. Changing the account email must not revoke anything.
3. Every existing limit check keeps working for Free users (26 files / 500MB fallback unchanged).
4. Keep usage recording intact for internal_unlimited users.

## Prohibited
Applying the migration anywhere; hardcoding founder email in React/client code; touching `~/CascadeProjects/wavio` main worktree (Codex has an uncommitted file there); production deploys; force-push; working on main.

## Tests (vitest, node env under api/**)
- founder user ID resolves to admin + internal_unlimited (DB rows mocked)
- a Free user gets Free limits and no admin
- client-supplied fields (e.g. body claiming plan/admin) cannot grant entitlements
- unauthenticated requests get no entitlement
- email-change scenario: entitlement resolution never reads email for the founder path

## Acceptance & handoff
`npx tsc --noEmit` clean; new tests green; full `npx vitest run` no new failures. Commit conventionally, push branch. Write `handoffs/WS-022-2026-07-04.md` per tasks/README.md schema. STOP if any step requires applying a migration or deploying.
