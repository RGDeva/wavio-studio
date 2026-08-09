/**
 * Session-scoped opaque references + safe projections for Multiplayer v1.
 *
 * Same discipline as assistantLinkRefs.ts (`plink_…`): membership and
 * contribution ids are server identities and stay in the main process. Anything
 * that crosses to the renderer — and, later, to the assistant — carries an
 * opaque `pmember_…` / `pcontrib_…` handle bound to {account, project, epoch}.
 *
 * Fail-closed: malformed / unknown / cross-account / cross-project / stale-epoch
 * refs never resolve. Refs are in-memory only, never persisted, never sent to
 * the server, and are cleared on logout or account switch.
 *
 * NOTE: the three multiplayer assistant tools remain BLOCKED in this task. This
 * module exists so the boundary is in place before any of them is unblocked —
 * no model-facing surface is wired here.
 */

import type { ActivityEvent, Contribution, Membership, MembershipRole } from './multiplayerService';

export type RefKind = 'member' | 'contrib' | 'invite';

export interface MpRefBinding {
  kind: RefKind;
  /**
   * Canonical server id — main-process only. For `invite` refs this is the
   * opaque server `invt_…` capability, which is never parsed for identity and
   * never leaves the main process.
   */
  serverId: string;
  /** Canonical account DID — main-process only, never emitted. */
  accountId: string;
  projectId: string;
  /** Session epoch at mint time. */
  epoch: number;
  /**
   * Absolute local expiry (ms). Set for `invite` refs from the server's stated
   * 10-minute TTL: an expired capability must fail closed BEFORE a request that
   * would waste one of the caller's rate-limited lookups.
   */
  expiresAtMs?: number;
}

export type MpRefResolution =
  | { ok: true; binding: MpRefBinding }
  | { ok: false; reason: 'malformed-reference' | 'unknown-reference' | 'account-mismatch' | 'project-mismatch' | 'stale-session' | 'wrong-kind' | 'expired' };

const PREFIX: Record<RefKind, string> = { member: 'pmember_', contrib: 'pcontrib_', invite: 'pinvite_' };
const REF_RE = /^(pmember|pcontrib|pinvite)_[0-9a-z]{8}$/;

export class MultiplayerRefRegistry {
  private refs = new Map<string, MpRefBinding>();
  private byServerId = new Map<string, string>();
  private counter = 0;

  mint(binding: MpRefBinding): string {
    const dedupeKey = `${binding.epoch}:${binding.accountId}:${binding.kind}:${binding.serverId}`;
    const existing = this.byServerId.get(dedupeKey);
    if (existing) return existing;
    this.counter += 1;
    const ref = `${PREFIX[binding.kind]}${this.counter.toString(36).padStart(8, '0')}`;
    this.refs.set(ref, binding);
    this.byServerId.set(dedupeKey, ref);
    return ref;
  }

  resolve(
    ref: unknown,
    ctx: { kind: RefKind; accountId: string | null; epoch: number; projectId?: string | null; now?: number },
  ): MpRefResolution {
    if (typeof ref !== 'string' || !REF_RE.test(ref)) return { ok: false, reason: 'malformed-reference' };
    const binding = this.refs.get(ref);
    if (!binding) return { ok: false, reason: 'unknown-reference' };
    if (binding.kind !== ctx.kind) return { ok: false, reason: 'wrong-kind' };
    if (binding.epoch !== ctx.epoch) return { ok: false, reason: 'stale-session' };
    if (!ctx.accountId || binding.accountId !== ctx.accountId) return { ok: false, reason: 'account-mismatch' };
    if (ctx.projectId != null && binding.projectId !== ctx.projectId) return { ok: false, reason: 'project-mismatch' };
    if (binding.expiresAtMs != null && (ctx.now ?? Date.now()) >= binding.expiresAtMs) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, binding };
  }

  /** Drop a single ref once its capability has been spent or invalidated. */
  forget(ref: string): void {
    const binding = this.refs.get(ref);
    if (!binding) return;
    this.refs.delete(ref);
    this.byServerId.delete(`${binding.epoch}:${binding.accountId}:${binding.kind}:${binding.serverId}`);
  }

  clear(): void {
    this.refs.clear();
    this.byServerId.clear();
  }

  size(): number { return this.refs.size; }
}

// ── Safe projections ─────────────────────────────────────────────────────────

/**
 * A single readable membership state derived from the contract's BOOLEANS.
 * The booleans stay authoritative and are carried through unchanged — this is a
 * display convenience, not a re-encoding of server state into an enum.
 */
export type MembershipDisplayState = 'active' | 'pending' | 'declined' | 'revoked' | 'expired' | 'unknown';

export function membershipDisplayState(state: Membership['state']): MembershipDisplayState {
  // Order matters: a revoked/expired row can still carry a stale `pending`.
  if (state.revoked) return 'revoked';
  if (state.expired) return 'expired';
  if (state.declined) return 'declined';
  if (state.active) return 'active';
  if (state.pending) return 'pending';
  return 'unknown';
}

export interface SafeMembershipView {
  ref: string;
  projectId: string;
  role: MembershipRole;
  /** Carried separately from `role` — never inferred from `comment`. */
  canContribute: boolean;
  state: MembershipDisplayState;
  stateFlags: Membership['state'];
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  acceptedAt: string | null;
  expiresAt: string | null;
  revision: string | null;
}

