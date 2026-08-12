/**
 * P3-4-CL — the authoritative contribution queue.
 *
 * HANDLER-PINNED. Every expectation below is taken from the shipped handler
 * `handleListProjectContributions` in `api/desktop/multiplayer.ts` at
 *
 *     wavio @ 6236c3901966e88bb9a05bef79253463bffa6abd
 *
 * (deployment `dpl_3LaE73wZTRZJxFGS1FA25TqQaASx`), NOT from a prose summary.
 * Two divergences between the written spec and the real handler were found and
 * the handler won in both cases:
 *   · `revision` is `row.updated_at` — a timestamp STRING, not the number `1`;
 *   · the item carries NO contributor identity of any kind.
 */

import { describe, it, expect } from 'vitest';
import {
  listContributionsAll, parseContribution, isContributionStateFilter,
  CONTRIBUTION_STATES, MULTIPLAYER_ACTIONS, DEFAULT_LIST_LIMIT,
  type MultiplayerServiceDeps,
} from './multiplayerService';
import { MultiplayerRefRegistry, toSafeContribution } from './multiplayerRefs';

/** Server SHA this suite is pinned to. */
const PINNED_SERVER_SHA = '6236c3901966e88bb9a05bef79253463bffa6abd';

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

const DID = 'did:privy:owner1';

/** Shaped exactly like the handler's `mapContribution` output. */
function item(id: string, state = 'submitted', extra: Record<string, unknown> = {}) {
  return {
    contributionId: id,
    projectId: 'p1',
    parentVersionId: 'v-parent',
    childVersionId: 'v-child',
    state: {
      submitted: state === 'submitted',
      accepted: state === 'accepted',
      rejected: state === 'rejected',
      withdrawn: state === 'withdrawn',
    },
    contributorNote: null,
    clientCorrelationId: null,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
    reviewedAt: null,
    withdrawnAt: null,
    revision: '2026-08-02T00:00:00Z',   // handler: row.updated_at (string)
    ...extra,
  };
}

const page = (items: any[], hasMore = false, nextCursor: string | null = null) => ({
  status: 200,
  json: {
    accountId: DID,
    items,
    pageInfo: { limit: 50, hasMore, nextCursor, order: 'updatedAtDesc,idDesc', scope: 'project' },
  },
});

