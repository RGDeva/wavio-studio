/**
 * Authoritative Project Link networking + reconciliation — contract tests.
 * Pure: the network is injected as a fake `postDesktop`. Payloads are the exact
 * shapes from the LOCKED Codex contract (wavio @ d34d5218).
 */
import { describe, it, expect } from 'vitest';
import {
  parseItem, classifyHttpFailure, planReconciliation,
  listProjectLinksAll, createProjectLinkFlow, revokeProjectLinkFlow,
  type DesktopResponse, type ProjectLinkServiceDeps, type AuthoritativeItem,
} from './projectLinkService';

const DID = 'did:privy:owner1abc';
const DID_B = 'did:privy:owner2xyz';

/** Exact item shape from the server's mapProjectLinkRow. */
function wireItem(o: Partial<Record<string, any>> = {}) {
  return {
    id: 'project-links-9', trackingId: 't1', publicIdentifier: 't1',
    projectId: 'p1', versionId: 'v1', ownerAccountId: DID,
    createdAt: '2026-07-22T01:10:00.000Z', updatedAt: '2026-07-22T01:10:00.000Z',
    revision: '2026-07-22T01:10:00.000Z', expiresAt: null,
    state: { active: true, revoked: false, expired: false },
    permissions: { allowDownload: true, collaboratorMode: 'view', previewEnabled: true, requiresPassword: false },
    ...o,
  };
}

function ok(json: unknown): DesktopResponse { return { status: 200, json }; }
function deps(over: Partial<ProjectLinkServiceDeps> = {}): ProjectLinkServiceDeps {
  return { postDesktop: async () => ok({}), isOnline: () => true, ...over };
}

describe('parseItem — locked item shape', () => {
  it('maps state booleans → status and fills the record', () => {
    const r = parseItem(wireItem());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item).toMatchObject({ trackingId: 't1', projectId: 'p1', projectVersionId: 'v1', ownerAccountId: DID, status: 'active' });
  });
  it('revoked wins over expired; fail-closed on contradiction/missing', () => {
    expect((parseItem(wireItem({ state: { active: false, revoked: true, expired: true } })) as any).item.status).toBe('revoked');
    expect(parseItem(wireItem({ state: { active: true, revoked: true, expired: false } })).ok).toBe(false);
    expect(parseItem(wireItem({ trackingId: undefined })).ok).toBe(false);
  });
});

describe('classifyHttpFailure — contract status codes', () => {
  it('maps each code; offline overrides', () => {
    expect(classifyHttpFailure(401, true)).toBe('unauthorized');
    expect(classifyHttpFailure(404, true)).toBe('not-found');
    expect(classifyHttpFailure(409, true)).toBe('conflict');
    expect(classifyHttpFailure(400, true)).toBe('rejected');
    expect(classifyHttpFailure(503, true)).toBe('retryable');
    expect(classifyHttpFailure(404, false)).toBe('offline');
  });
});

describe('listProjectLinksAll — pagination + account + fail-closed', () => {
  it('accumulates every page and marks pageComplete only when hasMore=false', async () => {
    const pages = [
      ok({ accountId: DID, items: [wireItem({ trackingId: 'a' })], pageInfo: { hasMore: true, nextCursor: 'c1' } }),
      ok({ accountId: DID, items: [wireItem({ trackingId: 'b' })], pageInfo: { hasMore: false, nextCursor: null } }),
    ];
    let n = 0;
    const r = await listProjectLinksAll(deps({ postDesktop: async () => pages[n++] }));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.accountId).toBe(DID);
      expect(r.records.map((x) => x.trackingId)).toEqual(['a', 'b']);
      expect(r.pageComplete).toBe(true);
    }
  });
  it('a mid-scan HTTP error is a typed failure, not a partial success', async () => {
    const r = await listProjectLinksAll(deps({ postDesktop: async () => ({ status: 401, json: { error: 'Unauthorized' } }) }));
    expect(r.kind).toBe('failure');
    if (r.kind === 'failure') expect(r.reason).toBe('unauthorized');
  });
  it('a thrown fetch → offline; a missing accountId → malformed', async () => {
    expect((await listProjectLinksAll(deps({ postDesktop: async () => ({ status: 0, json: {}, threw: true }), isOnline: () => false }))).kind).toBe('failure');
    const bad = await listProjectLinksAll(deps({ postDesktop: async () => ok({ items: [] }) }));
    expect(bad.kind === 'failure' && bad.reason).toBe('malformed');
  });
});

