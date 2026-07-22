import { describe, it, expect } from 'vitest';
import {
  PendingContractAccountResolver, SessionEpoch, isAcceptableCanonicalAccountId,
} from './accountContext';
import { ProjectLinkClient, type LinkClientDeps } from './projectLinkClient';
import { reconcileLink, type AuthoritativeLinkRecord } from './linkReconciliation';
import type { LinkRecord } from './projectLinks';

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';

function rec(o: Partial<LinkRecord> = {}): LinkRecord {
  return {
    tracking_id: 't1', kind: 'project', project_id: 'p1', version_id: 'v1',
    url: 'https://wavi.stream/project-link/t1', created_at: '2026-07-01T00:00:00Z',
    ...o,
  };
}

function auth(o: Partial<AuthoritativeLinkRecord> = {}): AuthoritativeLinkRecord {
  return {
    accountId: ACCOUNT_A, linkId: 'L1', trackingId: 't1', projectId: 'p1',
    projectVersionId: 'v1', status: 'active', permissions: {},
    createdAt: '2026-07-01T00:00:00Z', expiresAt: null, revokedAt: null,
    ...o,
  };
}

/** Client wired to a resolver + shared epoch, over fixed rows. */
function scopedClient(rows: LinkRecord[], deps?: Partial<LinkClientDeps>) {
  const epoch = new SessionEpoch();
  const resolver = new PendingContractAccountResolver(epoch);
  const client = new ProjectLinkClient({
    createProjectLink: async () => ({ trackingId: 'tNew', linkUrl: 'u' }),
    revokeLink: async () => ({ success: true }),
    listLinks: async () => rows,
    isOnline: () => true,
    ...deps,
  });
  client.attachAccountContext(resolver, epoch);
  return { client, resolver, epoch };
}

// Rows: one attributed to A, one to B, one legacy/unattributed.
const ROW_A = rec({ tracking_id: 'tA', account_id: ACCOUNT_A });
const ROW_B = rec({ tracking_id: 'tB', account_id: ACCOUNT_B });
const ROW_LEGACY = rec({ tracking_id: 'tLegacy' }); // account_id undefined

