# WS-020 · Restore error taxonomy + human copy
**Product outcome:** every restore failure tells the recipient exactly what happened and what to do.
**Technical objective:** enumerate restore:start failure classes (network, revoked, expired, hash mismatch, disk space, permission, partial-pack, duplicate) from main.ts + RestoreWindow; map each to typed error codes + plain-language copy + recovery action; implement the mapping (small main.ts error-shaping + RestoreWindow rendering); tests for the mapper.
**Repo:** wavio-studio. **Base:** trunk. **Branch:** feat/restore-errors. **Worktree:** ~/wavi-worktrees/restore-errors.
**Exact requirements:** UX principles apply (no hashes/IDs in primary copy; details in a collapsible); hash-mismatch copy MUST distinguish tampered/corrupt from incomplete.
**Prohibited:** changing restore mechanics/verification logic.
**Worker:** Builder. **Reviewer:** Critic (copy) + Architect (error classes).
