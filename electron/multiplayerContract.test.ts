/**
 * Multiplayer v1 — contract adapter conformance.
 *
 * Every expectation here is pinned to the LOCKED server implementation
 * (`wavio@6a4a9e8`, `api/desktop/multiplayer.ts`): the action names, the closed
 * activity vocabulary, the mapMembership/mapActivity/mapContribution shapes, the
 * status codes, and the pageInfo contract. Nothing is asserted that the server
 * does not actually do.
 */

import { describe, it, expect } from 'vitest';
import {
  MULTIPLAYER_ACTIONS, ACTIVITY_TYPES, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT,
  clampLimit, classifyMultiplayerHttpFailure, parseMembership, parseActivity,
  parseContribution, listCollaboratorsAll, listActivityAll,
  type MultiplayerServiceDeps,
} from './multiplayerService';

// A minimal recorder for the injected transport.
function fakeDeps(
  responses: Array<{ status: number; json: any } | { threw: true }>,
  online = true,
): MultiplayerServiceDeps & { calls: Array<{ action: string; body: any }> } {
  const calls: Array<{ action: string; body: any }> = [];
  let i = 0;
  return {
    calls,
    isOnline: () => online,
    postDesktop: async (action, body) => {
      calls.push({ action, body });
      const r = responses[Math.min(i++, responses.length - 1)];
      if ('threw' in r) return { status: 0, json: {}, threw: true };
      return { status: r.status, json: r.json };
    },
  };
}

const MEMBER = {
  membershipId: 'mem-1',
  projectId: 'proj-1',
  role: 'comment',
  canContribute: true,
  state: { active: true, pending: false, declined: false, revoked: false, expired: false },
  actor: { displayName: 'Ada', avatarUrl: null },
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
  acceptedAt: '2026-08-02T00:00:00Z',
  expiresAt: null,
  revision: 'rev-1',
};

const okPage = (items: any[], hasMore = false, nextCursor: string | null = null) => ({
  status: 200,
  json: {
    accountId: 'did:privy:abc123',
    items,
    pageInfo: { limit: 50, hasMore, nextCursor, order: 'updatedAtDesc,idDesc', scope: 'project' },
  },
});

describe('locked action + event vocabulary', () => {
  it('uses exactly the ten server action names', () => {
    // Ten as of the P3-4-CL contract (wavio@6236c390), which added
    // list-project-contributions to the nine from P3-4-ID (wavio@d95683f).
    expect([...Object.values(MULTIPLAYER_ACTIONS)].sort()).toEqual([
      'invite-project-collaborator',
      'list-project-activity',
      'list-project-collaborators',
      'list-project-contributions',
      'publish-project-version',
      'resolve-invite-target',
      'respond-project-contribution',
      'respond-project-invite',
      'revoke-project-collaborator',
      'withdraw-project-contribution',
    ]);
  });

  it('declares the eight-value closed activity vocabulary', () => {
    expect([...ACTIVITY_TYPES]).toEqual([
      'collaborator_invited', 'collaborator_joined', 'collaborator_removed',
      'version_published', 'contribution_submitted', 'contribution_accepted',
      'contribution_rejected', 'contribution_withdrawn',
    ]);
  });

  it('pins the server page-size window', () => {
    expect(DEFAULT_LIST_LIMIT).toBe(50);
    expect(MAX_LIST_LIMIT).toBe(100);
  });

  it('clamps a requested limit into the contract window', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(25)).toBe(25);
    expect(clampLimit(1000)).toBe(100);
    expect(clampLimit(Number.NaN)).toBe(50);
  });
});

describe('HTTP status mapping', () => {
  it('maps each contract status to its own typed reason', () => {
    expect(classifyMultiplayerHttpFailure(401, true)).toBe('unauthorized');
    expect(classifyMultiplayerHttpFailure(403, true)).toBe('forbidden');
    expect(classifyMultiplayerHttpFailure(404, true)).toBe('not-found');
    expect(classifyMultiplayerHttpFailure(409, true)).toBe('conflict');
    expect(classifyMultiplayerHttpFailure(400, true)).toBe('rejected');
    expect(classifyMultiplayerHttpFailure(503, true)).toBe('retryable');
  });

  it('keeps 410 (expired invite) distinct from 409 (state conflict)', () => {
    expect(classifyMultiplayerHttpFailure(410, true)).toBe('invite-expired');
    expect(classifyMultiplayerHttpFailure(410, true)).not.toBe(
      classifyMultiplayerHttpFailure(409, true),
    );
  });

  it('keeps 403 (not permitted) distinct from 401 (not signed in)', () => {
    expect(classifyMultiplayerHttpFailure(403, true)).not.toBe(
      classifyMultiplayerHttpFailure(401, true),
    );
  });

  it('offline wins over any status', () => {
    expect(classifyMultiplayerHttpFailure(403, false)).toBe('offline');
    expect(classifyMultiplayerHttpFailure(200, false)).toBe('offline');
  });
});