describe(`contract (pinned to wavio@${PINNED_SERVER_SHA.slice(0, 7)})`, () => {
  it('uses the exact action name', () => {
    expect(MULTIPLAYER_ACTIONS.listContributions).toBe('list-project-contributions');
  });

  it('sends exactly projectId + limit when no filter is set', async () => {
    const deps = fakeDeps([page([])]);
    await listContributionsAll(deps, { projectId: 'p1' });
    expect(deps.calls[0].action).toBe('list-project-contributions');
    expect(deps.calls[0].body).toEqual({ projectId: 'p1', limit: DEFAULT_LIST_LIMIT });
    // `state` must be OMITTED, not sent as null — the handler treats any
    // present-but-unrecognised value as a 400.
    expect('state' in deps.calls[0].body).toBe(false);
  });

  it('includes state only when filtering', async () => {
    const deps = fakeDeps([page([])]);
    await listContributionsAll(deps, { projectId: 'p1', state: 'submitted' });
    expect(deps.calls[0].body).toEqual({ projectId: 'p1', limit: DEFAULT_LIST_LIMIT, state: 'submitted' });
  });

  it('accepts exactly the four server states as filters', () => {
    expect([...CONTRIBUTION_STATES]).toEqual(['submitted', 'accepted', 'rejected', 'withdrawn']);
    for (const s of CONTRIBUTION_STATES) expect(isContributionStateFilter(s)).toBe(true);
    for (const s of ['pending', 'all', '', null, 7]) expect(isContributionStateFilter(s)).toBe(false);
  });

  it('clamps limit into the contract window', async () => {
    const deps = fakeDeps([page([]), page([])]);
    await listContributionsAll(deps, { projectId: 'p1', limit: 9999 });
    expect(deps.calls[0].body.limit).toBe(100);
  });

  it('passes the opaque cursor straight through — never constructs one', async () => {
    const deps = fakeDeps([page([item('c1')], true, 'OPAQUE-CURSOR'), page([item('c2')])]);
    await listContributionsAll(deps, { projectId: 'p1' });
    expect(deps.calls[1].body.cursor).toBe('OPAQUE-CURSOR');
  });

  it('fails closed on a malformed body', async () => {
    for (const bad of [{ items: [] }, { accountId: DID, items: {} }, { accountId: DID }]) {
      const res = await listContributionsAll(fakeDeps([{ status: 200, json: bad }]), { projectId: 'p1' });
      expect(res.kind).toBe('failure');
    }
  });

  it('the contract item carries NO contributor identity of any kind', () => {
    const p = parseContribution(item('c1'));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const keys = Object.keys(p.value);
    for (const forbidden of ['contributorAccountId', 'contributorDid', 'contributorEmail', 'contributorHandle', 'contributorName', 'avatarUrl', 'membershipId']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('revision is the server timestamp string, not a number', () => {
    const p = parseContribution(item('c1'));
    expect(p.ok && p.value.revision).toBe('2026-08-02T00:00:00Z');
  });
});

describe('state parsing (exactly one flag)', () => {
  for (const s of ['submitted', 'accepted', 'rejected', 'withdrawn'] as const) {
    it(`normalizes ${s}`, () => {
      const p = parseContribution(item('c1', s));
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(p.value.state[s]).toBe(true);
      expect(Object.values(p.value.state).filter(Boolean)).toHaveLength(1);
    });
  }

  it('rejects an impossible multi-state combination', () => {
    const p = parseContribution(item('c1', 'submitted', {
      state: { submitted: true, accepted: true, rejected: false, withdrawn: false },
    }));
    expect(p.ok).toBe(false);
  });

  it('rejects an item with no state set', () => {
    const p = parseContribution(item('c1', 'submitted', {
      state: { submitted: false, accepted: false, rejected: false, withdrawn: false },
    }));
    expect(p.ok).toBe(false);
  });

  it('a malformed row fails the whole listing — never a silently shortened queue', async () => {
    const deps = fakeDeps([page([item('c1'), item('c2', 'submitted', { state: {} })])]);
    const res = await listContributionsAll(deps, { projectId: 'p1' });
    expect(res.kind).toBe('failure');
    if (res.kind !== 'failure') return;
    expect(res.reason).toBe('malformed');
  });
});

describe('authorization + privacy', () => {
  it('normalizes 401 and keeps 403 distinct', async () => {
    const a = await listContributionsAll(fakeDeps([{ status: 401, json: {} }]), { projectId: 'p1' });
    const b = await listContributionsAll(fakeDeps([{ status: 403, json: {} }]), { projectId: 'p1' });
    expect(a.kind === 'failure' && a.reason).toBe('unauthorized');
    expect(b.kind === 'failure' && b.reason).toBe('forbidden');
    expect(a.kind === 'failure' && b.kind === 'failure' && a.reason).not.toBe(b.reason);
  });

  it('a rejected state filter is a 400 → rejected', async () => {
    const res = await listContributionsAll(
      fakeDeps([{ status: 400, json: { error: 'Unsupported contribution state' } }]), { projectId: 'p1' });
    expect(res.kind === 'failure' && res.reason).toBe('rejected');
  });

  it('offline is honest', async () => {
    const res = await listContributionsAll(fakeDeps([{ threw: true }]), { projectId: 'p1' });
    expect(res.kind === 'failure' && res.reason).toBe('offline');
  });

  it('the safe projection strips the canonical id and every identity field', () => {
    const p = parseContribution(item('contrib-SECRET-uuid'));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const view = toSafeContribution('pcontrib_00000001', p.value);
    const json = JSON.stringify(view);
    expect(json).not.toContain('contrib-SECRET-uuid');
    expect(json).not.toContain('did:privy');
    expect(json).not.toMatch(/@|Bearer|authToken|\/Users\//);
    expect(view.ref).toBe('pcontrib_00000001');
  });

  it('the caller accountId is never part of a projected row', () => {
    const p = parseContribution(item('c1'));
    if (!p.ok) return;
    expect(JSON.stringify(toSafeContribution('pcontrib_00000001', p.value))).not.toContain(DID);
  });
});

describe('pagination', () => {
  it('returns the first page and reports completeness honestly', async () => {
    const res = await listContributionsAll(fakeDeps([page([item('c1')], false, null)]), { projectId: 'p1' });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.records).toHaveLength(1);
    expect(res.pageComplete).toBe(true);
  });

  it('follows the cursor and appends in server order without duplicates', async () => {
    const deps = fakeDeps([
      page([item('c1'), item('c2')], true, 'cur-1'),
      page([item('c3')], false, null),
    ]);
    const res = await listContributionsAll(deps, { projectId: 'p1' });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    const ids = res.records.map((c) => c.contributionId);
    expect(ids).toEqual(['c1', 'c2', 'c3']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not claim completeness while the server still says hasMore', async () => {
    const res = await listContributionsAll(fakeDeps([page([item('c1')], true, null)]), { projectId: 'p1' });
    expect(res.kind === 'ok' && res.pageComplete).toBe(false);
  });

  it('discards a listing whose account changes mid-pagination', async () => {
    const deps = fakeDeps([
      page([item('c1')], true, 'cur-1'),
      { status: 200, json: { accountId: 'did:privy:OTHER', items: [], pageInfo: { hasMore: false } } },
    ]);
    const res = await listContributionsAll(deps, { projectId: 'p1' });
    expect(res.kind === 'failure' && res.reason).toBe('stale-session');
  });

  it('a failure on a later page fails the call rather than returning a half-truth', async () => {
    // The caller keeps the page-1 rows it already holds; the adapter does not
    // invent a partial "complete" result.
    const deps = fakeDeps([page([item('c1')], true, 'cur-1'), { status: 500, json: {} }]);
    const res = await listContributionsAll(deps, { projectId: 'p1' });
    expect(res.kind).toBe('failure');
    if (res.kind !== 'failure') return;
    expect(res.reason).toBe('retryable');
  });
});

describe('safe refs for listed contributions', () => {
  const EPOCH = 3;
  function mintFor(id: string) {
    const reg = new MultiplayerRefRegistry();
    const ref = reg.mint({ kind: 'contrib', serverId: id, accountId: DID, projectId: 'p1', epoch: EPOCH });
    return { reg, ref };
  }

  it('every listed row gets an opaque pcontrib ref', () => {
    const { ref } = mintFor('contrib-1');
    expect(ref).toMatch(/^pcontrib_[0-9a-z]{8}$/);
    expect(ref).not.toContain('contrib-1');
  });

  it('a listed ref resolves for review under the same account/project/epoch', () => {
    const { reg, ref } = mintFor('contrib-1');
    const r = reg.resolve(ref, { kind: 'contrib', accountId: DID, epoch: EPOCH, projectId: 'p1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binding.serverId).toBe('contrib-1');
  });

  it('distinct rows get distinct refs', () => {
    const reg = new MultiplayerRefRegistry();
    const a = reg.mint({ kind: 'contrib', serverId: 'c1', accountId: DID, projectId: 'p1', epoch: EPOCH });
    const b = reg.mint({ kind: 'contrib', serverId: 'c2', accountId: DID, projectId: 'p1', epoch: EPOCH });
    expect(a).not.toBe(b);
  });

  it('the same row re-listed reuses its ref (no duplicate handles)', () => {
    const reg = new MultiplayerRefRegistry();
    const a = reg.mint({ kind: 'contrib', serverId: 'c1', accountId: DID, projectId: 'p1', epoch: EPOCH });
    const b = reg.mint({ kind: 'contrib', serverId: 'c1', accountId: DID, projectId: 'p1', epoch: EPOCH });
    expect(a).toBe(b);
    expect(reg.size()).toBe(1);
  });

  it('malformed, cross-project, cross-account and stale refs all fail closed', () => {
    const { reg, ref } = mintFor('contrib-1');
    expect(reg.resolve('nope', { kind: 'contrib', accountId: DID, epoch: EPOCH }).ok).toBe(false);
    expect(reg.resolve(ref, { kind: 'contrib', accountId: DID, epoch: EPOCH, projectId: 'p2' }).ok).toBe(false);
    expect(reg.resolve(ref, { kind: 'contrib', accountId: 'did:privy:other', epoch: EPOCH }).ok).toBe(false);
    expect(reg.resolve(ref, { kind: 'contrib', accountId: DID, epoch: EPOCH + 1 }).ok).toBe(false);
  });

  it('logout invalidates every listed ref', () => {
    const { reg, ref } = mintFor('contrib-1');
    reg.clear();
    expect(reg.resolve(ref, { kind: 'contrib', accountId: DID, epoch: EPOCH }).ok).toBe(false);
  });
});
