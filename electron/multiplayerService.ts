/**
 * Multiplayer v1 — desktop adapter against the LOCKED server contract.
 *
 * Server authority: `wavio@6a4a9e8` · `api/desktop/multiplayer.ts`, dispatched
 * from `api/desktop/index.ts` after the three Project Link actions. Transport is
 * the SAME locked one as Project Links — the desktop action POST built by
 * `buildDesktopEndpoint`, with the action header and bearer token applied by the
 * caller in main.ts. This module performs NO networking of its own: it takes an
 * injected `postDesktop` dependency, so the app keeps exactly one HTTP
 * implementation and this is not a second one. (The privacy suite enforces that
 * by asserting no transport/header/credential code appears in this file.)
 *
 * Invariants preserved from Phase 3:
 *  - The canonical Privy DID stays in the main process. It is returned by the
 *    server as top-level `accountId`, is used for local scoping, and is NEVER
 *    projected into renderer payloads, assistant tool results, or model prompts
 *    (see toRendererAccountHandle / multiplayerRefs.ts).
 *  - Nothing is fabricated: every result is either a server-confirmed shape or a
 *    typed failure. A malformed body is a failure, not a partial success.
 *  - Role vocabulary is `owner` | `view` | `comment`. There is no `edit`, and
 *    contribution permission is carried SEPARATELY as `canContribute` — it is
 *    never inferred from `comment`.
 *  - `sourceRestoreId` is a desktop-local row id, not a server identity, and is
 *    never sent to the server.
 */

import type { DesktopResponse } from './projectLinkService';

// ── Locked action + event vocabulary (mirrors the server constants exactly) ──

export const MULTIPLAYER_ACTIONS = {
  resolveInviteTarget: 'resolve-invite-target',
  listCollaborators: 'list-project-collaborators',
  invite: 'invite-project-collaborator',
  respondInvite: 'respond-project-invite',
  revokeCollaborator: 'revoke-project-collaborator',
  listActivity: 'list-project-activity',
  listContributions: 'list-project-contributions',
  publishVersion: 'publish-project-version',
  respondContribution: 'respond-project-contribution',
  withdrawContribution: 'withdraw-project-contribution',
} as const;

/** Closed event vocabulary. An unknown type is DROPPED, never rendered raw. */
export const ACTIVITY_TYPES = [
  'collaborator_invited',
  'collaborator_joined',
  'collaborator_removed',
  'version_published',
  'contribution_submitted',
  'contribution_accepted',
  'contribution_rejected',
  'contribution_withdrawn',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Roles the desktop may send. `edit` is rejected before the network. */
export const ASSIGNABLE_ROLES = ['view', 'comment'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
export type MembershipRole = 'owner' | AssignableRole;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;
const MAX_PAGES = 100; // hard safety cap on pagination

export interface MultiplayerServiceDeps {
  postDesktop: (action: string, body: Record<string, unknown>) => Promise<DesktopResponse>;
  isOnline: () => boolean;
}

// ── Parsed, fail-closed server shapes ────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function bool(v: unknown): boolean {
  return v === true;
}

/** Actor as the server returns it — display fields only, never an identity. */
export interface ActorView {
  displayName: string | null;
  avatarUrl: string | null;
}

export interface MembershipStateFlags {
  active: boolean;
  pending: boolean;
  declined: boolean;
  revoked: boolean;
  expired: boolean;
}

export interface Membership {
  membershipId: string;
  projectId: string;
  role: MembershipRole;
  /** Server-computed: `role === 'owner' || can_contribute`. Carried separately. */
  canContribute: boolean;
  state: MembershipStateFlags;
  actor: ActorView;
  createdAt: string | null;
  updatedAt: string | null;
  acceptedAt: string | null;
  expiresAt: string | null;
  revision: string | null;
}

export interface ActivitySubject {
  versionId: string | null;
  contributionId: string | null;
  membershipId: string | null;
  trackingId: string | null;
  commentId: string | null;
}

export interface ActivityEvent {
  activityId: string;
  projectId: string;
  type: ActivityType;
  actor: ActorView;
  subject: ActivitySubject;
  occurredAt: string | null;
  revision: string | null;
}

export interface ContributionStateFlags {
  submitted: boolean;
  accepted: boolean;
  rejected: boolean;
  withdrawn: boolean;
}

export interface Contribution {
  contributionId: string;
  projectId: string;
  parentVersionId: string | null;
  childVersionId: string | null;
  state: ContributionStateFlags;
  contributorNote: string | null;
  clientCorrelationId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  reviewedAt: string | null;
  withdrawnAt: string | null;
  revision: string | null;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseActor(raw: unknown): ActorView {
  const w = (raw ?? {}) as Record<string, unknown>;
  return { displayName: str(w.displayName), avatarUrl: str(w.avatarUrl) };
}

/**
 * Membership parse. `role` must be one of the three known values — an unknown
 * role fails closed rather than being surfaced as a permission we can't reason
 * about. `canContribute` is read from its own field; it is NEVER derived from
 * the role being `comment`.
 */
export function parseMembership(raw: unknown): ParseResult<Membership> {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'membership not an object' };
  const w = raw as Record<string, any>;
  const membershipId = str(w.membershipId);
  if (!membershipId) return { ok: false, reason: 'missing membershipId' };
  const projectId = str(w.projectId);
  if (!projectId) return { ok: false, reason: 'missing projectId' };
  const role = str(w.role);
  if (role !== 'owner' && role !== 'view' && role !== 'comment') {
    return { ok: false, reason: `unsupported role: ${role ?? 'null'}` };
  }
  const s = (w.state ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    value: {
      membershipId,
      projectId,
      role,
      canContribute: bool(w.canContribute),
      state: {
        active: bool(s.active),
        pending: bool(s.pending),
        declined: bool(s.declined),
        revoked: bool(s.revoked),
        expired: bool(s.expired),
      },
      actor: parseActor(w.actor),
      createdAt: str(w.createdAt),
      updatedAt: str(w.updatedAt),
      acceptedAt: str(w.acceptedAt),
      expiresAt: str(w.expiresAt),
      revision: str(w.revision),
    },
  };
}

/** Activity parse. An unknown `type` is reported so the caller can DROP it. */
export function parseActivity(raw: unknown): ParseResult<ActivityEvent> {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'activity not an object' };
  const w = raw as Record<string, any>;
  const activityId = str(w.activityId);
  if (!activityId) return { ok: false, reason: 'missing activityId' };
  const projectId = str(w.projectId);
  if (!projectId) return { ok: false, reason: 'missing projectId' };
  const type = str(w.type);
  if (!type || !(ACTIVITY_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: `unknown-activity-type:${type ?? 'null'}` };
  }
  const sub = (w.subject ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    value: {
      activityId,
      projectId,
      type: type as ActivityType,
      actor: parseActor(w.actor),
      subject: {
        versionId: str(sub.versionId),
        contributionId: str(sub.contributionId),
        membershipId: str(sub.membershipId),
        trackingId: str(sub.trackingId),
        commentId: str(sub.commentId),
      },
      occurredAt: str(w.occurredAt),
      revision: str(w.revision),
    },
  };
}

