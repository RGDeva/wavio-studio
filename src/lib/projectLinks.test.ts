import { describe, it, expect } from 'vitest';
import {
  deriveLinkState, linkGroupForState, normalizeLinkResult, isPermissionSupported,
  LINK_STATE_PRESENTATION, LINK_GROUP_META, LINK_GROUP_ORDER,
  type LinkRecord, type LinkState, type LinkGroup,
} from './projectLinks';
import { ProjectLinkClient } from './projectLinkClient';

const ALL_STATES: LinkState[] = [
  'server-confirmed', 'cached', 'reconciliation-needed', 'offline', 'failed',
  'revoked', 'expired', 'permission-denied', 'legacy-local-only', 'unsupported-contract',
];

function rec(o: Partial<LinkRecord> = {}): LinkRecord {
  return {
    tracking_id: 't1', kind: 'project', project_id: 'p1', version_id: 'v1',
    url: 'https://wavi.stream/project-link/t1', created_at: '2026-07-01T00:00:00Z',
    ...o,
  };
}
const NOW = new Date('2026-07-09T00:00:00Z');

describe('deriveLinkState — honest states', () => {
  it('revoked and expired take precedence', () => {
    expect(deriveLinkState(rec({ revoked_at: '2026-07-08T00:00:00Z' }), { online: true, now: NOW })).toBe('revoked');
    expect(deriveLinkState(rec({ expires_at: '2026-07-01T00:00:00Z' }), { online: true, now: NOW })).toBe('expired');
  });
  it('a link is server-confirmed ONLY when confirmed this session', () => {
    expect(deriveLinkState(rec(), { online: true, now: NOW })).toBe('cached'); // not confirmed
    expect(deriveLinkState(rec(), { online: true, now: NOW, confirmedThisSession: new Set(['t1']) })).toBe('server-confirmed');
  });
  it('offline cached record → offline', () => {
    expect(deriveLinkState(rec(), { online: false, now: NOW })).toBe('offline');
  });
  it('project link without a version id is legacy-local-only', () => {
    expect(deriveLinkState(rec({ version_id: null }), { online: true, now: NOW })).toBe('legacy-local-only');
    expect(deriveLinkState(rec({ kind: 'listen', version_id: null }), { online: true, now: NOW })).toBe('legacy-local-only');
  });
  it('reconcile requested → reconciliation-needed', () => {
    expect(deriveLinkState(rec(), { online: true, now: NOW, reconcileRequested: new Set(['t1']) })).toBe('reconciliation-needed');
  });
  it('groups map correctly', () => {
    expect(linkGroupForState('server-confirmed')).toBe('active');
    expect(linkGroupForState('cached')).toBe('active');
    expect(linkGroupForState('expired')).toBe('expired');
    expect(linkGroupForState('revoked')).toBe('revoked');
    expect(linkGroupForState('offline')).toBe('needs-attention');
    expect(linkGroupForState('legacy-local-only')).toBe('needs-attention');
  });
});

describe('normalizeLinkResult — typed outcomes, fail closed', () => {
  it('confirmed only with a trackingId (create) or success (revoke)', () => {
    expect(normalizeLinkResult({ trackingId: 't1', linkUrl: 'u' }, true)).toEqual({ kind: 'confirmed', trackingId: 't1', url: 'u' });
    expect(normalizeLinkResult({ success: true }, true).kind).toBe('confirmed');
  });
  it('missing confirmation is malformed (fail closed), not success', () => {
    expect(normalizeLinkResult({}, true).kind).toBe('malformed');
  });
  it('offline throw / offline flag → offline (never success)', () => {
    expect(normalizeLinkResult(new Error('fetch failed'), true).kind).toBe('offline');
    expect(normalizeLinkResult({ error: 'anything' }, false).kind).toBe('offline');
  });
  it('classifies server errors', () => {
    expect(normalizeLinkResult({ error: 'Not authenticated' }, true).kind).toBe('unauthorized');
    expect(normalizeLinkResult({ error: 'HTTP 403 forbidden' }, true).kind).toBe('rejected');
    expect(normalizeLinkResult({ error: 'HTTP 503' }, true).kind).toBe('retryable');
    expect(normalizeLinkResult({ error: 'not implemented' }, true).kind).toBe('unsupported');
  });
});

describe('permission support detection', () => {
  it('only verified permissions are supported', () => {
    expect(isPermissionSupported('download')).toBe(true);
    expect(isPermissionSupported('collaborator_mode')).toBe(true);
    expect(isPermissionSupported('download-project-pack')).toBe(false);
    expect(isPermissionSupported('contribute')).toBe(false);
  });
});