describe('createProjectLinkFlow — never a fabricated success', () => {
  it('confirmed only with accountId + created + parseable item', async () => {
    const r = await createProjectLinkFlow(deps({ postDesktop: async () => ok({ accountId: DID, created: true, item: wireItem() }) }), { projectId: 'p1' });
    expect(r.kind).toBe('confirmed');
    if (r.kind === 'confirmed') expect(r.accountId).toBe(DID);
  });
  it('404 not-owner / 409 no-version / 400 map to typed failures', async () => {
    for (const [status, reason] of [[404, 'not-found'], [409, 'conflict'], [400, 'rejected']] as const) {
      const r = await createProjectLinkFlow(deps({ postDesktop: async () => ({ status, json: { error: 'x' } }) }), { projectId: 'p1' });
      expect(r.kind === 'failure' && r.reason).toBe(reason);
    }
  });
  it('200 without a created flag is malformed (fail closed)', async () => {
    const r = await createProjectLinkFlow(deps({ postDesktop: async () => ok({ accountId: DID, item: wireItem() }) }), { projectId: 'p1' });
    expect(r.kind === 'failure' && r.reason).toBe('malformed');
  });
});

describe('revokeProjectLinkFlow', () => {
  it('confirmed revoke and idempotent alreadyRevoked', async () => {
    const r1 = await revokeProjectLinkFlow(deps({ postDesktop: async () => ok({ accountId: DID, revoked: true, item: wireItem({ state: { active: false, revoked: true, expired: false } }) }) }), 't1');
    expect(r1.kind === 'confirmed' && r1.alreadyRevoked).toBe(false);
    const r2 = await revokeProjectLinkFlow(deps({ postDesktop: async () => ok({ accountId: DID, alreadyRevoked: true, item: wireItem({ state: { active: false, revoked: true, expired: false } }) }) }), 't1');
    expect(r2.kind === 'confirmed' && r2.alreadyRevoked).toBe(true);
  });
  it('404 not-found fails closed', async () => {
    const r = await revokeProjectLinkFlow(deps({ postDesktop: async () => ({ status: 404, json: { error: 'not found' } }) }), 't1');
    expect(r.kind === 'failure' && r.reason).toBe('not-found');
  });
});

describe('planReconciliation — fail-closed cross-account safety', () => {
  const item = (o: Partial<AuthoritativeItem>): AuthoritativeItem => ({
    linkId: 'L', trackingId: 't1', projectId: 'p1', projectVersionId: 'v1',
    ownerAccountId: DID, status: 'active', expiresAt: null,
    createdAt: '2026-07-22T01:10:00Z', updatedAt: null, permissions: {}, ...o,
  });

  it('applies only records owned by the active account', () => {
    const ops = planReconciliation(DID, [item({}), item({ trackingId: 't2', ownerAccountId: DID_B })], [], false);
    expect(ops.filter((o) => o.op === 'apply').map((o: any) => o.item.trackingId)).toEqual(['t1']);
  });
  it('flags a cached row absent from the authoritative set ONLY when page-complete', () => {
    const cached = [{ tracking_id: 'gone', account_id: DID, revoked_at: null }];
    expect(planReconciliation(DID, [], cached, false).some((o) => o.op === 'reconciliation-needed')).toBe(false);
    expect(planReconciliation(DID, [], cached, true).some((o) => o.op === 'reconciliation-needed')).toBe(true);
  });
  it('never flags another account\'s or a legacy (null) cached row', () => {
    const cached = [
      { tracking_id: 'other', account_id: DID_B, revoked_at: null },
      { tracking_id: 'legacy', account_id: null, revoked_at: null },
    ];
    expect(planReconciliation(DID, [], cached, true).filter((o) => o.op === 'reconciliation-needed')).toHaveLength(0);
  });
  it('does not re-flag an already-revoked cached row', () => {
    const cached = [{ tracking_id: 't1', account_id: DID, revoked_at: '2026-07-22T02:00:00Z' }];
    expect(planReconciliation(DID, [], cached, true).some((o) => o.op === 'reconciliation-needed')).toBe(false);
  });
});