describe('parseMembership', () => {
  it('parses the full locked shape', () => {
    const p = parseMembership(MEMBER);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.membershipId).toBe('mem-1');
    expect(p.value.role).toBe('comment');
    expect(p.value.state.active).toBe(true);
    expect(p.value.actor.displayName).toBe('Ada');
    expect(p.value.revision).toBe('rev-1');
  });

  it('carries canContribute SEPARATELY from role — comment alone does not grant it', () => {
    const p = parseMembership({ ...MEMBER, role: 'comment', canContribute: false });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.role).toBe('comment');
    expect(p.value.canContribute).toBe(false);
  });

  it('accepts owner with canContribute true (server-computed)', () => {
    const p = parseMembership({ ...MEMBER, role: 'owner', canContribute: true });
    expect(p.ok && p.value.role).toBe('owner');
  });

  it('rejects the non-existent role "edit"', () => {
    const p = parseMembership({ ...MEMBER, role: 'edit' });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toContain('edit');
  });

  it('fails closed on a missing membershipId', () => {
    expect(parseMembership({ ...MEMBER, membershipId: null }).ok).toBe(false);
  });

  it('fails closed on a non-object', () => {
    expect(parseMembership('nope').ok).toBe(false);
    expect(parseMembership(null).ok).toBe(false);
  });

  it('treats absent state flags as false, never as true', () => {
    const p = parseMembership({ ...MEMBER, state: {} });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.state).toEqual({ active: false, pending: false, declined: false, revoked: false, expired: false });
  });

  it('does not coerce truthy non-booleans into state flags', () => {
    const p = parseMembership({ ...MEMBER, state: { active: 'yes' } });
    expect(p.ok && p.value.state.active).toBe(false);
  });
});

describe('parseActivity', () => {
  const ACT = {
    activityId: 'act-1', projectId: 'proj-1', type: 'version_published',
    actor: { displayName: 'Ada', avatarUrl: null },
    subject: { versionId: 'v-1', contributionId: null, membershipId: null, trackingId: null, commentId: null },
    occurredAt: '2026-08-03T00:00:00Z', revision: 'rev-2',
  };

  it('parses every value of the closed vocabulary', () => {
    for (const type of ACTIVITY_TYPES) {
      expect(parseActivity({ ...ACT, type }).ok).toBe(true);
    }
  });

  it('flags an unknown event type distinctly so it can be dropped', () => {
    const p = parseActivity({ ...ACT, type: 'reaction_added' });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toBe('unknown-activity-type:reaction_added');
  });

  it('carries the subject fields including the always-null commentId', () => {
    const p = parseActivity(ACT);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.subject.versionId).toBe('v-1');
    expect(p.value.subject.commentId).toBeNull();
  });

  it('fails closed on a missing activityId', () => {
    expect(parseActivity({ ...ACT, activityId: '' }).ok).toBe(false);
  });
});

describe('parseContribution', () => {
  const CONTRIB = {
    contributionId: 'c-1', projectId: 'proj-1', parentVersionId: 'v-0', childVersionId: 'v-1',
    state: { submitted: true, accepted: false, rejected: false, withdrawn: false },
    contributorNote: 'first pass', clientCorrelationId: 'corr-1',
    createdAt: '2026-08-04T00:00:00Z', updatedAt: null, reviewedAt: null, withdrawnAt: null, revision: 'rev-3',
  };

  it('parses the full locked shape', () => {
    const p = parseContribution(CONTRIB);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.parentVersionId).toBe('v-0');
    expect(p.value.childVersionId).toBe('v-1');
    expect(p.value.state.submitted).toBe(true);
    expect(p.value.contributorNote).toBe('first pass');
  });

  it('fails closed on a missing contributionId', () => {
    expect(parseContribution({ ...CONTRIB, contributionId: undefined }).ok).toBe(false);
  });

  // P3-4-CL: the server derives these flags from ONE `state` column, so exactly
  // one is always true. Absent or ambiguous state is REJECTED rather than
  // coerced — an "unknown" row silently appearing in an owner's review queue is
  // worse than an honest failure. (Membership state is different: it legitimately
  // has an all-false representation, so parseMembership still coerces.)
  it('rejects a contribution with no state flag set', () => {
    const p = parseContribution({ ...CONTRIB, state: undefined });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toMatch(/exactly one flag/);
  });

  it('rejects an impossible multi-state combination', () => {
    const p = parseContribution({
      ...CONTRIB, state: { submitted: true, accepted: true, rejected: false, withdrawn: false },
    });
    expect(p.ok).toBe(false);
  });

  it('accepts each of the four single-flag states', () => {
    for (const k of ['submitted', 'accepted', 'rejected', 'withdrawn'] as const) {
      const state = { submitted: false, accepted: false, rejected: false, withdrawn: false, [k]: true };
      const p = parseContribution({ ...CONTRIB, state });
      expect(p.ok, k).toBe(true);
      if (p.ok) expect(p.value.state[k], k).toBe(true);
    }
  });
});

