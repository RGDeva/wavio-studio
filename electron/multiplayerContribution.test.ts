/**
 * Multiplayer v1 — contribution publishing, operation-key recovery, and review.
 *
 * The operation key is the whole safety story for a non-idempotent submit: it is
 * minted ONCE, retained while the outcome is unknown, and REPLAYED unchanged so
 * the server returns the original child version (`alreadySubmitted: true`)
 * instead of creating a second contribution.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContributionBody, makeOperationKey, ContributionOperationLedger,
  publishContributionFlow, respondContributionFlow, withdrawContributionFlow,
  type MultiplayerServiceDeps,
} from './multiplayerService';

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

const DID = 'did:privy:cmabc123';
const CONTRIB = {
  contributionId: 'c-1', projectId: 'proj-1', parentVersionId: 'v-0', childVersionId: 'v-1',
  state: { submitted: true, accepted: false, rejected: false, withdrawn: false },
  contributorNote: 'first pass', clientCorrelationId: 'corr-1',
  createdAt: null, updatedAt: null, reviewedAt: null, withdrawnAt: null, revision: 'r1',
};

const MANIFEST = {
  projectId: 'proj-1', parentVersionId: 'v-0', daw: 'ableton',
  files: [{ relativePath: 'song.als', fileName: 'song.als' }],
  deviceLabel: 'Wavi Studio — host',
};

const baseOpts = {
  projectId: 'proj-1', parentVersionId: 'v-0',
  operationKey: 'dopk_deadbeef', clientCorrelationId: 'dopk_deadbeef',
  contributorNote: 'first pass', manifest: MANIFEST,
};

describe('buildContributionBody', () => {
  it('adds the contribution fields on top of the existing manifest', () => {
    const body = buildContributionBody(baseOpts);
    expect(body.contribution).toBe(true);
    expect(body.parentVersionId).toBe('v-0');
    expect(body.operationKey).toBe('dopk_deadbeef');
    expect(body.clientCorrelationId).toBe('dopk_deadbeef');
    expect(body.contributorNote).toBe('first pass');
  });

  it('preserves the manifest the existing publish pipeline produced', () => {
    const body = buildContributionBody(baseOpts);
    expect(body.files).toBe(MANIFEST.files);
    expect(body.daw).toBe('ableton');
    expect(body.deviceLabel).toBe('Wavi Studio — host');
  });

  it('NEVER sends sourceRestoreId (a desktop-local row id, not a server identity)', () => {
    const body = buildContributionBody({
      ...baseOpts,
      manifest: { ...MANIFEST, sourceRestoreId: 'local-restore-42' },
    });
    expect('sourceRestoreId' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('local-restore-42');
  });

  it('sends a null contributorNote rather than omitting the field', () => {
    const body = buildContributionBody({ ...baseOpts, contributorNote: undefined });
    expect(body.contributorNote).toBeNull();
  });
});

describe('makeOperationKey', () => {
  const seed = { projectId: 'p', parentVersionId: 'v', localProjectId: 'l', nonce: 'n' };

  it('is deterministic for identical seeds', () => {
    expect(makeOperationKey(seed)).toBe(makeOperationKey({ ...seed }));
  });

  it('differs when any seed component differs', () => {
    expect(makeOperationKey(seed)).not.toBe(makeOperationKey({ ...seed, nonce: 'n2' }));
    expect(makeOperationKey(seed)).not.toBe(makeOperationKey({ ...seed, parentVersionId: 'v2' }));
  });

  it('is opaque — it leaks no seed material', () => {
    const key = makeOperationKey({ projectId: 'secret-project', parentVersionId: 'v', localProjectId: 'l', nonce: 'n' });
    expect(key).toMatch(/^dopk_[0-9a-f]{32}$/);
    expect(key).not.toContain('secret-project');
  });
});

describe('ContributionOperationLedger', () => {
  const seed = { projectId: 'p', parentVersionId: 'v', localProjectId: 'l' };

  it('returns the SAME key on a retry of the same contribution', () => {
    const ledger = new ContributionOperationLedger();
    const first = ledger.acquire(seed);
    const second = ledger.acquire(seed);
    expect(second.operationKey).toBe(first.operationKey);
  });

  it('mints a NEW key once the previous outcome is known and released', () => {
    const ledger = new ContributionOperationLedger();
    const first = ledger.acquire(seed, 1000);
    ledger.release(seed);
    const second = ledger.acquire(seed, 2000);
    expect(second.operationKey).not.toBe(first.operationKey);
  });

  it('keys distinct contributions separately', () => {
    const ledger = new ContributionOperationLedger();
    const a = ledger.acquire(seed);
    const b = ledger.acquire({ ...seed, parentVersionId: 'v2' });
    expect(a.operationKey).not.toBe(b.operationKey);
    expect(ledger.size()).toBe(2);
  });

  it('drops every retained key on logout / account switch', () => {
    const ledger = new ContributionOperationLedger();
    ledger.acquire(seed);
    expect(ledger.size()).toBe(1);
    ledger.clear();
    expect(ledger.size()).toBe(0);
    expect(ledger.peek(seed)).toBeNull();
  });
});

describe('publishContributionFlow', () => {
  it('refuses to submit without a parent version (the server 400s)', async () => {
    const deps = fakeDeps([{ status: 200, json: {} }]);
    const res = await publishContributionFlow(deps, { ...baseOpts, parentVersionId: '' });
    expect(res.kind).toBe('failure');
    expect(deps.calls).toHaveLength(0);
  });

  it('refuses to submit without an operation key rather than risk a duplicate', async () => {
    const deps = fakeDeps([{ status: 200, json: {} }]);
    const res = await publishContributionFlow(deps, { ...baseOpts, operationKey: '' });
    expect(res.kind).toBe('failure');
    if (res.kind !== 'failure') return;
    expect(res.message).toContain('operation key');
    expect(deps.calls).toHaveLength(0);
  });

  it('posts publish-project-version in contribution mode', async () => {
    const deps = fakeDeps([{ status: 200, json: { accountId: DID, published: true, versionId: 'v-1', contribution: CONTRIB } }]);
    const res = await publishContributionFlow(deps, baseOpts);
    expect(deps.calls[0].action).toBe('publish-project-version');
    expect(deps.calls[0].body.contribution).toBe(true);
    expect(res.kind).toBe('published');
    if (res.kind !== 'published') return;
    expect(res.versionId).toBe('v-1');
    expect(res.alreadySubmitted).toBe(false);
  });

  it('surfaces an operation-key replay as alreadySubmitted with the ORIGINAL child version', async () => {
    const deps = fakeDeps([{
      status: 200,
      json: { accountId: DID, published: true, alreadySubmitted: true, versionId: 'v-original', contribution: CONTRIB },
    }]);
    const res = await publishContributionFlow(deps, baseOpts);
    expect(res.kind).toBe('published');
    if (res.kind !== 'published') return;
    expect(res.alreadySubmitted).toBe(true);
    expect(res.versionId).toBe('v-original');
  });

  it('reports outcome-unknown (not offline) when the transport throws', async () => {
    const deps = fakeDeps([{ threw: true }]);
    const res = await publishContributionFlow(deps, baseOpts);
    expect(res.kind).toBe('failure');
    if (res.kind !== 'failure') return;
    expect(res.reason).toBe('contribution-outcome-unknown');
    expect(res.message).toContain('SAME operation key');
  });

  it('a retry after an interrupted submit reuses the key and resolves to the original', async () => {
    const ledger = new ContributionOperationLedger();
    const seed = { projectId: 'proj-1', parentVersionId: 'v-0', localProjectId: 'local-1' };
    const op = ledger.acquire(seed);

    const interrupted = fakeDeps([{ threw: true }]);
    const first = await publishContributionFlow(interrupted, { ...baseOpts, operationKey: op.operationKey });
    expect(first.kind === 'failure' && first.reason).toBe('contribution-outcome-unknown');

    // Outcome unknown → the key is retained, not released.
    const retryOp = ledger.acquire(seed);
    expect(retryOp.operationKey).toBe(op.operationKey);

    const replay = fakeDeps([{
      status: 200,
      json: { accountId: DID, published: true, alreadySubmitted: true, versionId: 'v-original', contribution: CONTRIB },
    }]);
    const second = await publishContributionFlow(replay, { ...baseOpts, operationKey: retryOp.operationKey });
    expect(replay.calls[0].body.operationKey).toBe(op.operationKey);
    expect(second.kind === 'published' && second.alreadySubmitted).toBe(true);
  });

  it('maps a missing parent version (404) to not-found', async () => {
    const deps = fakeDeps([{ status: 404, json: { error: 'Parent version not found' } }]);
    const res = await publishContributionFlow(deps, baseOpts);
    expect(res.kind === 'failure' && res.reason).toBe('not-found');
  });

  it('maps a cross-project parent (409) to conflict', async () => {
    const deps = fakeDeps([{ status: 409, json: {} }]);
    const res = await publishContributionFlow(deps, baseOpts);
    expect(res.kind === 'failure' && res.reason).toBe('conflict');
  });

  it('maps a contributor without contribute rights (403) to forbidden', async () => {
    const deps = fakeDeps([{ status: 403, json: {} }]);
    const res = await publishContributionFlow(deps, baseOpts);
    expect(res.kind === 'failure' && res.reason).toBe('forbidden');
  });

  it('never fabricates success from a 200 without published:true', async () => {
    const deps = fakeDeps([{ status: 200, json: { accountId: DID, versionId: 'v-1' } }]);
    const res = await publishContributionFlow(deps, baseOpts);
    expect(res.kind === 'failure' && res.reason).toBe('malformed');
  });

  it('refuses a published response with no versionId', async () => {
    const deps = fakeDeps([{ status: 200, json: { accountId: DID, published: true } }]);
    const res = await publishContributionFlow(deps, baseOpts);
    expect(res.kind === 'failure' && res.reason).toBe('malformed');
  });

  it('accepts a published response with no contribution object (plain owner publish shape)', async () => {
    const deps = fakeDeps([{ status: 200, json: { accountId: DID, published: true, versionId: 'v-9' } }]);
    const res = await publishContributionFlow(deps, baseOpts);
    expect(res.kind).toBe('published');
    if (res.kind !== 'published') return;
    expect(res.contribution).toBeNull();
  });
});

describe('contribution review + withdrawal', () => {
  it('accepts a submitted contribution', async () => {
    const deps = fakeDeps([{ status: 200, json: { accountId: DID, accepted: true, item: { ...CONTRIB, state: { submitted: false, accepted: true, rejected: false, withdrawn: false } } } }]);
    const res = await respondContributionFlow(deps, { contributionId: 'c-1', accept: true });
    expect(deps.calls[0].action).toBe('respond-project-contribution');
    expect(res.kind).toBe('confirmed');
    if (res.kind !== 'confirmed') return;
    expect(res.contribution.state.accepted).toBe(true);
    expect(res.alreadyResolved).toBe(false);
  });

  it('preserves alreadyAccepted / alreadyRejected as idempotent echoes', async () => {
    const deps = fakeDeps([{ status: 200, json: { accountId: DID, alreadyRejected: true, item: CONTRIB } }]);
    const res = await respondContributionFlow(deps, { contributionId: 'c-1', accept: false });
    expect(res.kind === 'confirmed' && res.alreadyResolved).toBe(true);
  });

  it('maps a non-owner review (403) to forbidden', async () => {
    const deps = fakeDeps([{ status: 403, json: {} }]);
    const res = await respondContributionFlow(deps, { contributionId: 'c-1', accept: true });
    expect(res.kind === 'failure' && res.reason).toBe('forbidden');
  });

  it('maps reviewing a non-submitted contribution (409) to conflict', async () => {
    const deps = fakeDeps([{ status: 409, json: {} }]);
    const res = await respondContributionFlow(deps, { contributionId: 'c-1', accept: true });
    expect(res.kind === 'failure' && res.reason).toBe('conflict');
  });

  it('withdraws the contributor\'s own submission', async () => {
    const deps = fakeDeps([{ status: 200, json: { accountId: DID, withdrawn: true, item: CONTRIB } }]);
    const res = await withdrawContributionFlow(deps, { contributionId: 'c-1' });
    expect(deps.calls[0].action).toBe('withdraw-project-contribution');
    expect(res.kind).toBe('confirmed');
  });

  it('preserves alreadyWithdrawn as an idempotent echo', async () => {
    const deps = fakeDeps([{ status: 200, json: { accountId: DID, alreadyWithdrawn: true, item: CONTRIB } }]);
    const res = await withdrawContributionFlow(deps, { contributionId: 'c-1' });
    expect(res.kind === 'confirmed' && res.alreadyResolved).toBe(true);
  });

  it('maps a non-contributor withdrawal (403) to forbidden', async () => {
    const deps = fakeDeps([{ status: 403, json: {} }]);
    const res = await withdrawContributionFlow(deps, { contributionId: 'c-1' });
    expect(res.kind === 'failure' && res.reason).toBe('forbidden');
  });

  it('refuses a 200 with no confirmation flag', async () => {
    const deps = fakeDeps([{ status: 200, json: { accountId: DID, item: CONTRIB } }]);
    const res = await withdrawContributionFlow(deps, { contributionId: 'c-1' });
    expect(res.kind === 'failure' && res.reason).toBe('malformed');
  });
});