describe('presentation model — every state is honestly labelled', () => {
  it('presentation covers every LinkState with a non-empty note', () => {
    for (const s of ALL_STATES) {
      const p = LINK_STATE_PRESENTATION[s];
      expect(p, `missing presentation for ${s}`).toBeTruthy();
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.note.length).toBeGreaterThan(0);
    }
  });
  it('only server-confirmed uses the success tone (cached is not "confirmed")', () => {
    expect(LINK_STATE_PRESENTATION['server-confirmed'].tone).toBe('success');
    expect(LINK_STATE_PRESENTATION['cached'].tone).not.toBe('success');
    expect(LINK_STATE_PRESENTATION['cached'].label.toLowerCase()).not.toContain('confirmed');
  });
  it('every state maps to a group that has meta, and the order lists each group once', () => {
    for (const s of ALL_STATES) {
      const g: LinkGroup = linkGroupForState(s);
      expect(LINK_GROUP_META[g]).toBeTruthy();
      expect(LINK_GROUP_ORDER).toContain(g);
    }
    expect(new Set(LINK_GROUP_ORDER).size).toBe(LINK_GROUP_ORDER.length);
  });
});

describe('ProjectLinkClient', () => {
  const online = { v: true };
  function mk(over: Partial<Parameters<typeof makeDeps>[0]> = {}) {
    return new ProjectLinkClient(makeDeps({ ...over }));
  }
  function makeDeps(o: {
    create?: (opts: any) => Promise<unknown>;
    revoke?: (opts: any) => Promise<unknown>;
    list?: () => Promise<LinkRecord[]>;
  }) {
    return {
      createProjectLink: o.create ?? (async () => ({ trackingId: 'tNew', linkUrl: 'u' })),
      revokeLink: o.revoke ?? (async () => ({ success: true })),
      listLinks: o.list ?? (async () => [rec()]),
      isOnline: () => online.v,
    };
  }

  it('server success required before a link is server-confirmed in the list', async () => {
    online.v = true;
    const c = mk({ list: async () => [rec({ tracking_id: 'tNew', version_id: 'v1' })] });
    // Before create: cached (not confirmed)
    expect((await c.list())[0].state).toBe('cached');
    await c.create({ projectId: 'p1' }); // returns trackingId 'tNew'
    // After a server-confirmed create this session → server-confirmed
    expect((await c.list())[0].state).toBe('server-confirmed');
  });

  it('offline create does not return success', async () => {
    online.v = false;
    const c = mk({ create: async () => { throw new Error('fetch failed'); } });
    expect((await c.create({ projectId: 'p1' })).kind).toBe('offline');
    online.v = true;
  });

  it('account switch clears session-confirmed (cached record no longer shows confirmed)', async () => {
    online.v = true;
    const c = mk({ list: async () => [rec({ tracking_id: 'tNew' })] });
    await c.create({ projectId: 'p1' });
    expect((await c.list())[0].state).toBe('server-confirmed');
    c.setAccount('account-B'); // switch
    expect((await c.list())[0].state).toBe('cached'); // no longer confirmed for the new account
  });

  it('list filters by project and version (stale response cannot cross projects)', async () => {
    const c = mk({ list: async () => [rec({ project_id: 'p1', version_id: 'v1' }), rec({ tracking_id: 't2', project_id: 'p2', version_id: 'v9' })] });
    const p1 = await c.list({ projectId: 'p1' });
    expect(p1.map((v) => v.record.project_id)).toEqual(['p1']);
    const v1 = await c.list({ projectId: 'p1', versionId: 'v1' });
    expect(v1).toHaveLength(1);
    expect(await c.list({ projectId: 'p1', versionId: 'vX' })).toHaveLength(0);
  });

  it('revoke requires server confirmation; malformed fails closed', async () => {
    const ok = mk({ revoke: async () => ({ success: true }) });
    expect((await ok.revoke('t1')).kind).toBe('confirmed');
    const bad = mk({ revoke: async () => ({}) });
    expect((await bad.revoke('t1')).kind).toBe('malformed');
    const denied = mk({ revoke: async () => ({ error: 'Not authenticated' }) });
    expect((await denied.revoke('t1')).kind).toBe('unauthorized');
  });

  it('reconciliation is honestly unavailable (no server list contract)', () => {
    expect(mk().reconciliationAvailable()).toBe(false);
  });

  it('confirmedIds exposes the session-confirmed set and clears on account switch', async () => {
    online.v = true;
    const c = mk();
    expect(c.confirmedIds().size).toBe(0);
    await c.create({ projectId: 'p1' }); // returns trackingId 'tNew'
    expect(c.confirmedIds().has('tNew')).toBe(true);
    c.setAccount('account-B');
    expect(c.confirmedIds().size).toBe(0);
  });
});
