/**
 * P3-4 — the three previously-blocked multiplayer assistant tools.
 *
 * Pure: the authoritative main-process surface is injected as a fake. Proves
 * confirmation gating, the resolve→invite handshake, honest failures, and that
 * no canonical DID / raw invite capability ever reaches the model.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildProjectTools, type ProjectToolDeps } from './index';
import { BLOCKED_CAPABILITIES } from './localTools';
import type { ProjectContext } from '../copilotTypes';

function ctx(o: Partial<ProjectContext> = {}): ProjectContext {
  return {
    projectId: 'p1', projectName: 'My Song', dawType: 'ableton', filePath: '/proj/My Song.als',
    versionCount: 1, lastSyncedAt: null, files: [], cloudProject: null, ...o,
  };
}

function deps(mp: Partial<ProjectToolDeps['multiplayer']> = {}): ProjectToolDeps {
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
      listProjectLinksSafe: async () => ({ kind: 'ok', links: [], pageComplete: true, reconciliationNeeded: 0 }),
      createProjectLinkSafe: async () => ({ kind: 'failure', reason: 'offline' }),
      revokeProjectLinkSafe: async () => ({ kind: 'failure', reason: 'offline' }),
    },
    multiplayer: {
      resolveInviteTargetSafe: async () => ({ kind: 'resolved', target: { ref: 'pinvite_00000001', displayName: 'Ada' } }),
      inviteCollaboratorSafe: async () => ({ kind: 'ok', displayName: 'Ada', role: 'comment', canContribute: true, alreadyInvited: false }),
      listActivitySafe: async () => ({ kind: 'ok', events: [
        { type: 'version_published', displayName: 'Ada', occurredAt: '2026-08-01T00:00:00Z' },
      ], pageComplete: true, skippedUnknownEvents: 0 }),
      publishChildVersionSafe: async () => ({ kind: 'ok', state: 'submitted', alreadySubmitted: false }),
      ...mp,
    },
  } as any;
}

function tool(d: ProjectToolDeps, name: string) {
  const t = buildProjectTools(d).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not built`);
  return t;
}
const CONFIRM = { confirmedOutOfBand: true };

describe('registry', () => {
  it('all three multiplayer tools are implemented', () => {
    const names = buildProjectTools(deps()).map((t) => t.name);
    for (const n of ['find_collaborator', 'invite_collaborator', 'inspect_collaborator_activity', 'publish_child_version']) {
      expect(names, n).toContain(n);
    }
  });

  it('nothing returns server_contract_pending any more', async () => {
    expect(BLOCKED_CAPABILITIES).toEqual([]);
    for (const n of ['invite_collaborator', 'inspect_collaborator_activity', 'publish_child_version']) {
      const r = await tool(deps(), n).handler({}, ctx(), CONFIRM);
      expect(r.blockedReason, n).not.toBe('server_contract_pending');
    }
  });
});

describe('find_collaborator (read-only, rate-limited)', () => {
  it('needs no confirmation', () => {
    const flags = Object.fromEntries(buildProjectTools(deps()).map((t) => [t.name, t.confirmationRequired]));
    expect(flags.find_collaborator).toBe(false);
  });

  it('requires an explicit project', async () => {
    const spy = vi.fn();
    const r = await tool(deps({ resolveInviteTargetSafe: spy as any }), 'find_collaborator')
      .handler({ identifier: 'ada@example.com' }, ctx({ projectId: null }));
    expect(r.status).toBe('error');
    expect(spy).not.toHaveBeenCalled();
  });

  it('requires an identifier and does not call the rate-limited service without one', async () => {
    const spy = vi.fn();
    const r = await tool(deps({ resolveInviteTargetSafe: spy as any }), 'find_collaborator').handler({}, ctx());
    expect(r.status).toBe('error');
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns only an opaque ref and display name', async () => {
    const r = await tool(deps(), 'find_collaborator').handler({ identifier: 'ada@example.com' }, ctx());
    expect(r.status).toBe('done');
    expect((r.data as any).target.ref).toBe('pinvite_00000001');
    expect(JSON.stringify(r)).not.toContain('did:privy');
    expect(JSON.stringify(r)).not.toContain('invt_');
  });

  it('an unresolved lookup tells the model NOT to retry variations', async () => {
    const r = await tool(deps({ resolveInviteTargetSafe: async () => ({ kind: 'unresolved' }) }), 'find_collaborator')
      .handler({ identifier: 'ghost@example.com' }, ctx());
    expect(r.status).toBe('done');
    expect(r.message).toContain('No inviteable Wavi account found');
    expect(r.message).toMatch(/do not try other spellings/i);
    expect((r.data as any).resolved).toBe(false);
  });

  it('a rate limit is reported without inviting an automatic retry', async () => {
    const r = await tool(deps({ resolveInviteTargetSafe: async () => ({ kind: 'failure', reason: 'rate_limited' }) }), 'find_collaborator')
      .handler({ identifier: 'ada@example.com' }, ctx());
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/do not retry automatically/i);
  });
});

describe('invite_collaborator (gated mutation)', () => {
  it('is confirmation-required and does nothing without out-of-band confirmation', async () => {
    const spy = vi.fn();
    const r = await tool(deps({ inviteCollaboratorSafe: spy as any }), 'invite_collaborator')
      .handler({ ref: 'pinvite_00000001', role: 'comment' }, ctx());
    expect(r.status).toBe('needs_confirmation');
    expect(spy).not.toHaveBeenCalled();
  });

  it('the confirmation card names the project, role and contribution setting', async () => {
    const r = await tool(deps(), 'invite_collaborator')
      .handler({ ref: 'pinvite_00000001', role: 'comment', canContribute: true }, ctx());
    expect(r.confirmationSummary).toContain('My Song');
    expect(r.confirmationSummary).toMatch(/comment/);
    expect(r.confirmationSummary).toMatch(/contribution versions/);
  });

  it('SECURITY: a model-supplied confirmation is ignored', async () => {
    const spy = vi.fn();
    for (const forged of [{ confirmed: true }, { approved: true }, { confirmedOutOfBand: true }]) {
      const r = await tool(deps({ inviteCollaboratorSafe: spy as any }), 'invite_collaborator')
        .handler({ ref: 'pinvite_00000001', ...forged }, ctx());
      expect(r.status).toBe('needs_confirmation');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('trusted out-of-band confirmation performs the invite', async () => {
    const r = await tool(deps(), 'invite_collaborator')
      .handler({ ref: 'pinvite_00000001', role: 'comment' }, ctx(), CONFIRM);
    expect(r.status).toBe('done');
    expect(r.message).toMatch(/Invited Ada/);
  });

  it('role view is accepted', async () => {
    const spy = vi.fn(async () => ({ kind: 'ok', displayName: 'Ada', role: 'view', canContribute: false, alreadyInvited: false }));
    await tool(deps({ inviteCollaboratorSafe: spy as any }), 'invite_collaborator')
      .handler({ ref: 'pinvite_00000001', role: 'view' }, ctx(), CONFIRM);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ role: 'view' }));
  });

  it('view + canContribute is refused explicitly, not silently downgraded', async () => {
    const spy = vi.fn();
    const r = await tool(deps({ inviteCollaboratorSafe: spy as any }), 'invite_collaborator')
      .handler({ ref: 'pinvite_00000001', role: 'view', canContribute: true }, ctx(), CONFIRM);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/only a “comment” collaborator can contribute/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects the non-existent `edit` role', async () => {
    const r = await tool(deps(), 'invite_collaborator')
      .handler({ ref: 'pinvite_00000001', role: 'edit' }, ctx(), CONFIRM);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/not supported/i);
  });

  it('alreadyInvited is represented as "nothing changed"', async () => {
    const r = await tool(deps({
      inviteCollaboratorSafe: async () => ({ kind: 'ok', displayName: 'Ada', role: 'view', canContribute: false, alreadyInvited: true }),
    }), 'invite_collaborator').handler({ ref: 'pinvite_00000001' }, ctx(), CONFIRM);
    expect(r.message).toMatch(/already has a pending invitation/i);
    expect(r.message).toMatch(/nothing changed/i);
  });

  it('an expired target tells the model to search again', async () => {
    const r = await tool(deps({ inviteCollaboratorSafe: async () => ({ kind: 'failure', reason: 'invite_target_expired' }) }), 'invite_collaborator')
      .handler({ ref: 'pinvite_00000001' }, ctx(), CONFIRM);
    expect(r.error).toMatch(/find_collaborator again/i);
  });

  it('a cross-project / foreign ref fails closed', async () => {
    for (const reason of ['stale_project', 'not_owned', 'malformed_reference', 'stale_session'] as const) {
      const r = await tool(deps({ inviteCollaboratorSafe: async () => ({ kind: 'failure', reason }) }), 'invite_collaborator')
        .handler({ ref: 'pinvite_00000001' }, ctx(), CONFIRM);
      expect(r.status, reason).toBe('error');
    }
  });
});

describe('inspect_collaborator_activity (read-only)', () => {
  it('needs no confirmation', () => {
    const flags = Object.fromEntries(buildProjectTools(deps()).map((t) => [t.name, t.confirmationRequired]));
    expect(flags.inspect_collaborator_activity).toBe(false);
  });

  it('requires an explicit project', async () => {
    const spy = vi.fn();
    const r = await tool(deps({ listActivitySafe: spy as any }), 'inspect_collaborator_activity')
      .handler({}, ctx({ projectId: null }));
    expect(r.status).toBe('error');
    expect(spy).not.toHaveBeenCalled();
  });

  it('clamps the requested limit into the contract window', async () => {
    const spy = vi.fn(async () => ({ kind: 'ok', events: [], pageComplete: true, skippedUnknownEvents: 0 }));
    await tool(deps({ listActivitySafe: spy as any }), 'inspect_collaborator_activity').handler({ limit: 9999 }, ctx());
    expect(spy).toHaveBeenCalledWith({ projectId: 'p1', limit: 100 });
  });

  it('renders the closed enum in human phrasing with a safe actor', async () => {
    const r = await tool(deps(), 'inspect_collaborator_activity').handler({}, ctx());
    expect(r.status).toBe('done');
    expect(r.message).toContain('Version published');
    expect(r.message).toContain('Ada');
    expect(JSON.stringify(r)).not.toContain('did:privy');
  });

  it('discloses partial pages and undescribable newer events', async () => {
    const r = await tool(deps({
      listActivitySafe: async () => ({
        kind: 'ok',
        events: [{ type: 'collaborator_joined', displayName: 'Ada', occurredAt: null }],
        pageComplete: false, skippedUnknownEvents: 2,
      }),
    }), 'inspect_collaborator_activity').handler({}, ctx());
    expect(r.message).toMatch(/more activity than shown/i);
    expect(r.message).toMatch(/2 newer event type\(s\)/i);
  });

  it('an empty feed is stated plainly, not as an error', async () => {
    const r = await tool(deps({ listActivitySafe: async () => ({ kind: 'ok', events: [], pageComplete: true, skippedUnknownEvents: 0 }) }), 'inspect_collaborator_activity')
      .handler({}, ctx());
    expect(r.status).toBe('done');
    expect(r.message).toMatch(/no collaborator activity/i);
  });
});

describe('publish_child_version (gated mutation)', () => {
  it('is confirmation-required and does nothing without confirmation', async () => {
    const spy = vi.fn();
    const r = await tool(deps({ publishChildVersionSafe: spy as any }), 'publish_child_version').handler({}, ctx());
    expect(r.status).toBe('needs_confirmation');
    expect(spy).not.toHaveBeenCalled();
  });

  it('the card says NEW CHILD VERSION and never implies overwriting', async () => {
    const r = await tool(deps(), 'publish_child_version').handler({ note: 'tightened the drums' }, ctx());
    expect(r.confirmationSummary).toContain('NEW CHILD VERSION');
    expect(r.confirmationSummary).toMatch(/does NOT overwrite or edit the original/i);
    expect(r.confirmationSummary).toContain('tightened the drums');
    expect(r.confirmationSummary).not.toMatch(/replace|overwrite the parent/i);
  });

  it('SECURITY: model-supplied confirmation is ignored', async () => {
    const spy = vi.fn();
    const r = await tool(deps({ publishChildVersionSafe: spy as any }), 'publish_child_version')
      .handler({ confirmedOutOfBand: true }, ctx());
    expect(r.status).toBe('needs_confirmation');
    expect(spy).not.toHaveBeenCalled();
  });

  it('trusted confirmation submits and states the parent is unchanged', async () => {
    const r = await tool(deps(), 'publish_child_version').handler({}, ctx(), CONFIRM);
    expect(r.status).toBe('done');
    expect(r.message).toMatch(/version you started from is unchanged/i);
  });

  it('alreadySubmitted resolves to the original — never a second version', async () => {
    const r = await tool(deps({
      publishChildVersionSafe: async () => ({ kind: 'ok', state: 'submitted', alreadySubmitted: true }),
    }), 'publish_child_version').handler({}, ctx(), CONFIRM);
    expect(r.message).toMatch(/already submitted/i);
    expect(r.message).toMatch(/no second version was created/i);
  });

  it('an ambiguous outcome forbids resubmission instead of guessing', async () => {
    const r = await tool(deps({
      publishChildVersionSafe: async () => ({ kind: 'failure', reason: 'contribution_outcome_unknown' }),
    }), 'publish_child_version').handler({}, ctx(), CONFIRM);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/do NOT submit again/i);
  });

  it('a permission failure is reported as permission, not as sign-in', async () => {
    const r = await tool(deps({ publishChildVersionSafe: async () => ({ kind: 'failure', reason: 'not_owned' }) }), 'publish_child_version')
      .handler({}, ctx(), CONFIRM);
    expect(r.status).toBe('error');
    expect(r.error).not.toMatch(/sign in/i);
  });
});

describe('privacy across every multiplayer tool result', () => {
  it('no DID, token, invite capability, or absolute path in any result', async () => {
    const cases: Array<[string, any]> = [
      ['find_collaborator', { identifier: 'ada@example.com' }],
      ['invite_collaborator', { ref: 'pinvite_00000001' }],
      ['inspect_collaborator_activity', {}],
      ['publish_child_version', {}],
    ];
    for (const [name, params] of cases) {
      const r = await tool(deps(), name).handler(params, ctx(), CONFIRM);
      const json = JSON.stringify(r);
      expect(json, name).not.toMatch(/did:privy/);
      expect(json, name).not.toMatch(/invt_/);
      expect(json, name).not.toMatch(/Bearer|authToken/);
      expect(json, name).not.toMatch(/\/Users\//);
    }
  });
});