export function parseContribution(raw: unknown): ParseResult<Contribution> {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'contribution not an object' };
  const w = raw as Record<string, any>;
  const contributionId = str(w.contributionId);
  if (!contributionId) return { ok: false, reason: 'missing contributionId' };
  const projectId = str(w.projectId);
  if (!projectId) return { ok: false, reason: 'missing projectId' };
  const s = (w.state ?? {}) as Record<string, unknown>;
  const flags = {
    submitted: bool(s.submitted),
    accepted: bool(s.accepted),
    rejected: bool(s.rejected),
    withdrawn: bool(s.withdrawn),
  };
  // The server derives these from ONE `state` column, so exactly one is true.
  // Zero (or two) means the row is not something we can describe — a review
  // queue that silently renders an "unknown" item is worse than an honest
  // failure, so fail closed rather than guessing by precedence.
  const set = Object.values(flags).filter(Boolean).length;
  if (set !== 1) return { ok: false, reason: `contribution state must have exactly one flag set, got ${set}` };
  return {
    ok: true,
    value: {
      contributionId,
      projectId,
      parentVersionId: str(w.parentVersionId),
      childVersionId: str(w.childVersionId),
      state: flags,
      contributorNote: str(w.contributorNote),
      clientCorrelationId: str(w.clientCorrelationId),
      createdAt: str(w.createdAt),
      updatedAt: str(w.updatedAt),
      reviewedAt: str(w.reviewedAt),
      withdrawnAt: str(w.withdrawnAt),
      revision: str(w.revision),
    },
  };
}

// ── Typed failures ───────────────────────────────────────────────────────────

export type MpFailureReason =
  | 'offline'
  | 'unauthorized'
  /** 403 — authenticated but not permitted (non-owner, wrong account, no contribute right). */
  | 'forbidden'
  | 'rejected'
  | 'not-found'
  | 'conflict'
  /** 410 — the invite expired. Distinct from `conflict`: it is terminal, not a race. */
  | 'invite-expired'
  | 'retryable'
  | 'malformed'
  /**
   * A publish/contribution request was interrupted mid-flight. Because the
   * server keys the insert on `operationKey`, recovery is to REPLAY THE SAME
   * KEY — never to mint a new one and never to report success.
   */
  | 'contribution-outcome-unknown'
  /** 429 — the server's invite-lookup rate limit (10 per 15 min per owner+project). */
  | 'rate-limited'
  /** The opaque invite target expired (10 min TTL) or was never valid. */
  | 'invite-target-expired'
  | 'stale-session';