/** Project a membership for the renderer. `membershipId` is NOT included. */
export function toSafeMembership(ref: string, m: Membership): SafeMembershipView {
  return {
    ref,
    projectId: m.projectId,
    role: m.role,
    canContribute: m.canContribute,
    state: membershipDisplayState(m.state),
    stateFlags: { ...m.state },
    displayName: m.actor.displayName,
    avatarUrl: m.actor.avatarUrl,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    acceptedAt: m.acceptedAt,
    expiresAt: m.expiresAt,
    revision: m.revision,
  };
}

export interface SafeActivityView {
  projectId: string;
  type: ActivityEvent['type'];
  displayName: string | null;
  avatarUrl: string | null;
  /** Whether the event refers to a version/contribution/membership at all. */
  subjectKind: 'version' | 'contribution' | 'membership' | 'link' | 'comment' | 'none';
  occurredAt: string | null;
  revision: string | null;
}

/**
 * Project an activity event. Raw subject ids are DROPPED — the renderer only
 * needs to know what kind of thing the event was about; resolving a subject is
 * a separate, explicitly-scoped request.
 */
export function toSafeActivity(a: ActivityEvent): SafeActivityView {
  const subjectKind: SafeActivityView['subjectKind'] =
    a.subject.versionId ? 'version'
    : a.subject.contributionId ? 'contribution'
    : a.subject.membershipId ? 'membership'
    : a.subject.trackingId ? 'link'
    : a.subject.commentId ? 'comment'
    : 'none';
  return {
    projectId: a.projectId,
    type: a.type,
    displayName: a.actor.displayName,
    avatarUrl: a.actor.avatarUrl,
    subjectKind,
    occurredAt: a.occurredAt,
    revision: a.revision,
  };
}

export type ContributionDisplayState = 'submitted' | 'accepted' | 'rejected' | 'withdrawn' | 'unknown';

export function contributionDisplayState(state: Contribution['state']): ContributionDisplayState {
  if (state.withdrawn) return 'withdrawn';
  if (state.accepted) return 'accepted';
  if (state.rejected) return 'rejected';
  if (state.submitted) return 'submitted';
  return 'unknown';
}

export interface SafeContributionView {
  ref: string;
  projectId: string;
  state: ContributionDisplayState;
  stateFlags: Contribution['state'];
  contributorNote: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  reviewedAt: string | null;
  withdrawnAt: string | null;
  revision: string | null;
}

/** Project a contribution. Version ids and correlation ids are not included. */
export function toSafeContribution(ref: string, c: Contribution): SafeContributionView {
  return {
    ref,
    projectId: c.projectId,
    state: contributionDisplayState(c.state),
    stateFlags: { ...c.state },
    contributorNote: c.contributorNote,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    reviewedAt: c.reviewedAt,
    withdrawnAt: c.withdrawnAt,
    revision: c.revision,
  };
}

/**
 * A resolved invite target as the renderer/model may see it: an opaque ref plus
 * display-only fields. The `invt_…` capability, the target's DID, and the raw
 * identifier that was searched for are all absent by construction.
 */
export interface SafeInviteTargetView {
  ref: string;
  projectId: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** So the UI can say the lookup went stale rather than failing opaquely. */
  expiresAtMs: number;
}

export function toSafeInviteTarget(
  ref: string,
  projectId: string,
  display: { displayName: string | null; avatarUrl: string | null },
  expiresAtMs: number,
): SafeInviteTargetView {
  return {
    ref,
    projectId,
    displayName: display.displayName,
    avatarUrl: display.avatarUrl,
    expiresAtMs,
  };
}

/** Honest, non-raw failure text for the renderer, keyed by the typed reason. */
export const MULTIPLAYER_FAILURE_MESSAGE: Record<string, string> = {
  offline: 'You appear to be offline — collaborator data could not be checked.',
  unauthorized: 'Sign in to Wavi to manage collaborators.',
  forbidden: 'You do not have permission to do that on this project.',
  rejected: 'That request was not accepted by the server.',
  'not-found': 'That item no longer exists.',
  conflict: 'That item is no longer in a state where this action applies.',
  'invite-expired': 'That invitation has expired.',
  retryable: 'The server had a problem — try again in a moment.',
  malformed: 'The server response could not be understood, so nothing was changed.',
  'contribution-outcome-unknown':
    'The contribution may or may not have been submitted. Refresh the project to check before retrying.',
  'stale-session': 'Your session changed — the result was discarded.',
  'rate-limited': 'Too many collaborator lookups. Wait a few minutes and try again.',
  'invite-target-expired': 'That collaborator lookup expired. Search again to invite them.',
  expired: 'That collaborator lookup expired. Search again to invite them.',
  'malformed-reference': 'That item is no longer available.',
  'unknown-reference': 'That item is no longer available.',
  'account-mismatch': 'That item is no longer available.',
  'project-mismatch': 'That item is no longer available.',
  'wrong-kind': 'That item is no longer available.',
};

/**
 * The ONE message shown when a lookup does not resolve.
 *
 * The server deliberately makes "no such account" and "account exists but is
 * not discoverable" indistinguishable. This single string is the desktop's
 * half of that guarantee — there must be no second, more specific variant.
 */
export const INVITE_TARGET_UNRESOLVED_MESSAGE = 'No inviteable Wavi account found.';
