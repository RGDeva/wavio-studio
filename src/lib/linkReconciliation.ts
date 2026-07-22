/**
 * Reconciliation seam for the upcoming authoritative Project Link contract
 * (P3-2b prep).
 *
 * Codex is implementing the canonical account identity + `list-project-links`
 * contracts in the web repo. This module defines the DESKTOP side of that
 * seam: the shape we can accept and the pure, fail-closed transition rules.
 * There is NO network code here and NO fake endpoint — nothing calls a server
 * until Codex reports the implemented contract, at which point only a thin
 * adapter (wire names → this shape) is needed.
 *
 * ⚠ FIELD NAMES AND ENDPOINT PATHS ARE PENDING. See
 * docs/handoffs/CODEX-TO-DESKTOP-project-link-reconciliation.md. The semantic
 * fields below are what the desktop needs; the wire spelling is Codex's call.
 */
import type { LinkRecord } from './projectLinks';

/** Authoritative server record — semantic shape, wire names pending. */
export interface AuthoritativeLinkRecord {
  /** Canonical owning account id (backend-owned principal UUID). */
  accountId: string;
  /** Authoritative server row id (may equal trackingId; pending contract). */
  linkId: string;
  /** Public tracking id used in recipient URLs — the join key to cached rows. */
  trackingId: string;
  /** Cloud project id the link belongs to. */
  projectId: string;
  /** Immutable published version the link references. */
  projectVersionId: string;
  /** Server-authoritative status. */
  status: 'active' | 'revoked' | 'expired';
  /** Server-enforced permissions (keys pending; desktop only trusts known ones). */
  permissions: Record<string, unknown>;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Monotonic change marker — updatedAt timestamp and/or revision counter. */
  updatedAt?: string;
  revision?: number;
}

/**
 * Outcome of reconciling ONE cached row against the authoritative response.
 * Every arm maps onto the existing honest LinkState vocabulary — reconciliation
 * can only move a record toward server truth, never fabricate confirmation.
 */
export type ReconciliationOutcome =
  | { kind: 'server-confirmed'; authoritative: AuthoritativeLinkRecord }
  | { kind: 'revoked'; authoritative: AuthoritativeLinkRecord }
  | { kind: 'expired'; authoritative: AuthoritativeLinkRecord }
  /** Cached row absent from the authoritative response → needs attention, not deletion. */
  | { kind: 'reconciliation-needed' }
  /** Legacy/unscoped cached row — cannot participate in account reconciliation. */
  | { kind: 'ownership-unknown' }
  /** Authoritative owner ≠ active account → hide from this account's view; never mutable here. */
  | { kind: 'account-mismatch-hidden' }
  /** Authoritative row disagrees with the cached project/version binding → fail closed. */
  | { kind: 'binding-conflict'; detail: 'project' | 'version' | 'tracking' };

/**
 * Pure transition function. `authoritative` is the matching server record for
 * this cached row (matched by trackingId by the caller), or null when the
 * authoritative listing did not include it.
 *
 * Fail-closed rules:
 *  - a legacy row (no version binding / non-project kind) never reconciles;
 *  - a server record owned by a different account hides the row, it does not
 *    transfer it;
 *  - a server record whose project/version/tracking binding disagrees with the
 *    cached row CANNOT re-attach the link elsewhere — it is a conflict, not a
 *    confirmation.
 */
export function reconcileLink(
  cached: LinkRecord,
  authoritative: AuthoritativeLinkRecord | null,
  activeAccountId: string,
): ReconciliationOutcome {
  // Legacy/unscoped rows are ownership-unknown regardless of server data.
  if (cached.kind !== 'project' || !cached.version_id) return { kind: 'ownership-unknown' };

  if (!authoritative) return { kind: 'reconciliation-needed' };

  if (authoritative.trackingId !== cached.tracking_id) {
    return { kind: 'binding-conflict', detail: 'tracking' };
  }
  if (authoritative.accountId !== activeAccountId) {
    return { kind: 'account-mismatch-hidden' };
  }
  // The authoritative record must confirm the SAME immutable binding the cache
  // holds — reconciliation must never attach a link to a different project or
  // version. (Cached project_id is the local id when the cloud id is unknown;
  // callers pass the cloud-mapped cached row, so ids are comparable.)
  if (cached.project_id != null && authoritative.projectId !== cached.project_id) {
    return { kind: 'binding-conflict', detail: 'project' };
  }
  if (authoritative.projectVersionId !== cached.version_id) {
    return { kind: 'binding-conflict', detail: 'version' };
  }

  if (authoritative.status === 'revoked') return { kind: 'revoked', authoritative };
  if (authoritative.status === 'expired') return { kind: 'expired', authoritative };
  return { kind: 'server-confirmed', authoritative };
}
