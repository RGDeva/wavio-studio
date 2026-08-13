/**
 * Guards for the dev-only authenticated staging smoke.
 *
 * The harness itself can only be proven by running it against staging, but its
 * SAFETY properties must be provable offline: it must be production-inert, it
 * must drive the real adapter rather than a parallel request builder, and its
 * evidence file must never contain a secret.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  runStagingSmoke, assertNoSecrets, privacyAssertions, SMOKE_SERVER_CONTRACT,
  type SmokeDeps,
} from './stagingSmoke';
import { MULTIPLAYER_ACTIONS } from './multiplayerService';

function deps(
  handler: (action: string, body: any) => { status: number; json: any },
  over: Partial<SmokeDeps> = {},
): SmokeDeps & { calls: Array<{ action: string; body: any }> } {
  const calls: Array<{ action: string; body: any }> = [];
  return {
    calls,
    projectId: 'proj-1',
    resolveIdentifier: null,
    apiBase: 'https://wavi-staging-kvbq16xd5-rgdevas-projects.vercel.app/api',
    isOnline: () => true,
    postDesktop: async (action, body) => { calls.push({ action, body }); return handler(action, body); },
    ...over,
  } as any;
}

const emptyPage = {
  status: 200,
  json: { accountId: 'did:privy:owner', items: [], pageInfo: { hasMore: false, nextCursor: null } },
};

describe('production inertness', () => {
  const main = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');

  it('is gated on BOTH the opt-in flag and a non-production API base', () => {
    expect(main).toContain("process.env.WAVI_SMOKE === '1'");
    expect(main).toContain('if (!IS_DEV_API)');
    expect(main).toMatch(/REFUSING to run: API base is production/);
  });

  it('the refusal happens before any smoke work is started', () => {
    const block = main.slice(main.indexOf("process.env.WAVI_SMOKE === '1'"));
    const refuseAt = block.indexOf('REFUSING');
    const startAt = block.indexOf('startStagingSmoke()');
    expect(refuseAt).toBeGreaterThan(-1);
    expect(refuseAt).toBeLessThan(startAt);
  });
});

describe('drives the real adapter, not a parallel implementation', () => {
  it('performs no networking of its own', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'stagingSmoke.ts'), 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toContain('Authorization');
    expect(src).not.toContain('X-Desktop-Action');
  });

  it('calls the locked action names via the shared flows', async () => {
    const d = deps(() => emptyPage);
    await runStagingSmoke(d, 'owner');
    const actions = [...new Set(d.calls.map((c) => c.action))];
    expect(actions).toContain(MULTIPLAYER_ACTIONS.listCollaborators);
    expect(actions).toContain(MULTIPLAYER_ACTIONS.listActivity);
    expect(actions).toContain(MULTIPLAYER_ACTIONS.listContributions);
  });

  it('exercises the unfiltered queue with state ABSENT, then each filter', async () => {
    const d = deps(() => emptyPage);
    await runStagingSmoke(d, 'owner');
    const queue = d.calls.filter((c) => c.action === MULTIPLAYER_ACTIONS.listContributions);
    expect(queue).toHaveLength(5);                       // all + 4 states
    expect('state' in queue[0].body).toBe(false);        // unfiltered omits it
    expect(queue.slice(1).map((c) => c.body.state)).toEqual(
      ['submitted', 'accepted', 'rejected', 'withdrawn']);
  });

  it('runs NO mutation, and says so explicitly', async () => {
    const d = deps(() => emptyPage);
    const r = await runStagingSmoke(d, 'owner');
    const mutations = [
      MULTIPLAYER_ACTIONS.invite, MULTIPLAYER_ACTIONS.respondInvite,
      MULTIPLAYER_ACTIONS.revokeCollaborator, MULTIPLAYER_ACTIONS.publishVersion,
      MULTIPLAYER_ACTIONS.respondContribution, MULTIPLAYER_ACTIONS.withdrawContribution,
    ];
    for (const m of mutations) expect(d.calls.map((c) => c.action)).not.toContain(m);
    expect(r.notRun.join(' ')).toMatch(/mutation/);
  });

  it('skips the rate-limited lookup unless an identifier is supplied', async () => {
    const d = deps(() => emptyPage);
    const r = await runStagingSmoke(d, 'owner');
    expect(d.calls.map((c) => c.action)).not.toContain(MULTIPLAYER_ACTIONS.resolveInviteTarget);
    const step = r.steps.find((s) => s.step === 'resolve-invite-target')!;
    expect(step.outcome).toBe('skipped');
    expect(step.reason).toMatch(/rate-limited/);
  });
});

describe('honest outcomes', () => {
  it('a real failure is never reported as a pass', async () => {
    const r = await runStagingSmoke(deps(() => ({ status: 500, json: {} })), 'owner');
    expect(r.pass).toBe(false);
    expect(r.steps.some((s) => s.outcome === 'unexpected-failure')).toBe(true);
  });

  it('a foreign account EXPECTS 403 and treats anything else as a failure', async () => {
    const forbidden = await runStagingSmoke(deps(() => ({ status: 403, json: {} })), 'foreign');
    expect(forbidden.pass).toBe(true);
    expect(forbidden.steps.every((s) => s.outcome !== 'unexpected-failure')).toBe(true);

    // A foreign account that somehow SUCCEEDS is a security finding, not a pass.
    const leaked = await runStagingSmoke(deps(() => emptyPage), 'foreign');
    expect(leaked.pass).toBe(false);
  });

  it('records which perspective ran and what it could not cover', async () => {
    const r = await runStagingSmoke(deps(() => emptyPage), 'owner');
    expect(r.role).toBe('owner');
    expect(r.notRun.join(' ')).toMatch(/collaborator-visibility/);
    expect(r.notRun.join(' ')).toMatch(/foreign-account 403/);
    expect(r.serverContract).toBe(SMOKE_SERVER_CONTRACT);
  });
});

describe('evidence carries no secrets', () => {
  it('assertNoSecrets catches every forbidden shape', () => {
    expect(assertNoSecrets('clean evidence')).toBe(true);
    for (const bad of ['did:privy:abc', 'invt_xyz', 'wv_abc123', 'Bearer tok', 'eyJhbGciOiJIUzI1NiJ9']) {
      expect(assertNoSecrets(bad), bad).toBe(false);
    }
  });

  it('privacyAssertions flags a leaking payload and passes a clean one', () => {
    expect(privacyAssertions({ ref: 'pcontrib_1', state: 'submitted' })).toEqual({
      noCanonicalDid: true, noInviteCapability: true, noBearerOrToken: true, noAbsolutePath: true,
    });
    const leak = privacyAssertions({ who: 'did:privy:x', cap: 'invt_y', p: '/Users/me/a.als' });
    expect(leak.noCanonicalDid).toBe(false);
    expect(leak.noInviteCapability).toBe(false);
    expect(leak.noAbsolutePath).toBe(false);
  });

  it('a full report from a realistic response contains no secret material', async () => {
    const withRows = {
      status: 200,
      json: {
        accountId: 'did:privy:owner-SECRET',
        items: [{
          contributionId: 'contrib-SECRET', projectId: 'proj-1',
          parentVersionId: 'v0', childVersionId: 'v1',
          state: { submitted: true, accepted: false, rejected: false, withdrawn: false },
          contributorNote: null, clientCorrelationId: null,
          createdAt: null, updatedAt: null, reviewedAt: null, withdrawnAt: null, revision: 'r',
        }],
        pageInfo: { hasMore: false, nextCursor: null },
      },
    };
    const r = await runStagingSmoke(deps(() => withRows), 'owner');
    const blob = JSON.stringify(r);
    expect(assertNoSecrets(blob)).toBe(true);
    expect(blob).not.toContain('contrib-SECRET');
    expect(blob).not.toContain('owner-SECRET');
  });
});