/**
 * Contract-pinned status mapping. 403 is kept distinct from 401 (signing in
 * again will not help) and 410 distinct from 409 (an expired invite is
 * terminal, a conflict is a state race the caller can re-read out of).
 */
export function classifyMultiplayerHttpFailure(status: number, online: boolean): MpFailureReason {
  if (!online) return 'offline';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 410) return 'invite-expired';
  if (status === 429) return 'rate-limited';
  if (status === 400) return 'rejected';
  if (status >= 500) return 'retryable';
  return 'malformed';
}

function failureFrom(res: DesktopResponse, online: boolean): { reason: MpFailureReason; message?: string } {
  if (res.threw || !online) return { reason: 'offline' };
  const body = (res.json ?? {}) as Record<string, unknown>;
  return { reason: classifyMultiplayerHttpFailure(res.status, online), message: str(body.error) ?? undefined };
}

export type Failure = { kind: 'failure'; reason: MpFailureReason; message?: string };

// ── Paginated listings ───────────────────────────────────────────────────────

export interface PageInfoView {
  limit: number | null;
  hasMore: boolean;
  nextCursor: string | null;
  order: string | null;
  scope: string | null;
}

export type ListResult<T> =
  | { kind: 'ok'; accountId: string; records: T[]; pageComplete: boolean; droppedUnknown: number }
  | Failure;

/** Clamp a caller-requested page size into the server's contract window. */
export function clampLimit(requested?: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return DEFAULT_LIST_LIMIT;
  const n = Math.floor(requested);
  if (n < 1) return 1;
  if (n > MAX_LIST_LIMIT) return MAX_LIST_LIMIT;
  return n;
}

async function listAll<T>(
  deps: MultiplayerServiceDeps,
  action: string,
  body: Record<string, unknown>,
  parse: (raw: unknown) => ParseResult<T>,
  /** Unknown-enum items are dropped rather than failing the whole page. */
  dropUnknown: (reason: string) => boolean,
): Promise<ListResult<T>> {
  const records: T[] = [];
  let accountId: string | null = null;
  let cursor: string | null = null;
  let droppedUnknown = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    let res: DesktopResponse;
    try {
      res = await deps.postDesktop(action, { ...body, ...(cursor ? { cursor } : {}) });
    } catch {
      return { kind: 'failure', reason: 'offline' };
    }
    const online = deps.isOnline();
    if (res.threw || res.status !== 200) {
      const f = failureFrom(res, online);
      return { kind: 'failure', reason: f.reason, message: f.message };
    }
    const json = (res.json ?? {}) as Record<string, any>;
    const acct = str(json.accountId);
    if (!acct) return { kind: 'failure', reason: 'malformed', message: 'missing accountId' };
    if (accountId && acct !== accountId) {
      // The account changed between pages — the pages cannot be one listing.
      return { kind: 'failure', reason: 'stale-session', message: 'account changed mid-pagination' };
    }
    accountId = acct;
    if (!Array.isArray(json.items)) return { kind: 'failure', reason: 'malformed', message: 'items not an array' };
    for (const raw of json.items) {
      const p = parse(raw);
      if (p.ok) { records.push(p.value); continue; }
      if (dropUnknown(p.reason)) { droppedUnknown++; continue; }
      return { kind: 'failure', reason: 'malformed', message: p.reason };
    }
    const hasMore = json.pageInfo?.hasMore === true;
    cursor = str(json.pageInfo?.nextCursor);
    if (!hasMore || !cursor) {
      return { kind: 'ok', accountId, records, pageComplete: !hasMore, droppedUnknown };
    }
  }
  // Safety cap reached without the server signalling completion.
  return { kind: 'ok', accountId: accountId!, records, pageComplete: false, droppedUnknown };
}

export function listCollaboratorsAll(
  deps: MultiplayerServiceDeps,
  opts: { projectId: string; limit?: number },
): Promise<ListResult<Membership>> {
  return listAll(
    deps,
    MULTIPLAYER_ACTIONS.listCollaborators,
    { projectId: opts.projectId, limit: clampLimit(opts.limit) },
    parseMembership,
    // A membership whose role we cannot interpret is a REAL permission we would
    // be guessing at — fail the listing rather than silently omit a collaborator.
    () => false,
  );
}

