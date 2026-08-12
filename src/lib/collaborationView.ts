/**
 * Pure view-model for the Multiplayer v1 collaboration surfaces (P3-4).
 *
 * React-free so it is unit-testable under the Node vitest env. Everything here
 * operates on the ALREADY-SAFE shapes the main process projects out
 * (SafeCollaborator / SafeActivity / SafeContribution) — there is no canonical
 * DID, membership id, contribution id or `invt_…` capability at this layer, and
 * this module must never introduce one.
 *
 * The rules encoded here are the server's, not ours:
 *  - roles are `owner` | `view` | `comment`; there is no `edit`;
 *  - only a `comment` collaborator can contribute versions;
 *  - role changes are NOT supported by the contract — see roleChangeSupport().
 */

import type {
  SafeCollaborator, SafeActivity, SafeContribution, ActivityKind, CollaboratorState,
} from './api';

// ── Resolution (find a collaborator) ─────────────────────────────────────────

export type ResolveState =
  | { kind: 'idle' }
  | { kind: 'resolving' }
  | { kind: 'resolved'; ref: string; displayName: string | null; avatarUrl: string | null; expiresAtMs: number }
  /** ONE state for "no account" and "not discoverable" — never distinguished. */
  | { kind: 'unresolved' }
  | { kind: 'rate-limited' }
  | { kind: 'offline' }
  | { kind: 'auth-required' }
  | { kind: 'error'; message: string };

/**
 * The single message for a non-resolving lookup. The server deliberately makes
 * a hidden account and a nonexistent one indistinguishable; showing two
 * different strings here would undo that.
 */
export const UNRESOLVED_TEXT = 'No inviteable Wavi account found.';

export function resolveStateText(s: ResolveState): string {
  switch (s.kind) {
    case 'idle': return '';
    case 'resolving': return 'Looking up…';
    case 'resolved': return s.displayName ?? 'Wavi account';
    case 'unresolved': return UNRESOLVED_TEXT;
    case 'rate-limited': return 'Too many lookups. Wait a few minutes and try again.';
    case 'offline': return 'You appear to be offline.';
    case 'auth-required': return 'Sign in to Wavi to invite collaborators.';
    case 'error': return s.message;
  }
}

/** Map an IPC failure reason onto a resolution state. */
export function resolveStateFromReason(reason: string | undefined, message?: string): ResolveState {
  switch (reason) {
    case 'rate-limited': return { kind: 'rate-limited' };
    case 'offline': return { kind: 'offline' };
    case 'unauthorized': return { kind: 'auth-required' };
    default: return { kind: 'error', message: message ?? 'That lookup could not be completed.' };
  }
}

/** A resolved target is only usable until the server's 10-minute TTL elapses. */
export function isTargetExpired(s: ResolveState, now = Date.now()): boolean {
  return s.kind === 'resolved' && now >= s.expiresAtMs;
}

// ── Invite form rules ────────────────────────────────────────────────────────

export type InviteRole = 'view' | 'comment';

/**
 * Only a `comment` collaborator can contribute — the server computes
 * `can_contribute = role === 'comment' && canContribute`. The UI therefore
 * disables the toggle for `view` rather than letting the request be silently
 * downgraded.
 */
export function contributionToggleEnabled(role: InviteRole): boolean {
  return role === 'comment';
}

export function effectiveCanContribute(role: InviteRole, requested: boolean): boolean {
  return role === 'comment' && requested;
}

export function contributionHelpText(role: InviteRole): string {
  return role === 'comment'
    ? 'They can submit new versions for you to review.'
    : 'Only a “comment” collaborator can submit versions.';
}

export function canSubmitInvite(s: ResolveState, now = Date.now()): boolean {
  return s.kind === 'resolved' && !isTargetExpired(s, now);
}

// ── Roster ───────────────────────────────────────────────────────────────────

export type CollaboratorTone = 'active' | 'pending' | 'inactive' | 'unknown';

