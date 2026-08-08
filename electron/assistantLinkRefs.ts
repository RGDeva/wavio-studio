/**
 * Assistant-safe Project Link references (P3-3b).
 *
 * The model must be able to `list_project_links` → receive a reference →
 * `revoke_project_link` with it, WITHOUT ever seeing the canonical Privy DID,
 * the desktop auth token, or (as a matter of policy) raw server/database
 * identifiers. This mints short, opaque, SESSION-SCOPED handles (`plink_…`)
 * bound to the account + project + tracking id that produced them.
 *
 * This is deliberately NOT a second canonical Project Link identity: refs are
 * in-memory only, never persisted, never sent to the server, and die with the
 * session/epoch. The server's trackingId remains the single canonical id and
 * stays main-process-owned.
 *
 * Fail-closed rules:
 *  - a malformed/unknown ref never resolves;
 *  - a ref minted for account A never resolves under account B;
 *  - a ref minted for project P never resolves against a different project;
 *  - every ref is invalidated when the session epoch changes (logout / account
 *    switch), so a pre-logout ref cannot act after re-login.
 */

export interface LinkRefBinding {
  trackingId: string;
  /** Canonical account DID — main-process only; never emitted to the model. */
  accountId: string;
  /** Local project id the link belongs to. */
  projectId: string | null;
  /** Session epoch at mint time. */
  epoch: number;
}

export type LinkRefResolution =
  | { ok: true; binding: LinkRefBinding }
  | { ok: false; reason: 'malformed-reference' | 'unknown-reference' | 'account-mismatch' | 'project-mismatch' | 'stale-session' };

const REF_RE = /^plink_[0-9a-z]{8}$/;

export class AssistantLinkRefRegistry {
  private refs = new Map<string, LinkRefBinding>();
  private byTracking = new Map<string, string>();
  private counter = 0;

  /** Mint (or reuse) a stable ref for a link within the current session. */
  mint(binding: LinkRefBinding): string {
    const dedupeKey = `${binding.epoch}:${binding.accountId}:${binding.trackingId}`;
    const existing = this.byTracking.get(dedupeKey);
    if (existing) return existing;
    // Deterministic, short, opaque; no tracking-id or DID material inside.
    this.counter += 1;
    const ref = `plink_${this.counter.toString(36).padStart(8, '0')}`;
    this.refs.set(ref, binding);
    this.byTracking.set(dedupeKey, ref);
    return ref;
  }

  /**
   * Resolve a model-supplied ref under the CURRENT account/epoch, optionally
   * pinned to a project. Any mismatch fails closed — the caller must not act.
   */
  resolve(
    ref: unknown,
    ctx: { accountId: string | null; epoch: number; projectId?: string | null },
  ): LinkRefResolution {
    if (typeof ref !== 'string' || !REF_RE.test(ref)) return { ok: false, reason: 'malformed-reference' };
    const binding = this.refs.get(ref);
    if (!binding) return { ok: false, reason: 'unknown-reference' };
    if (binding.epoch !== ctx.epoch) return { ok: false, reason: 'stale-session' };
    if (!ctx.accountId || binding.accountId !== ctx.accountId) return { ok: false, reason: 'account-mismatch' };
    if (ctx.projectId != null && binding.projectId !== ctx.projectId) return { ok: false, reason: 'project-mismatch' };
    return { ok: true, binding };
  }

  /** Logout / account switch: every outstanding ref becomes unusable. */
  clear(): void {
    this.refs.clear();
    this.byTracking.clear();
  }

  size(): number { return this.refs.size; }
}

/** Shape of one link as the MODEL is allowed to see it — no DID, no token, no paths. */
export interface AssistantSafeLink {
  ref: string;
  projectId: string | null;
  versionId: string | null;
  status: 'active' | 'revoked' | 'expired' | 'unknown';
  permissions: { allowDownload: boolean; collaboratorMode: string };
  createdAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Honest per-record reconciliation state for the assistant to explain. */
  reconciliation: 'server-confirmed' | 'cached' | 'reconciliation-needed';
}

/** Derive the model-visible status from a cached row (no server call). */
export function safeStatusFromRow(row: { revoked_at?: string | null; expires_at?: string | null }, now = new Date()): AssistantSafeLink['status'] {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/**
 * Project a main-process cache row into the assistant-safe shape. Strips
 * account_id (DID), url, label and every other non-allowlisted field.
 */
export function toAssistantSafeLink(
  ref: string,
  row: {
    project_id?: string | null; version_id?: string | null;
    allow_download?: number | boolean; collaborator_mode?: string | null;
    created_at?: string | null; expires_at?: string | null; revoked_at?: string | null;
  },
  reconciliation: AssistantSafeLink['reconciliation'],
  now = new Date(),
): AssistantSafeLink {
  return {
    ref,
    projectId: row.project_id ?? null,
    versionId: row.version_id ?? null,
    status: safeStatusFromRow(row, now),
    permissions: {
      allowDownload: row.allow_download !== 0 && row.allow_download !== false,
      collaboratorMode: row.collaborator_mode ?? 'view',
    },
    createdAt: row.created_at ?? null,
    expiresAt: row.expires_at ?? null,
    revokedAt: row.revoked_at ?? null,
    reconciliation,
  };
}