export function listActivityAll(
  deps: MultiplayerServiceDeps,
  opts: { projectId: string; limit?: number },
): Promise<ListResult<ActivityEvent>> {
  return listAll(
    deps,
    MULTIPLAYER_ACTIONS.listActivity,
    { projectId: opts.projectId, limit: clampLimit(opts.limit) },
    parseActivity,
    // Activity is an append-only feed: a future event type we don't know how to
    // describe is dropped (and counted) rather than shown as raw server text.
    (reason) => reason.startsWith('unknown-activity-type:'),
  );
}

/** The states the listing may be filtered by — mirrors the server's own list. */
export const CONTRIBUTION_STATES = ['submitted', 'accepted', 'rejected', 'withdrawn'] as const;
export type ContributionStateFilter = (typeof CONTRIBUTION_STATES)[number];

export function isContributionStateFilter(v: unknown): v is ContributionStateFilter {
  return typeof v === 'string' && (CONTRIBUTION_STATES as readonly string[]).includes(v);
}

/**
 * P3-4-CL — the authoritative contribution listing.
 *
 * Visibility is decided SERVER-SIDE: the owner sees every contribution on the
 * project; anyone else sees only their own (`contributor_account_id = caller`).
 * The desktop must not re-filter or widen that.
 *
 * `state` is omitted entirely when absent — the server 400s on an unrecognised
 * value, so an invalid filter fails locally rather than burning a request.
 */
export function listContributionsAll(
  deps: MultiplayerServiceDeps,
  opts: { projectId: string; state?: ContributionStateFilter | null; limit?: number },
): Promise<ListResult<Contribution>> {
  return listAll(
    deps,
    MULTIPLAYER_ACTIONS.listContributions,
    {
      projectId: opts.projectId,
      limit: clampLimit(opts.limit),
      ...(opts.state ? { state: opts.state } : {}),
    },
    parseContribution,
    // A contribution we cannot parse is a real review item we would be hiding —
    // fail the listing rather than silently shortening an owner's review queue.
    () => false,
  );
}

// ── Identity resolution (P3-4-ID) ────────────────────────────────────────────

/** Canonical Privy DID — main-process/server-side only, never a UI input. */
const PRIVY_DID_RE = /^did:privy:[A-Za-z0-9]+$/;

/** Opaque server-minted invite capability. Never parsed for identity. */
export const INVITE_TARGET_RE = /^invt_[A-Za-z0-9_-]{32}$/;

/** Server TTL for a minted invite target (10 minutes). */
export const INVITE_TARGET_TTL_MS = 10 * 60 * 1000;

export type IdentifierCheck =
  | { ok: true; kind: 'email' | 'handle' }
  | { ok: false; reason: string };

/**
 * Mirror of the server's `parseInviteIdentifier` — validated locally so an
 * obviously malformed entry never consumes one of the user's 10 lookups per
 * 15 minutes. This is validation ONLY: the raw identifier is passed through
 * untransformed apart from trimming, and the server's own normalization
 * (lowercasing, `@` stripping) remains authoritative.
 */
export function checkInviteIdentifier(value: unknown): IdentifierCheck {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: false, reason: 'Enter an email address or @handle.' };
  if (raw.length > 254) return { ok: false, reason: 'That identifier is too long.' };
  const lowered = raw.toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lowered)) return { ok: true, kind: 'email' };
  if (/^@[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$/.test(lowered)) return { ok: true, kind: 'handle' };
  return { ok: false, reason: 'Enter a valid email address or @handle.' };
}

/**
 * Result of a lookup. `resolved: false` is deliberately ONE state covering both
 * "no such account" and "account is not discoverable" — the server makes them
 * indistinguishable on purpose and the desktop must not try to tell them apart
 * or word them differently.
 */
export type ResolveInviteTargetResult =
  | {
      kind: 'resolved';
      accountId: string;
      /** Opaque capability. Stays in the main process. */
      inviteTarget: string;
      /** Display-only. Never an identity. */
      display: ActorView;
      /** Local expiry derived from the server's stated TTL. */
      expiresAtMs: number;
    }
  | { kind: 'unresolved'; accountId: string }
  | Failure;

