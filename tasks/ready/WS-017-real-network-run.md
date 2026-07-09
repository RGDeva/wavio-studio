# WS-017 · Real-network sync measurement run
**Product outcome:** honest real-world upload numbers (DR-012) for the beta gate.
**Technical objective:** with a founder-supplied WAVI_AUTH_TOKEN (env only, never stored/echoed): run scripts/validate-sync-scalability/real-network-test.js (≤25 tiny disposable files), capture concurrency/refill-gap/retries/throughput; append results to docs/WAVI_SYNC_BRANCH_REVIEW.md §9 and the acceptance index.
**Dependencies:** founder token at run time. **Repo:** wavio-studio trunk, no code changes expected. **Branch:** docs-only commit allowed on a chore branch.
**Prohibited:** >25 files; founder's real music; storing the token anywhere.
**Worker:** Builder. **Reviewer:** Architect.
