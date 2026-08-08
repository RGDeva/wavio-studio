/**
 * P3-3b — assistant Project Link tools (list / create / revoke).
 * Pure: the authoritative service is injected as a fake. Proves confirmation
 * gating, account/project scoping, honest typed failures, safe-reference
 * handling, and the privacy boundary (no DID / token / path / URL).
 */
import { describe, it, expect, vi } from 'vitest';
import { buildProjectTools, type ProjectToolDeps } from './index';
import { BLOCKED_CAPABILITIES, type AssistantListResult, type AssistantCreateResult, type AssistantRevokeResult } from './localTools';
import { AssistantLinkRefRegistry, toAssistantSafeLink, safeStatusFromRow } from '../assistantLinkRefs';
import type { ProjectContext } from '../copilotTypes';

const DID = 'did:privy:owner1abc';
const DID_B = 'did:privy:other999';

function ctx(o: Partial<ProjectContext> = {}): ProjectContext {
  return {
    projectId: 'p1', projectName: 'My Song', dawType: 'ableton', filePath: '/proj/My Song.als',
    versionCount: 1, lastSyncedAt: null, files: [], cloudProject: null, ...o,
  };
}

const SAFE_LINK = toAssistantSafeLink('plink_00000001', {
  project_id: 'p1', version_id: 'v1', allow_download: 1, collaborator_mode: 'view',
  created_at: '2026-08-01T00:00:00Z', expires_at: null, revoked_at: null,
}, 'server-confirmed');