export async function resolveInviteTargetFlow(
  deps: MultiplayerServiceDeps,
  opts: { projectId: string; identifier: string },
  now = Date.now(),
): Promise<ResolveInviteTargetResult> {
  if (!opts.projectId) {
    return { kind: 'failure', reason: 'rejected', message: 'Select a project first.' };
  }
  const check = checkInviteIdentifier(opts.identifier);
  if (!check.ok) return { kind: 'failure', reason: 'rejected', message: check.reason };

  let res: DesktopResponse;
  try {
    res = await deps.postDesktop(MULTIPLAYER_ACTIONS.resolveInviteTarget, {
      projectId: opts.projectId,
      identifier: opts.identifier.trim(),
    });
  } catch { return { kind: 'failure', reason: 'offline' }; }

  const online = deps.isOnline();
  if (res.threw || res.status !== 200) {
    const f = failureFrom(res, online);
    return { kind: 'failure', reason: f.reason, message: f.message };
  }
  const json = (res.json ?? {}) as Record<string, any>;
  const accountId = str(json.accountId);
  if (!accountId) return { kind: 'failure', reason: 'malformed', message: 'missing accountId' };

  if (json.resolved !== true) return { kind: 'unresolved', accountId };

  const inviteTarget = str(json.inviteTarget);
  if (!inviteTarget || !INVITE_TARGET_RE.test(inviteTarget)) {
    return { kind: 'failure', reason: 'malformed', message: 'invalid invite target' };
  }
  return {
    kind: 'resolved',
    accountId,
    inviteTarget,
    display: parseActor(json.display),
    expiresAtMs: now + INVITE_TARGET_TTL_MS,
  };
}

// ── Membership mutations ─────────────────────────────────────────────────────

export type RoleCheck = { ok: true; role: AssignableRole } | { ok: false; reason: string };

/**
 * Reject `edit` (and anything else outside the contract) BEFORE the network.
 * The server would answer 400; failing locally keeps the vocabulary honest and
 * avoids a request that can never succeed.
 */
export function normalizeAssignableRole(role: unknown): RoleCheck {
  if (role === 'view' || role === 'comment') return { ok: true, role };
  if (role === 'edit') {
    return { ok: false, reason: 'The role "edit" does not exist in this contract. Use "view" or "comment".' };
  }
  return { ok: false, reason: `Unsupported role: ${typeof role === 'string' ? role : 'null'}. Use "view" or "comment".` };
}

/**
 * The server computes `can_contribute = role === 'comment' && canContribute === true`.
 * A `view` collaborator therefore can NEVER contribute — asking for it is
 * silently downgraded server-side, so the desktop must not offer or imply it.
 */
export function contributionAllowedForRole(role: AssignableRole): boolean {
  return role === 'comment';
}

export type InviteResult =
  | { kind: 'invited'; accountId: string; membership: Membership; alreadyInvited: boolean }
  | Failure;

/**
 * Invite a collaborator.
 *
 * The DESKTOP path always uses an opaque `inviteTarget` minted by
 * `resolve-invite-target` — it never handles a canonical DID for invite UX.
 * The direct-DID form remains supported by the server for other callers, and is
 * accepted here only so main-process/internal code paths keep working; the UI
 * and the assistant must never reach it. The server rejects supplying both.
 */
export async function inviteCollaboratorFlow(
  deps: MultiplayerServiceDeps,
  opts: {
    projectId: string;
    /** Preferred: opaque server-minted target from resolve-invite-target. */
    inviteTarget?: string;
    /** Legacy/internal only — never sourced from renderer or model input. */
    inviteeAccountId?: string;
    role: unknown;
    canContribute?: boolean;
  },
): Promise<InviteResult> {
  const roleCheck = normalizeAssignableRole(opts.role);
  if (!roleCheck.ok) return { kind: 'failure', reason: 'rejected', message: roleCheck.reason };

  const hasTarget = typeof opts.inviteTarget === 'string' && opts.inviteTarget.length > 0;
  const hasDid = typeof opts.inviteeAccountId === 'string' && opts.inviteeAccountId.length > 0;
  if (hasTarget === hasDid) {
    // The server 400s on both-or-neither; fail locally with a clearer reason.
    return {
      kind: 'failure',
      reason: 'rejected',
      message: hasDid
        ? 'Provide exactly one invite identity.'
        : 'Find the collaborator first — an invite needs a resolved target.',
    };
  }
  if (hasTarget && !INVITE_TARGET_RE.test(opts.inviteTarget!)) {
    return { kind: 'failure', reason: 'invite-target-expired', message: 'That collaborator lookup is no longer valid. Search again.' };
  }
  if (hasDid && !PRIVY_DID_RE.test(opts.inviteeAccountId!)) {
    return {
      kind: 'failure',
      reason: 'rejected',
      message: opts.inviteeAccountId!.includes('@')
        ? 'Email invitations are not supported by this contract — resolve the collaborator first.'
        : 'A canonical account id is required to invite a collaborator.',
    };
  }

  let res: DesktopResponse;
  try {
    res = await deps.postDesktop(MULTIPLAYER_ACTIONS.invite, {
      projectId: opts.projectId,
      ...(hasTarget ? { inviteTarget: opts.inviteTarget } : { inviteeAccountId: opts.inviteeAccountId }),
      role: roleCheck.role,
      // Server forces false unless the role is `comment`; mirror that here so
      // the request never claims a permission the server will not grant.
      canContribute: contributionAllowedForRole(roleCheck.role) && opts.canContribute === true,
    });
  } catch {
    // Invite IS deduplicated server-side (duplicate pending → alreadyInvited),
    // so an interrupted request is recoverable by re-listing collaborators.
    return { kind: 'failure', reason: 'offline' };
  }
  const online = deps.isOnline();
  if (res.threw || res.status !== 200) {
    const f = failureFrom(res, online);
    return { kind: 'failure', reason: f.reason, message: f.message };
  }
  const json = (res.json ?? {}) as Record<string, any>;
  const accountId = str(json.accountId);
  if (!accountId) return { kind: 'failure', reason: 'malformed', message: 'missing accountId' };
  if (json.invited !== true && json.alreadyInvited !== true) {
    return { kind: 'failure', reason: 'malformed', message: 'no confirmation flag' };
  }
  const p = parseMembership(json.item);
  if (!p.ok) return { kind: 'failure', reason: 'malformed', message: p.reason };
  return { kind: 'invited', accountId, membership: p.value, alreadyInvited: json.alreadyInvited === true };
}