describe('paginated listings', () => {
  it('sends the collaborators action with a clamped limit', async () => {
    const deps = fakeDeps([okPage([MEMBER])]);
    const res = await listCollaboratorsAll(deps, { projectId: 'proj-1', limit: 500 });
    expect(res.kind).toBe('ok');
    expect(deps.calls[0].action).toBe('list-project-collaborators');
    expect(deps.calls[0].body).toEqual({ projectId: 'proj-1', limit: 100 });
  });

  it('follows nextCursor until hasMore is false', async () => {
    const deps = fakeDeps([
      okPage([MEMBER], true, 'cur-1'),
      okPage([{ ...MEMBER, membershipId: 'mem-2' }], false, null),
    ]);
    const res = await listCollaboratorsAll(deps, { projectId: 'proj-1' });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.records.map((m) => m.membershipId)).toEqual(['mem-1', 'mem-2']);
    expect(res.pageComplete).toBe(true);
    expect(deps.calls[1].body.cursor).toBe('cur-1');
  });

  it('reports pageComplete false when the server still says hasMore', async () => {
    // hasMore true but no cursor: the server cannot be paged further.
    const deps = fakeDeps([okPage([MEMBER], true, null)]);
    const res = await listCollaboratorsAll(deps, { projectId: 'proj-1' });
    expect(res.kind === 'ok' && res.pageComplete).toBe(false);
  });

  it('drops an unknown activity type instead of failing the feed', async () => {
    const good = {
      activityId: 'a1', projectId: 'p1', type: 'version_published',
      actor: {}, subject: {}, occurredAt: null, revision: null,
    };
    const deps = fakeDeps([okPage([good, { ...good, activityId: 'a2', type: 'reaction_added' }])]);
    const res = await listActivityAll(deps, { projectId: 'p1' });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.records).toHaveLength(1);
    expect(res.droppedUnknown).toBe(1);
  });

  it('fails the collaborator listing on an uninterpretable role rather than omitting a member', async () => {
    const deps = fakeDeps([okPage([{ ...MEMBER, role: 'superuser' }])]);
    const res = await listCollaboratorsAll(deps, { projectId: 'proj-1' });
    expect(res.kind).toBe('failure');
    if (res.kind !== 'failure') return;
    expect(res.reason).toBe('malformed');
  });

  it('fails closed when the response has no accountId', async () => {
    const deps = fakeDeps([{ status: 200, json: { items: [], pageInfo: { hasMore: false } } }]);
    const res = await listCollaboratorsAll(deps, { projectId: 'proj-1' });
    expect(res.kind === 'failure' && res.reason).toBe('malformed');
  });

  it('fails closed when items is not an array', async () => {
    const deps = fakeDeps([{ status: 200, json: { accountId: 'did:privy:x', items: {} } }]);
    const res = await listCollaboratorsAll(deps, { projectId: 'proj-1' });
    expect(res.kind === 'failure' && res.reason).toBe('malformed');
  });

  it('discards a listing whose account changes between pages', async () => {
    const deps = fakeDeps([
      okPage([MEMBER], true, 'cur-1'),
      { status: 200, json: { accountId: 'did:privy:OTHER', items: [], pageInfo: { hasMore: false } } },
    ]);
    const res = await listCollaboratorsAll(deps, { projectId: 'proj-1' });
    expect(res.kind === 'failure' && res.reason).toBe('stale-session');
  });

  it('maps a 403 listing to forbidden, not to an empty success', async () => {
    const deps = fakeDeps([{ status: 403, json: { error: 'Not a project member' } }]);
    const res = await listCollaboratorsAll(deps, { projectId: 'proj-1' });
    expect(res.kind).toBe('failure');
    if (res.kind !== 'failure') return;
    expect(res.reason).toBe('forbidden');
  });

  it('reports offline when the transport throws', async () => {
    const deps = fakeDeps([{ threw: true }]);
    const res = await listActivityAll(deps, { projectId: 'p1' });
    expect(res.kind === 'failure' && res.reason).toBe('offline');
  });
});