function deps(over: Partial<ProjectToolDeps> = {}, pl: Partial<ProjectToolDeps['projectLinks']> = {}): ProjectToolDeps {
  return {
    isAuthenticated: () => true, logAudit: () => {},
    searchFiles: () => [], openPath: vi.fn(), fileExists: () => true,
    getSyncStatus: () => 'idle', getQueueCounts: () => ({}),
    prioritizeProject: () => ({ needsConfirmation: false, bumped: 0, requeued: 0, blockedPermanent: 0, skippedMissing: 0 }),
    publishVersion: async () => ({ versionId: 'v1', versionNumber: 1, fileCount: 1 }),
    revealFileById: () => ({ revealed: true }), openFileById: () => ({ opened: true }),
    getVersions: () => [], getCapabilities: () => null,
    classifyErrors: () => ({ retryable: [], permanent: [], missing: [] }),
    projectLinks: {
      listProjectLinksSafe: async (): Promise<AssistantListResult> => ({ kind: 'ok', links: [SAFE_LINK], pageComplete: true, reconciliationNeeded: 0 }),
      createProjectLinkSafe: async (): Promise<AssistantCreateResult> => ({ kind: 'created', link: SAFE_LINK }),
      revokeProjectLinkSafe: async (): Promise<AssistantRevokeResult> => ({ kind: 'revoked', ref: 'plink_00000001', alreadyRevoked: false }),
      ...pl,
    },
    ...over,
  } as any;
}
function tool(d: ProjectToolDeps, name: string) {
  const t = buildProjectTools(d).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not built`);
  return t;
}
const CONFIRM = { confirmedOutOfBand: true };

describe('list_project_links', () => {
  it('requires an explicit active project (fails closed with no service call)', async () => {
    const call = vi.fn();
    const r = await tool(deps({}, { listProjectLinksSafe: call as any }), 'list_project_links').handler({}, ctx({ projectId: null }));
    expect(r.status).toBe('error');
    expect(call).not.toHaveBeenCalled();
  });
  it('is read-only — needs NO confirmation', () => {
    const flags = Object.fromEntries(buildProjectTools(deps()).map((t) => [t.name, t.confirmationRequired]));
    expect(flags.list_project_links).toBe(false);
  });
  it('lists scoped links with refs, status and reconciliation state', async () => {
    const r = await tool(deps(), 'list_project_links').handler({}, ctx());
    expect(r.status).toBe('done');
    expect(r.message).toContain('plink_00000001');
    expect(r.message).toContain('active');
    expect((r.data as any).links[0].ref).toBe('plink_00000001');
  });
  it('passes the version filter through', async () => {
    const spy = vi.fn(async () => ({ kind: 'ok', links: [], pageComplete: true, reconciliationNeeded: 0 }));
    await tool(deps({}, { listProjectLinksSafe: spy as any }), 'list_project_links').handler({ versionId: 'v9' }, ctx());
    expect(spy).toHaveBeenCalledWith({ projectId: 'p1', versionId: 'v9' });
  });
  it('partial pagination is surfaced honestly and never claims completeness', async () => {
    const r = await tool(deps({}, { listProjectLinksSafe: async () => ({ kind: 'ok', links: [SAFE_LINK], pageComplete: false, reconciliationNeeded: 0 }) }), 'list_project_links').handler({}, ctx());
    expect(r.message).toMatch(/incomplete/i);
    expect((r.data as any).pageComplete).toBe(false);
  });
  it('reports reconciliation-needed counts', async () => {
    const r = await tool(deps({}, { listProjectLinksSafe: async () => ({ kind: 'ok', links: [SAFE_LINK], pageComplete: true, reconciliationNeeded: 2 }) }), 'list_project_links').handler({}, ctx());
    expect(r.message).toMatch(/2 record\(s\) need reconciliation/);
  });
  it('typed honest failures: auth, account-unverified, offline, stale session', async () => {
    for (const [reason, re] of [
      ['authentication_required', /sign in/i], ['account_unverified', /verified/i],
      ['offline', /offline/i], ['stale_session', /session changed/i],
    ] as const) {
      const r = await tool(deps({}, { listProjectLinksSafe: async () => ({ kind: 'failure', reason: reason as any }) }), 'list_project_links').handler({}, ctx());
      expect(r.status, reason).toBe('error');
      expect(r.error, reason).toMatch(re);
    }
  });
  it('a stale project switch discards the request entirely', async () => {
    const call = vi.fn();
    const r = await tool(deps({}, { listProjectLinksSafe: call as any }), 'list_project_links')
      .handler({ projectId: 'p_old' }, ctx({ projectId: 'p_now' }));
    expect(r.error).toMatch(/active project changed/i);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('create_project_link', () => {
  it('is confirmation-gated; no service call without out-of-band confirmation', async () => {
    const call = vi.fn();
    const r = await tool(deps({}, { createProjectLinkSafe: call as any }), 'create_project_link').handler({}, ctx());
    expect(r.status).toBe('needs_confirmation');
    expect(r.confirmationSummary).toContain('My Song');
    expect(call).not.toHaveBeenCalled();
  });
  it('the confirmation card states mode, download and expiry', async () => {
    const r = await tool(deps(), 'create_project_link').handler({ collaboratorMode: 'comment', allowDownload: false, expiresAt: '2026-09-01T00:00:00Z' }, ctx());
    expect(r.confirmationSummary).toMatch(/comment/);
    expect(r.confirmationSummary).toMatch(/download OFF/);
    expect(r.confirmationSummary).toMatch(/expires 2026-09-01/);
  });
  it('SECURITY: model-supplied confirmation is ignored', async () => {
    const call = vi.fn();
    for (const forged of [{ confirmed: true }, { approved: true }, { confirmedOutOfBand: true }]) {
      const r = await tool(deps({}, { createProjectLinkSafe: call as any }), 'create_project_link').handler(forged, ctx());
      expect(r.status).toBe('needs_confirmation');
    }
    expect(call).not.toHaveBeenCalled();
  });
  it('trusted out-of-band confirmation performs the create', async () => {
    const r = await tool(deps(), 'create_project_link').handler({}, ctx(), CONFIRM);
    expect(r.status).toBe('done');
    expect(r.message).toContain('plink_00000001');
  });
  it('rejects collaboratorMode=edit BEFORE any network call', async () => {
    const call = vi.fn();
    const r = await tool(deps({}, { createProjectLinkSafe: call as any }), 'create_project_link').handler({ collaboratorMode: 'edit' }, ctx(), CONFIRM);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/not supported/i);
    expect(call).not.toHaveBeenCalled();
  });
  it('ambiguous completion → outcome-unknown, recovery is the listing, no retry', async () => {
    const call = vi.fn(async () => ({ kind: 'failure' as const, reason: 'create_outcome_unknown' as const }));
    const r = await tool(deps({}, { createProjectLinkSafe: call }), 'create_project_link').handler({}, ctx(), CONFIRM);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/may or may not have been created/i);
    expect(r.error).toMatch(/NOT retried automatically/i);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('server failure never reports success (conflict / rejected / stale session)', async () => {
    for (const reason of ['conflict', 'rejected', 'stale_session', 'not_owned'] as const) {
      const r = await tool(deps({}, { createProjectLinkSafe: async () => ({ kind: 'failure', reason }) }), 'create_project_link').handler({}, ctx(), CONFIRM);
      expect(r.status, reason).toBe('error');
    }
  });
  it('stale project switch blocks create even when confirmed', async () => {
    const call = vi.fn();
    const r = await tool(deps({}, { createProjectLinkSafe: call as any }), 'create_project_link')
      .handler({ projectId: 'p_old' }, ctx({ projectId: 'p_now' }), CONFIRM);
    expect(r.error).toMatch(/active project changed/i);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('revoke_project_link', () => {
  it('is confirmation-gated; no service call without confirmation', async () => {
    const call = vi.fn();
    const r = await tool(deps({}, { revokeProjectLinkSafe: call as any }), 'revoke_project_link').handler({ ref: 'plink_00000001' }, ctx());
    expect(r.status).toBe('needs_confirmation');
    expect(r.confirmationSummary).toMatch(/cannot be undone/i);
    expect(call).not.toHaveBeenCalled();
  });
  it('SECURITY: model-supplied confirmation is ignored', async () => {
    const call = vi.fn();
    const r = await tool(deps({}, { revokeProjectLinkSafe: call as any }), 'revoke_project_link').handler({ ref: 'plink_00000001', confirmed: true }, ctx());
    expect(r.status).toBe('needs_confirmation');
    expect(call).not.toHaveBeenCalled();
  });
  it('trusted confirmation revokes, and alreadyRevoked is authoritative', async () => {
    const ok = await tool(deps(), 'revoke_project_link').handler({ ref: 'plink_00000001' }, ctx(), CONFIRM);
    expect(ok.status).toBe('done');
    expect(ok.message).toMatch(/Revoked plink_00000001/);
    const again = await tool(deps({}, { revokeProjectLinkSafe: async () => ({ kind: 'revoked', ref: 'plink_00000001', alreadyRevoked: true }) }), 'revoke_project_link').handler({ ref: 'plink_00000001' }, ctx(), CONFIRM);
    expect(again.status).toBe('done');
    expect(again.message).toMatch(/already revoked/i);
  });
  it('cross-account and malformed references fail closed', async () => {
    const notOwned = await tool(deps({}, { revokeProjectLinkSafe: async () => ({ kind: 'failure', reason: 'not_owned' }) }), 'revoke_project_link').handler({ ref: 'plink_00000001' }, ctx(), CONFIRM);
    expect(notOwned.status).toBe('error');
    expect(notOwned.error).toMatch(/not owned/i);
    const bad = await tool(deps({}, { revokeProjectLinkSafe: async () => ({ kind: 'failure', reason: 'malformed_reference' }) }), 'revoke_project_link').handler({ ref: 'nope' }, ctx(), CONFIRM);
    expect(bad.status).toBe('error');
    expect(bad.error).toMatch(/isn't valid/i);
  });
});

describe('assistant-safe link references (registry)', () => {
  const reg = () => new AssistantLinkRefRegistry();
  const bind = { trackingId: 'abc123', accountId: DID, projectId: 'p1', epoch: 1 };

  it('mints opaque refs with no tracking-id or DID material, and is stable per link', () => {
    const r = reg();
    const a = r.mint(bind); const b = r.mint(bind);
    expect(a).toBe(b);
    expect(a).toMatch(/^plink_[0-9a-z]{8}$/);
    expect(a).not.toContain('abc123');
    expect(a).not.toContain('privy');
  });
  it('resolves only under the same account, project and epoch', () => {
    const r = reg(); const ref = r.mint(bind);
    expect(r.resolve(ref, { accountId: DID, epoch: 1, projectId: 'p1' }).ok).toBe(true);
    expect(r.resolve(ref, { accountId: DID_B, epoch: 1, projectId: 'p1' })).toMatchObject({ ok: false, reason: 'account-mismatch' });
    expect(r.resolve(ref, { accountId: DID, epoch: 1, projectId: 'p2' })).toMatchObject({ ok: false, reason: 'project-mismatch' });
    expect(r.resolve(ref, { accountId: DID, epoch: 2, projectId: 'p1' })).toMatchObject({ ok: false, reason: 'stale-session' });
    expect(r.resolve(ref, { accountId: null, epoch: 1 })).toMatchObject({ ok: false, reason: 'account-mismatch' });
  });
  it('malformed and unknown references fail closed', () => {
    const r = reg();
    for (const bad of ['', 'nope', 'plink_XX', 'did:privy:x', 42, null, undefined]) {
      expect(r.resolve(bad, { accountId: DID, epoch: 1 }).ok, String(bad)).toBe(false);
    }
    expect(r.resolve('plink_00000009', { accountId: DID, epoch: 1 })).toMatchObject({ ok: false, reason: 'unknown-reference' });
  });
  it('clear() (logout/switch) invalidates every outstanding ref', () => {
    const r = reg(); const ref = r.mint(bind);
    r.clear();
    expect(r.resolve(ref, { accountId: DID, epoch: 1, projectId: 'p1' }).ok).toBe(false);
    expect(r.size()).toBe(0);
  });
  it('safe projection derives status and omits every unsafe field', () => {
    const row = { project_id: 'p1', version_id: 'v1', allow_download: 1, collaborator_mode: 'comment', created_at: 'c', expires_at: null, revoked_at: null,
      account_id: DID, url: 'https://wavi.stream/project-link/abc123', label: 'secret label', file_path: '/Users/me/x.als' } as any;
    const safe = toAssistantSafeLink('plink_00000001', row, 'cached');
    const blob = JSON.stringify(safe);
    expect(blob).not.toContain('did:privy');
    expect(blob).not.toContain('abc123');
    expect(blob).not.toContain('/Users/');
    expect(blob).not.toContain('secret label');
    expect(safe.permissions.collaboratorMode).toBe('comment');
    expect(safeStatusFromRow({ revoked_at: 'x' })).toBe('revoked');
    expect(safeStatusFromRow({ expires_at: '2000-01-01T00:00:00Z' })).toBe('expired');
  });
});

describe('registry + privacy invariants', () => {
  it('exactly one execution path per Project Link capability (no duplicate names)', () => {
    const names = buildProjectTools(deps()).map((t) => t.name);
    for (const n of ['list_project_links', 'create_project_link', 'revoke_project_link']) {
      expect(names.filter((x) => x === n), n).toHaveLength(1);
    }
    expect(new Set(names).size).toBe(names.length);
  });
  it('multiplayer + contribution tools remain blocked and honest', async () => {
    expect(BLOCKED_CAPABILITIES.map((c) => c.name)).toEqual(['invite_collaborator', 'inspect_collaborator_activity', 'publish_child_version']);
    for (const n of ['invite_collaborator', 'inspect_collaborator_activity', 'publish_child_version']) {
      const r = await tool(deps(), n).handler({}, ctx());
      expect(r.status, n).toBe('error');
      expect(r.blockedReason, n).toBe('server_contract_pending');
    }
  });
  it('the PL trio is no longer in the blocked list', () => {
    const blocked = BLOCKED_CAPABILITIES.map((c) => c.name);
    for (const n of ['list_project_links', 'create_project_link', 'revoke_project_link']) expect(blocked).not.toContain(n);
  });
  it('no DID, token, URL or absolute path in any PL tool result', async () => {
    const d = deps();
    for (const [n, p] of [['list_project_links', {}], ['create_project_link', {}], ['revoke_project_link', { ref: 'plink_00000001' }]] as const) {
      const r = await tool(d, n).handler(p as any, ctx(), CONFIRM);
      const blob = JSON.stringify(r);
      expect(blob, n).not.toMatch(/did:privy|Bearer |eyJ|\/Users\/|https?:\/\//);
    }
  });
  it('create/revoke are gated while every read-only tool stays ungated', () => {
    const flags = Object.fromEntries(buildProjectTools(deps()).map((t) => [t.name, t.confirmationRequired]));
    expect(flags.create_project_link).toBe(true);
    expect(flags.revoke_project_link).toBe(true);
    expect(flags.list_project_links).toBe(false);
    expect(flags.inspect_project).toBe(false);
  });
});