export type RespondInviteResult =
  | { kind: 'responded'; accountId: string; membership: Membership; accepted: boolean; alreadyResponded: boolean }
  | Failure;

/**
 * Accept or decline an invite addressed to the ACTIVE account (server-enforced).
 *
 * The wire field is `response: 'accept' | 'decline'` — NOT a boolean. Verified
 * against the locked handler, which 400s on anything else.
 */
export async function respondInviteFlow(
  deps: MultiplayerServiceDeps,
  opts: { membershipId: string; accept: boolean },
): Promise<RespondInviteResult> {
  let res: DesktopResponse;
  try {
    res = await deps.postDesktop(MULTIPLAYER_ACTIONS.respondInvite, {
      membershipId: opts.membershipId,
      response: opts.accept === true ? 'accept' : 'decline',
    });
  } catch { return { kind: 'failure', reason: 'offline' }; }
  const online = deps.isOnline();
  if (res.threw || res.status !== 200) {
    const f = failureFrom(res, online);
    return { kind: 'failure', reason: f.reason, message: f.message };
  }
  const json = (res.json ?? {}) as Record<string, any>;
  const accountId = str(json.accountId);
  if (!accountId) return { kind: 'failure', reason: 'malformed', message: 'missing accountId' };
  const already = json.alreadyAccepted === true || json.alreadyDeclined === true;
  if (json.accepted !== true && json.declined !== true && !already) {
    return { kind: 'failure', reason: 'malformed', message: 'no confirmation flag' };
  }
  const p = parseMembership(json.item);
  if (!p.ok) return { kind: 'failure', reason: 'malformed', message: p.reason };
  return {
    kind: 'responded',
    accountId,
    membership: p.value,
    accepted: json.accepted === true || json.alreadyAccepted === true,
    alreadyResponded: already,
  };
}

export type RevokeMembershipResult =
  | { kind: 'revoked'; accountId: string; membership: Membership; alreadyRevoked: boolean }
  | Failure;

/**
 * Remove a collaborator. The same action covers SELF-LEAVE (a non-owner
 * removing their own accepted membership) — the server decides which applies;
 * the desktop does not pre-judge it. Revoking the owner row is a 409.
 */
export async function revokeCollaboratorFlow(
  deps: MultiplayerServiceDeps,
  opts: { projectId: string; membershipId: string },
): Promise<RevokeMembershipResult> {
  let res: DesktopResponse;
  try {
    // The locked handler requires BOTH ids — it 400s without projectId.
    res = await deps.postDesktop(MULTIPLAYER_ACTIONS.revokeCollaborator, {
      projectId: opts.projectId,
      membershipId: opts.membershipId,
    });
  } catch { return { kind: 'failure', reason: 'offline' }; }
  const online = deps.isOnline();
  if (res.threw || res.status !== 200) {
    const f = failureFrom(res, online);
    return { kind: 'failure', reason: f.reason, message: f.message };
  }
  const json = (res.json ?? {}) as Record<string, any>;
  const accountId = str(json.accountId);
  if (!accountId) return { kind: 'failure', reason: 'malformed', message: 'missing accountId' };
  if (json.revoked !== true && json.alreadyRevoked !== true) {
    return { kind: 'failure', reason: 'malformed', message: 'no confirmation flag' };
  }
  const p = parseMembership(json.item);
  if (!p.ok) return { kind: 'failure', reason: 'malformed', message: p.reason };
  return { kind: 'revoked', accountId, membership: p.value, alreadyRevoked: json.alreadyRevoked === true };
}

// ── Contribution publishing (operation-key based) ────────────────────────────

