# Wavi Autonomous Blockers

## Active

**B-1 · Phase B (canonical Link compatibility layer) and Phase E (shared public Link shell) — blocked by active Codex agent in the wavio repo.**
Detected 2026-07-02 ~02:20: a Codex session is live with working dir = the wavio repo, with uncommitted changes in its working tree and `feature/wavi-project-links-analytics` checked out. The canonical-link layer touches the same subsystem (api/_lib, share/project-link routes, share pages). Per the "another active agent is modifying the same files" rule, all wavio-side work is deferred until that session is idle/committed. **Workaround in progress:** proceeding with wavio-studio-only phases (C, D, then F/H prep). Phase C ships against locally-known link data first; server-side analytics columns land when B unblocks.

**B-2 · Limited real-network upload metrics — needs a user-supplied `WAVI_AUTH_TOKEN`.**
Harness ready: `scripts/validate-sync-scalability/real-network-test.js`. Credential extraction is out of bounds for the agent. Non-blocking for merges; needed before beta throughput claims.

**B-3 · Credential rotation (leaked `.env.vercel-prod-temp` keys) — requires explicit human authorization.**
Removed from git tracking earlier; Stripe/Supabase/Resend/RoEx/Replicate/Google OAuth/cron keys still unrotated. Should gate any public beta. No agent action permitted.

## Resolved
- ~~Phase A checkpoint of Codex analytics work~~ — `feature/wavi-project-links-analytics` already existed (created outside this loop); original codex branches intact.