export function collaboratorTone(state: CollaboratorState): CollaboratorTone {
  switch (state) {
    case 'active': return 'active';
    case 'pending': return 'pending';
    case 'declined':
    case 'revoked':
    case 'expired': return 'inactive';
    default: return 'unknown';
  }
}

export const COLLABORATOR_STATE_LABEL: Record<CollaboratorState, string> = {
  active: 'Active',
  pending: 'Invitation pending',
  declined: 'Declined',
  revoked: 'Removed',
  expired: 'Invitation expired',
  unknown: 'Unknown',
};

/** One-line permission summary. Role and contribution stay distinct. */
export function permissionSummary(c: Pick<SafeCollaborator, 'role' | 'canContribute'>): string {
  if (c.role === 'owner') return 'Owner';
  const base = c.role === 'comment' ? 'Can comment' : 'Can view';
  return c.canContribute ? `${base} · can contribute versions` : base;
}

/**
 * The contract has NO update-membership action. Changing someone's role would
 * mean revoking and re-inviting them, which is a different, destructive
 * operation — so the UI states the limitation instead of offering a control
 * that silently does something else.
 */
export function roleChangeSupport(): { supported: false; explanation: string } {
  return {
    supported: false,
    explanation: 'Roles cannot be changed after inviting. Remove this collaborator and invite them again with the new role.',
  };
}

/** Owners may remove others; a non-owner may only remove themselves. */
export function canRemoveCollaborator(c: Pick<SafeCollaborator, 'role' | 'state'>, viewerIsOwner: boolean): boolean {
  if (c.role === 'owner') return false;                  // server 409s on the owner row
  if (c.state === 'revoked') return false;
  return viewerIsOwner;
}

/** Owner first, then active, pending, and finally inactive rows. */
export function sortRoster(rows: SafeCollaborator[]): SafeCollaborator[] {
  const rank = (c: SafeCollaborator) =>
    c.role === 'owner' ? 0 : c.state === 'active' ? 1 : c.state === 'pending' ? 2 : 3;
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.displayName ?? '').localeCompare(b.displayName ?? ''));
}

// ── Activity ─────────────────────────────────────────────────────────────────

/** Compact human phrasing for the closed enum. Unknown types never arrive. */
export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  collaborator_invited: 'invited a collaborator',
  collaborator_joined: 'joined the project',
  collaborator_removed: 'removed a collaborator',
  version_published: 'published a version',
  contribution_submitted: 'submitted a contribution',
  contribution_accepted: 'accepted a contribution',
  contribution_rejected: 'rejected a contribution',
  contribution_withdrawn: 'withdrew a contribution',
};

export function activityLine(e: SafeActivity): string {
  const who = e.displayName ?? 'Someone';
  return `${who} ${ACTIVITY_LABEL[e.type]}`;
}

/**
 * Honest footnote when the feed is partial or contained events this build
 * cannot describe. Returns null when there is nothing to disclose.
 */
export function activityFootnote(pageComplete: boolean, skippedUnknownEvents: number): string | null {
  const parts: string[] = [];
  if (!pageComplete) parts.push('more activity is available');
  if (skippedUnknownEvents > 0) {
    parts.push(`${skippedUnknownEvents} newer event${skippedUnknownEvents === 1 ? '' : 's'} could not be shown`);
  }
  return parts.length ? parts.join(' · ') : null;
}

// ── Contributions + lineage ──────────────────────────────────────────────────

/** Filter tabs over the authoritative queue. `all` omits the server filter. */
export type ContributionFilter = 'all' | 'submitted' | 'accepted' | 'rejected' | 'withdrawn';

export const CONTRIBUTION_FILTERS: { id: ContributionFilter; label: string }[] = [
  { id: 'submitted', label: 'Awaiting review' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'withdrawn', label: 'Withdrawn' },
  { id: 'all', label: 'All' },
];

