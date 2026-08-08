/**
 * Multiplayer v1 — membership mutation flows.
 *
 * Covers invite / respond-invite / revoke against the locked envelopes,
 * including the contract's idempotency echoes (`alreadyInvited`,
 * `alreadyAccepted`, `alreadyDeclined`, `alreadyRevoked`) which must be
 * PRESERVED as such rather than flattened into a plain success.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeAssignableRole, inviteCollaboratorFlow, respondInviteFlow, revokeCollaboratorFlow,
  type MultiplayerServiceDeps,
} from './multiplayerService';

function fakeDeps(
  response: { status: number; json: any } | { threw: true },
  online = true,
): MultiplayerServiceDeps & { calls: Array<{ action: string; body: any }> } {
  const calls: Array<{ action: string; body: any }> = [];
  return {
    calls,
    isOnline: () => online,
    postDesktop: async (action, body) => {
      calls.push({ action, body });
      if ('threw' in response) return { status: 0, json: {}, threw: true };
      return { status: response.status, json: response.json };
    },
  };
}

const MEMBER = {
  membershipId: 'mem-1', projectId: 'proj-1', role: 'view', canContribute: false,
  state: { active: false, pending: true, declined: false, revoked: false, expired: false },
  actor: { displayName: 'Ada', avatarUrl: null },
  createdAt: null, updatedAt: null, acceptedAt: null, expiresAt: null, revision: 'r1',
};

const DID = 'did:privy:cmabc123';

describe('role vocabulary', () => {
  it('accepts the two assignable roles', () => {
    expect(normalizeAssignableRole('view')).toEqual({ ok: true, role: 'view' });
    expect(normalizeAssignableRole('comment')).toEqual({ ok: true, role: 'comment' });
  });

  it('rejects "edit" with an explanation naming the real vocabulary', () => {
    const r = normalizeAssignableRole('edit');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('does not exist');
    expect(r.reason).toContain('view');
    expect(r.reason).toContain('comment');
  });

  it('rejects "owner" as an assignable role (owner is not invitable)', () => {
    expect(normalizeAssignableRole('owner').ok).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(normalizeAssignableRole(null).ok).toBe(false);
    expect(normalizeAssignableRole(3).ok).toBe(false);
  });
});

describe('inviteCollaboratorFlow', () => {
  it('rejects "edit" BEFORE any network call', async () => {
    const deps = fakeDeps({ status: 200, json: {} });
    const res = await inviteCollaboratorFlow(deps, { projectId: 'p', inviteeAccountId: DID, role: 'edit' });
    expect(res.kind).toBe('failure');
    expect(deps.calls).toHaveLength(0);
  });

  it('rejects an email address locally with the contract-accurate reason', async () => {
    const deps = fakeDeps({ status: 200, json: {} });
    const res = await inviteCollaboratorFlow(deps, {
      projectId: 'p', inviteeAccountId: 'ada@example.com', role: 'view',
    });
    expect(res.kind).toBe('failure');
    if (res.kind !== 'failure') return;
    expect(res.message).toContain('Email invitations are not supported');
    expect(deps.calls).toHaveLength(0);
  });

  it('sends role and canContribute as SEPARATE fields', async () => {
    const deps = fakeDeps({ status: 200, json: { accountId: DID, invited: true, item: MEMBER } });
    await inviteCollaboratorFlow(deps, {
      projectId: 'proj-1', inviteeAccountId: DID, role: 'comment', canContribute: true,
    });
    expect(deps.calls[0].action).toBe('invite-project-collaborator');
    expect(deps.calls[0].body).toEqual({
      projectId: 'proj-1', inviteeAccountId: DID, role: 'comment', canContribute: true,
    });
  });

  it('defaults canContribute to false rather than inferring it from "comment"', async () => {
    const deps = fakeDeps({ status: 200, json: { accountId: DID, invited: true, item: MEMBER } });
    await inviteCollaboratorFlow(deps, { projectId: 'p', inviteeAccountId: DID, role: 'comment' });
    expect(deps.calls[0].body.canContribute).toBe(false);
  });

  it('preserves the duplicate-pending echo as alreadyInvited', async () => {
    const deps = fakeDeps({ status: 200, json: { accountId: DID, alreadyInvited: true, item: MEMBER } });
    const res = await inviteCollaboratorFlow(deps, { projectId: 'p', inviteeAccountId: DID, role: 'view' });
    expect(res.kind).toBe('invited');
    if (res.kind !== 'invited') return;
    expect(res.alreadyInvited).toBe(true);
  });

  it('maps a self-invite / already-member 409 to conflict', async () => {
    const deps = fakeDeps({ status: 409, json: { error: 'Already a member' } });
    const res = await inviteCollaboratorFlow(deps, { projectId: 'p', inviteeAccountId: DID, role: 'view' });
    expect(res.kind === 'failure' && res.reason).toBe('conflict');
  });

  it('maps a non-owner 403 to forbidden', async () => {
    const deps = fakeDeps({ status: 403, json: {} });
    const res = await inviteCollaboratorFlow(deps, { projectId: 'p', inviteeAccountId: DID, role: 'view' });
    expect(res.kind === 'failure' && res.reason).toBe('forbidden');
  });

  it('refuses a 200 with no confirmation flag', async () => {
    const deps = fakeDeps({ status: 200, json: { accountId: DID, item: MEMBER } });
    const res = await inviteCollaboratorFlow(deps, { projectId: 'p', inviteeAccountId: DID, role: 'view' });
    expect(res.kind === 'failure' && res.reason).toBe('malformed');
  });

  it('refuses a confirmed response whose item cannot be parsed', async () => {
    const deps = fakeDeps({ status: 200, json: { accountId: DID, invited: true, item: { role: 'edit' } } });
    const res = await inviteCollaboratorFlow(deps, { projectId: 'p', inviteeAccountId: DID, role: 'view' });
    expect(res.kind === 'failure' && res.reason).toBe('malformed');
  });
});

describe('respondInviteFlow', () => {
  it('sends the accept decision explicitly', async () => {
    const deps = fakeDeps({ status: 200, json: { accountId: DID, accepted: true, item: MEMBER } });
    const res = await respondInviteFlow(deps, { membershipId: 'mem-1', accept: true });
    expect(deps.calls[0].action).toBe('respond-project-invite');
    expect(deps.calls[0].body).toEqual({ membershipId: 'mem-1', accept: true });
    expect(res.kind === 'responded' && res.accepted).toBe(true);
  });

  it('treats alreadyAccepted as a responded+accepted echo, not a new acceptance', async () => {
    const deps = fakeDeps({ status: 200, json: { accountId: DID, alreadyAccepted: true, item: MEMBER } });
    const res = await respondInviteFlow(deps, { membershipId: 'mem-1', accept: true });
    expect(res.kind).toBe('responded');
    if (res.kind !== 'responded') return;
    expect(res.accepted).toBe(true);
    expect(res.alreadyResponded).toBe(true);
  });

  it('treats alreadyDeclined as responded but NOT accepted', async () => {
    const deps = fakeDeps({ status: 200, json: { accountId: DID, alreadyDeclined: true, item: MEMBER } });
    const res = await respondInviteFlow(deps, { membershipId: 'mem-1', accept: false });
    expect(res.kind === 'responded' && res.accepted).toBe(false);
    expect(res.kind === 'responded' && res.alreadyResponded).toBe(true);
  });

  it('maps an expired invite (410) to its own terminal reason', async () => {
    const deps = fakeDeps({ status: 410, json: { error: 'Invitation expired' } });
    const res = await respondInviteFlow(deps, { membershipId: 'mem-1', accept: true });
    expect(res.kind === 'failure' && res.reason).toBe('invite-expired');
  });

  it("maps another account's invite (403) to forbidden", async () => {
    const deps = fakeDeps({ status: 403, json: {} });
    const res = await respondInviteFlow(deps, { membershipId: 'mem-1', accept: true });
    expect(res.kind === 'failure' && res.reason).toBe('forbidden');
  });

  it('maps a non-pending membership (409) to conflict', async () => {
    const deps = fakeDeps({ status: 409, json: {} });
    const res = await respondInviteFlow(deps, { membershipId: 'mem-1', accept: true });
    expect(res.kind === 'failure' && res.reason).toBe('conflict');
  });

  it('reports offline when the transport throws', async () => {
    const deps = fakeDeps({ threw: true });
    const res = await respondInviteFlow(deps, { membershipId: 'mem-1', accept: true });
    expect(res.kind === 'failure' && res.reason).toBe('offline');
  });
});

describe('revokeCollaboratorFlow', () => {
  it('sends only the membership id (self-leave vs removal is the server\'s call)', async () => {
    const deps = fakeDeps({ status: 200, json: { accountId: DID, revoked: true, item: MEMBER } });
    await revokeCollaboratorFlow(deps, { membershipId: 'mem-1' });
    expect(deps.calls[0].action).toBe('revoke-project-collaborator');
    expect(deps.calls[0].body).toEqual({ membershipId: 'mem-1' });
  });

  it('preserves alreadyRevoked as an idempotent echo', async () => {
    const deps = fakeDeps({ status: 200, json: { accountId: DID, alreadyRevoked: true, item: MEMBER } });
    const res = await revokeCollaboratorFlow(deps, { membershipId: 'mem-1' });
    expect(res.kind === 'revoked' && res.alreadyRevoked).toBe(true);
  });

  it('maps revoking the owner row (409) to conflict, never to success', async () => {
    const deps = fakeDeps({ status: 409, json: { error: 'Cannot remove the project owner' } });
    const res = await revokeCollaboratorFlow(deps, { membershipId: 'mem-owner' });
    expect(res.kind).toBe('failure');
    if (res.kind !== 'failure') return;
    expect(res.reason).toBe('conflict');
  });

  it('refuses a 200 with no confirmation flag', async () => {
    const deps = fakeDeps({ status: 200, json: { accountId: DID, item: MEMBER } });
    const res = await revokeCollaboratorFlow(deps, { membershipId: 'mem-1' });
    expect(res.kind === 'failure' && res.reason).toBe('malformed');
  });
});