/**
 * A contribution publish is NOT naturally idempotent, but the server keys the
 * insert on `operationKey` and replays it (`alreadySubmitted: true` + the
 * ORIGINAL `child_version_id`). The key is therefore the recovery mechanism:
 * generate it ONCE before the mutation, retain it while the outcome is unknown,
 * and replay the SAME key. A new key would create a second contribution.
 */
export interface PendingContributionOp {
  operationKey: string;
  projectId: string;
  parentVersionId: string;
  /** Local project id — lets recovery re-derive the manifest for a retry. */
  localProjectId: string;
  createdAt: number;
}

/** Deterministic per (project, parent, local project, attempt-nonce). */
export function makeOperationKey(seed: {
  projectId: string; parentVersionId: string; localProjectId: string; nonce: string;
}): string {
  const { createHash } = require('crypto') as typeof import('crypto');
  const material = `${seed.projectId}|${seed.parentVersionId}|${seed.localProjectId}|${seed.nonce}`;
  return `dopk_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

/**
 * In-memory ledger of contribution operations whose outcome is not yet known.
 *
 * Deliberately NOT persisted to SQLite: an operation key that outlives the
 * process would let a stale key be replayed under a different account/session,
 * and the server-side listing is already the authoritative recovery path. The
 * ledger's only job is to make a retry WITHIN the session reuse the same key.
 */
export class ContributionOperationLedger {
  private byScope = new Map<string, PendingContributionOp>();

  private static scope(projectId: string, parentVersionId: string, localProjectId: string): string {
    return `${projectId}|${parentVersionId}|${localProjectId}`;
  }

  /** Get the retained key for this exact contribution, or mint and retain one. */
  acquire(seed: { projectId: string; parentVersionId: string; localProjectId: string; nonce?: string }, now = Date.now()): PendingContributionOp {
    const key = ContributionOperationLedger.scope(seed.projectId, seed.parentVersionId, seed.localProjectId);
    const existing = this.byScope.get(key);
    if (existing) return existing;
    const op: PendingContributionOp = {
      operationKey: makeOperationKey({
        projectId: seed.projectId,
        parentVersionId: seed.parentVersionId,
        localProjectId: seed.localProjectId,
        nonce: seed.nonce ?? `${now}`,
      }),
      projectId: seed.projectId,
      parentVersionId: seed.parentVersionId,
      localProjectId: seed.localProjectId,
      createdAt: now,
    };
    this.byScope.set(key, op);
    return op;
  }

  /** The outcome is now known (confirmed or terminally rejected) — release it. */
  release(seed: { projectId: string; parentVersionId: string; localProjectId: string }): void {
    this.byScope.delete(ContributionOperationLedger.scope(seed.projectId, seed.parentVersionId, seed.localProjectId));
  }

  peek(seed: { projectId: string; parentVersionId: string; localProjectId: string }): PendingContributionOp | null {
    return this.byScope.get(ContributionOperationLedger.scope(seed.projectId, seed.parentVersionId, seed.localProjectId)) ?? null;
  }

  /** Logout / account switch: a retained key must never cross accounts. */
  clear(): void { this.byScope.clear(); }

  size(): number { return this.byScope.size; }
}

export interface PublishContributionOpts {
  /** Cloud project id. */
  projectId: string;
  /** REQUIRED in contribution mode — the server 400s without it. */
  parentVersionId: string;
  operationKey: string;
  clientCorrelationId: string;
  contributorNote?: string | null;
  /** The manifest body produced by the EXISTING publish pipeline. */
  manifest: Record<string, unknown>;
}

export type PublishContributionResult =
  | {
      kind: 'published';
      accountId: string;
      versionId: string;
      contribution: Contribution | null;
      /** Server replayed the operation key — this is the ORIGINAL child version. */
      alreadySubmitted: boolean;
    }
  | Failure;

/**
 * Build the contribution publish body from the manifest the existing pipeline
 * already produced. Contribution-only fields are ADDED; nothing about the
 * manifest is re-derived here (there is one manifest builder in this app).
 *
 * `sourceRestoreId` is stripped defensively: it is a desktop-local restored-row
 * id, not a server identity, and must never reach the server.
 */
export function buildContributionBody(opts: PublishContributionOpts): Record<string, unknown> {
  const { sourceRestoreId: _dropped, ...manifest } = opts.manifest as Record<string, unknown> & { sourceRestoreId?: unknown };
  return {
    ...manifest,
    projectId: opts.projectId,
    parentVersionId: opts.parentVersionId,
    contribution: true,
    operationKey: opts.operationKey,
    clientCorrelationId: opts.clientCorrelationId,
    contributorNote: opts.contributorNote ?? null,
  };
}

export async function publishContributionFlow(
  deps: MultiplayerServiceDeps,
  opts: PublishContributionOpts,
): Promise<PublishContributionResult> {
  if (!opts.parentVersionId) {
    return { kind: 'failure', reason: 'rejected', message: 'A parent version is required to submit a contribution.' };
  }
  if (!opts.operationKey) {
    return { kind: 'failure', reason: 'rejected', message: 'Missing operation key — refusing to submit an unrecoverable contribution.' };
  }
  let res: DesktopResponse;
  try {
    res = await deps.postDesktop(MULTIPLAYER_ACTIONS.publishVersion, buildContributionBody(opts));
  } catch {
    return {
      kind: 'failure',
      reason: 'contribution-outcome-unknown',
      message: 'The contribution may or may not have been submitted. Retry with the SAME operation key, or refresh the project to check.',
    };
  }
  if (res.threw) {
    return {
      kind: 'failure',
      reason: 'contribution-outcome-unknown',
      message: 'The contribution may or may not have been submitted. Retry with the SAME operation key, or refresh the project to check.',
    };
  }
  const online = deps.isOnline();
  if (res.status !== 200) {
    const f = failureFrom(res, online);
    return { kind: 'failure', reason: f.reason, message: f.message };
  }
  const json = (res.json ?? {}) as Record<string, any>;
  const accountId = str(json.accountId);
  if (!accountId) return { kind: 'failure', reason: 'malformed', message: 'missing accountId' };
  if (json.published !== true) return { kind: 'failure', reason: 'malformed', message: 'no confirmation flag' };
  const versionId = str(json.versionId);
  if (!versionId) return { kind: 'failure', reason: 'malformed', message: 'missing versionId' };
  let contribution: Contribution | null = null;
  if (json.contribution != null) {
    const p = parseContribution(json.contribution);
    if (!p.ok) return { kind: 'failure', reason: 'malformed', message: p.reason };
    contribution = p.value;
  }
  return { kind: 'published', accountId, versionId, contribution, alreadySubmitted: json.alreadySubmitted === true };
}

// ── Contribution review / withdrawal ─────────────────────────────────────────

export type ContributionMutationResult =
  | { kind: 'confirmed'; accountId: string; contribution: Contribution; alreadyResolved: boolean }
  | Failure;

function parseContributionMutation(res: DesktopResponse, online: boolean, flags: string[]): ContributionMutationResult {
  if (res.threw || res.status !== 200) {
    const f = failureFrom(res, online);
    return { kind: 'failure', reason: f.reason, message: f.message };
  }
  const json = (res.json ?? {}) as Record<string, any>;
  const accountId = str(json.accountId);
  if (!accountId) return { kind: 'failure', reason: 'malformed', message: 'missing accountId' };
  const confirmed = flags.some((f) => json[f] === true);
  if (!confirmed) return { kind: 'failure', reason: 'malformed', message: 'no confirmation flag' };
  // Contribution mutations return the row under `contribution`; membership
  // mutations use `item`. Accept either so one parser serves both.
  const p = parseContribution(json.contribution ?? json.item);
  if (!p.ok) return { kind: 'failure', reason: 'malformed', message: p.reason };
  const alreadyResolved =
    json.alreadyAccepted === true || json.alreadyRejected === true || json.alreadyWithdrawn === true;
  return { kind: 'confirmed', accountId, contribution: p.value, alreadyResolved };
}

/**
 * Owner-only accept/reject of a submitted contribution (403 otherwise).
 *
 * Wire field is `response: 'accept' | 'reject'` — not a boolean. The locked
 * handler accepts NO reviewer note, so the desktop does not offer one rather
 * than silently discarding what a reviewer typed.
 */
export async function respondContributionFlow(
  deps: MultiplayerServiceDeps,
  opts: { contributionId: string; accept: boolean },
): Promise<ContributionMutationResult> {
  let res: DesktopResponse;
  try {
    res = await deps.postDesktop(MULTIPLAYER_ACTIONS.respondContribution, {
      contributionId: opts.contributionId,
      response: opts.accept === true ? 'accept' : 'reject',
    });
  } catch { return { kind: 'failure', reason: 'offline' }; }
  return parseContributionMutation(res, deps.isOnline(), ['accepted', 'rejected', 'alreadyAccepted', 'alreadyRejected']);
}

/** Contributor-only withdrawal of their own submitted contribution (403 otherwise). */
export async function withdrawContributionFlow(
  deps: MultiplayerServiceDeps,
  opts: { contributionId: string },
): Promise<ContributionMutationResult> {
  let res: DesktopResponse;
  try {
    res = await deps.postDesktop(MULTIPLAYER_ACTIONS.withdrawContribution, { contributionId: opts.contributionId });
  } catch { return { kind: 'failure', reason: 'offline' }; }
  return parseContributionMutation(res, deps.isOnline(), ['withdrawn', 'alreadyWithdrawn']);
}