/** `all` means "send no state filter" — the server 400s on an unknown value. */
export function filterToServerState(f: ContributionFilter): string | null {
  return f === 'all' ? null : f;
}

/**
 * Empty-state copy that reflects WHY the queue is empty. An owner with no
 * pending reviews is a different (and reassuring) situation from a contributor
 * who has submitted nothing.
 */
export function contributionsEmptyText(filter: ContributionFilter, isOwner: boolean): string {
  if (filter === 'submitted') {
    return isOwner ? 'Nothing is waiting for your review.' : 'You have no contributions awaiting review.';
  }
  if (filter === 'all') {
    return isOwner ? 'No contributions have been submitted to this project.' : 'You have not submitted any contributions.';
  }
  return `No ${filter} contributions.`;
}

export type ContributionAction = 'accept' | 'reject' | 'withdraw';

/**
 * Which controls to render. Only a submitted contribution is actionable; the
 * owner reviews, the contributor withdraws. Anything already resolved offers
 * nothing — the UI must not imply a decision can be reversed.
 *
 * `isContributor` is safe to derive from "not the owner": the server only
 * returns a non-owner their OWN contributions, so any row a non-owner can see
 * is by definition theirs. The server re-checks on the mutation regardless.
 */
export function contributionActions(
  c: Pick<SafeContribution, 'state'>,
  viewer: { isOwner: boolean; isContributor: boolean },
): ContributionAction[] {
  if (c.state !== 'submitted') return [];
  const actions: ContributionAction[] = [];
  if (viewer.isOwner) actions.push('accept', 'reject');
  if (viewer.isContributor) actions.push('withdraw');
  return actions;
}

export const CONTRIBUTION_STATE_LABEL: Record<SafeContribution['state'], string> = {
  submitted: 'Awaiting review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  unknown: 'Unknown',
};

export function contributionTone(state: SafeContribution['state']): 'pending' | 'active' | 'inactive' | 'unknown' {
  switch (state) {
    case 'submitted': return 'pending';
    case 'accepted': return 'active';
    case 'rejected':
    case 'withdrawn': return 'inactive';
    default: return 'unknown';
  }
}

/**
 * Compact lineage caption for a version row.
 *
 * Restoring an old version creates a NEW DESCENDANT — history is never
 * rewritten — so a contribution is always described relative to its parent and
 * never as a modification of it.
 */
export function lineageCaption(opts: {
  parentVersionLabel?: string | null;
  isContribution: boolean;
  state?: SafeContribution['state'];
}): string | null {
  const parts: string[] = [];
  if (opts.parentVersionLabel) parts.push(`Based on ${opts.parentVersionLabel}`);
  if (opts.isContribution) {
    parts.push('Contribution');
    if (opts.state === 'accepted') parts.push('Accepted');
    else if (opts.state === 'rejected') parts.push('Rejected');
    else if (opts.state === 'withdrawn') parts.push('Withdrawn');
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * A mutation result must never be applied optimistically. This maps the IPC
 * reply to what the UI should do next: `applied` only on server confirmation,
 * `reconcile` when the server says the state moved underneath us (409).
 */
export type MutationOutcome =
  | { kind: 'applied'; alreadyResolved: boolean }
  | { kind: 'reconcile'; message: string }
  | { kind: 'failed'; message: string };

export function mutationOutcome(reply: {
  ok?: boolean; error?: string; reason?: string; alreadyResolved?: boolean; alreadyRevoked?: boolean;
}): MutationOutcome {
  if (reply.ok) return { kind: 'applied', alreadyResolved: reply.alreadyResolved === true || reply.alreadyRevoked === true };
  if (reply.reason === 'conflict') {
    return { kind: 'reconcile', message: reply.error ?? 'This changed elsewhere — refreshing.' };
  }
  return { kind: 'failed', message: reply.error ?? 'That action could not be completed.' };
}