describe('account isolation boundary (P3-2b prep)', () => {
  it('1. account A records are not visible to account B', async () => {
    const { client, resolver } = scopedClient([ROW_A, ROW_B, ROW_LEGACY]);
    resolver.supply(ACCOUNT_B);
    const res = await client.listScoped();
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.views.map((v) => v.record.tracking_id)).toEqual(['tB']);
    }
  });

  it('2. account B cannot revoke account A\'s cached link (fails closed, no server call)', async () => {
    let serverCalled = false;
    const { client, resolver } = scopedClient([ROW_A, ROW_B], {
      revokeLink: async () => { serverCalled = true; return { success: true }; },
    });
    resolver.supply(ACCOUNT_B);
    expect((await client.revokeScoped('tA')).kind).toBe('account-mismatch');
    expect(serverCalled).toBe(false);
    // Owner CAN revoke through the scoped path.
    resolver.onAccountSwitch();
    resolver.supply(ACCOUNT_A);
    expect((await client.revokeScoped('tA')).kind).toBe('confirmed');
  });

  it('3. switching back to A restores only A\'s records', async () => {
    const { client, resolver } = scopedClient([ROW_A, ROW_B, ROW_LEGACY]);
    resolver.supply(ACCOUNT_A);
    let res = await client.listScoped();
    if (res.kind === 'ok') expect(res.views.map((v) => v.record.tracking_id)).toEqual(['tA']);
    resolver.onAccountSwitch(); client.onAccountSwitch();
    resolver.supply(ACCOUNT_B);
    res = await client.listScoped();
    if (res.kind === 'ok') expect(res.views.map((v) => v.record.tracking_id)).toEqual(['tB']);
    resolver.onAccountSwitch(); client.onAccountSwitch();
    resolver.supply(ACCOUNT_A);
    res = await client.listScoped();
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.views.map((v) => v.record.tracking_id)).toEqual(['tA']);
  });

  it('4. logout clears current-account visible state (missing context → fail closed)', async () => {
    const { client, resolver } = scopedClient([ROW_A]);
    resolver.supply(ACCOUNT_A);
    expect((await client.listScoped()).kind).toBe('ok');
    resolver.onLogout(); client.onLogout();
    const res = await client.listScoped();
    expect(res.kind).toBe('missing-account-context');
    if (res.kind === 'missing-account-context') expect(res.reason).toBe('logged-out');
  });

  it('5. confirmed-session ids clear on account switch and on logout', async () => {
    const { client, resolver } = scopedClient([rec({ tracking_id: 'tNew' })]);
    resolver.supply(ACCOUNT_A);
    await client.create({ projectId: 'p1' }); // server returns tNew
    expect(client.confirmedIds().has('tNew')).toBe(true);
    client.onAccountSwitch();
    expect(client.confirmedIds().size).toBe(0);
    await client.create({ projectId: 'p1' });
    expect(client.confirmedIds().size).toBe(1);
    client.onLogout();
    expect(client.confirmedIds().size).toBe(0);
  });

  it('6. a delayed account-A response arriving after switching to B is discarded (stale epoch)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { client, resolver, epoch } = scopedClient([ROW_A], {
      listLinks: async () => { await gate; return [ROW_A]; },
    });
    resolver.supply(ACCOUNT_A);
    const inflight = client.listScoped();      // A's slow request departs…
    epoch.bump();                              // …user switches accounts mid-flight
    resolver.supply(ACCOUNT_B);
    release();
    expect((await inflight).kind).toBe('stale-epoch'); // A's data never surfaces under B
  });

  it('7. offline reads remain account-scoped (no cross-account merge)', async () => {
    const { client, resolver } = scopedClient([ROW_A, ROW_B, ROW_LEGACY], { isOnline: () => false });
    resolver.supply(ACCOUNT_A);
    const res = await client.listScoped();
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.views.map((v) => v.record.tracking_id)).toEqual(['tA']);
      expect(res.views[0].state).toBe('offline'); // honest state, still scoped
    }
  });

  it('8. legacy unattributed rows never appear in any account\'s scoped view', async () => {
    const { client, resolver } = scopedClient([ROW_LEGACY]);
    for (const acct of [ACCOUNT_A, ACCOUNT_B]) {
      resolver.onAccountSwitch();
      resolver.supply(acct);
      const res = await client.listScoped();
      if (res.kind === 'ok') expect(res.views).toHaveLength(0);
    }
    // And they cannot be revoked through the scoped path.
    resolver.supply(ACCOUNT_A);
    expect((await client.revokeScoped('tLegacy')).kind).toBe('account-mismatch');
    // Reconciliation classifies a truly legacy row (no version binding) as ownership-unknown.
    expect(reconcileLink(rec({ version_id: null }), null, ACCOUNT_A).kind).toBe('ownership-unknown');
  });

  it('9. missing account context fails closed for every cache-sensitive operation', async () => {
    const { client } = scopedClient([ROW_A]); // resolver never supplied an id
    expect((await client.listScoped()).kind).toBe('missing-account-context');
    expect((await client.revokeScoped('tA')).kind).toBe('missing-account-context');
    // No resolver attached at all → same fail-closed result.
    const bare = new ProjectLinkClient({
      createProjectLink: async () => ({}), revokeLink: async () => ({}),
      listLinks: async () => [ROW_A], isOnline: () => true,
    });
    expect((await bare.listScoped()).kind).toBe('missing-account-context');
  });

  it('10. no token, secret, email, or path is accepted as an account key', async () => {
    expect(isAcceptableCanonicalAccountId('wv_abc123def456')).toBe(false);       // desktop token
    expect(isAcceptableCanonicalAccountId('a'.repeat(30) + '.' + 'b'.repeat(30) + '.' + 'c'.repeat(30))).toBe(false); // JWT shape
    expect(isAcceptableCanonicalAccountId('user@example.com')).toBe(false);      // email
    expect(isAcceptableCanonicalAccountId('/Users/someone/Library')).toBe(false); // path
    expect(isAcceptableCanonicalAccountId('f'.repeat(65))).toBe(false);          // long hash
    expect(isAcceptableCanonicalAccountId('')).toBe(false);
    expect(isAcceptableCanonicalAccountId(ACCOUNT_A)).toBe(true);                // canonical UUID
    // The resolver rejects them at supply time…
    const resolver = new PendingContractAccountResolver();
    expect(resolver.supply('wv_sneaky_token').kind).toBe('missing-account-context');
    expect(resolver.current().kind).toBe('missing-account-context');
    // …and the client re-checks even if a rogue resolver returns one.
    const { client } = scopedClient([ROW_A]);
    client.attachAccountContext({ current: () => ({ kind: 'available', context: { accountId: 'wv_rogue_token', epoch: 0 } }) });
    expect((await client.listScoped()).kind).toBe('missing-account-context');
  });

  it('11. revoked and expired states remain correct per account after reconciliation', () => {
    const cachedA = rec({ tracking_id: 'tA', account_id: ACCOUNT_A });
    expect(reconcileLink(cachedA, auth({ trackingId: 'tA', status: 'revoked' }), ACCOUNT_A).kind).toBe('revoked');
    expect(reconcileLink(cachedA, auth({ trackingId: 'tA', status: 'expired' }), ACCOUNT_A).kind).toBe('expired');
    expect(reconcileLink(cachedA, auth({ trackingId: 'tA', status: 'active' }), ACCOUNT_A).kind).toBe('server-confirmed');
    // Same record viewed by the wrong account: hidden, status never leaks.
    expect(reconcileLink(cachedA, auth({ trackingId: 'tA', status: 'revoked' }), ACCOUNT_B).kind).toBe('account-mismatch-hidden');
    // Absent from the authoritative response → flagged, not deleted or confirmed.
    expect(reconcileLink(cachedA, null, ACCOUNT_A).kind).toBe('reconciliation-needed');
  });

  it('12. reconciliation cannot attach a link to a different project or version', () => {
    const cached = rec({ tracking_id: 't1', project_id: 'p1', version_id: 'v1' });
    const wrongProject = reconcileLink(cached, auth({ projectId: 'p2' }), ACCOUNT_A);
    expect(wrongProject.kind).toBe('binding-conflict');
    if (wrongProject.kind === 'binding-conflict') expect(wrongProject.detail).toBe('project');
    const wrongVersion = reconcileLink(cached, auth({ projectVersionId: 'v9' }), ACCOUNT_A);
    expect(wrongVersion.kind).toBe('binding-conflict');
    if (wrongVersion.kind === 'binding-conflict') expect(wrongVersion.detail).toBe('version');
    const wrongTracking = reconcileLink(cached, auth({ trackingId: 'tOther' }), ACCOUNT_A);
    expect(wrongTracking.kind).toBe('binding-conflict');
    if (wrongTracking.kind === 'binding-conflict') expect(wrongTracking.detail).toBe('tracking');
  });
});
