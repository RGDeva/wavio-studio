/**
 * P3-4-ID — collaborator identity resolution + invite-by-target.
 *
 * Pinned to the locked server (`wavio@d95683f`, `api/desktop/multiplayer.ts`):
 * `resolve-invite-target` returns an opaque `invt_…` capability plus
 * display-only fields, 429 on the 10-per-15-min rate limit, and a deliberately
 * uninformative `resolved: false`. Invite accepts EXACTLY ONE of `inviteTarget`
 * or `inviteeAccountId`, and `can_contribute` is forced false unless the role
 * is `comment`.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveInviteTargetFlow, inviteCollaboratorFlow, checkInviteIdentifier,
  contributionAllowedForRole, INVITE_TARGET_RE, INVITE_TARGET_TTL_MS,
  MULTIPLAYER_ACTIONS, type MultiplayerServiceDeps,
} from './multiplayerService';
import { MultiplayerRefRegistry, INVITE_TARGET_UNRESOLVED_MESSAGE } from './multiplayerRefs';

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

const DID = 'did:privy:owner1';
const TARGET = `invt_${'a'.repeat(32)}`;
const RESOLVED = {
  status: 200,
  json: { accountId: DID, resolved: true, inviteTarget: TARGET, display: { displayName: 'Ada', avatarUrl: null } },
};

describe('identifier validation (mirrors the server, saves a rate-limited call)', () => {
  it('accepts an email and an @handle', () => {
    expect(checkInviteIdentifier('ada@example.com')).toEqual({ ok: true, kind: 'email' });
    expect(checkInviteIdentifier('@ada_makes')).toEqual({ ok: true, kind: 'handle' });
    expect(checkInviteIdentifier('  Ada@Example.COM  ')).toEqual({ ok: true, kind: 'email' });
  });

  it('rejects empty, overlong, and malformed identifiers', () => {
    expect(checkInviteIdentifier('').ok).toBe(false);
    expect(checkInviteIdentifier('   ').ok).toBe(false);
    expect(checkInviteIdentifier('x'.repeat(300)).ok).toBe(false);
    expect(checkInviteIdentifier('not an identifier').ok).toBe(false);
    expect(checkInviteIdentifier(null).ok).toBe(false);
  });
});

describe('resolveInviteTargetFlow', () => {
  it('requires an explicit project — no network call without one', async () => {
    const deps = fakeDeps(RESOLVED);
    const res = await resolveInviteTargetFlow(deps, { projectId: '', identifier: 'ada@example.com' });
    expect(res.kind).toBe('failure');
    expect(deps.calls).toHaveLength(0);
  });

  it('requires an identifier — no network call without one', async () => {
    const deps = fakeDeps(RESOLVED);
    const res = await resolveInviteTargetFlow(deps, { projectId: 'p1', identifier: '' });
    expect(res.kind).toBe('failure');
    expect(deps.calls).toHaveLength(0);
  });

  it('posts the locked action with exactly projectId + identifier', async () => {
    const deps = fakeDeps(RESOLVED);
    await resolveInviteTargetFlow(deps, { projectId: 'p1', identifier: '  ada@example.com ' });
    expect(deps.calls[0].action).toBe(MULTIPLAYER_ACTIONS.resolveInviteTarget);
    expect(deps.calls[0].body).toEqual({ projectId: 'p1', identifier: 'ada@example.com' });
  });

  it('returns an opaque target plus display-only fields', async () => {
    const res = await resolveInviteTargetFlow(fakeDeps(RESOLVED), { projectId: 'p1', identifier: 'ada@example.com' }, 1_000);
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    expect(res.inviteTarget).toMatch(INVITE_TARGET_RE);
    expect(res.display.displayName).toBe('Ada');
    expect(res.expiresAtMs).toBe(1_000 + INVITE_TARGET_TTL_MS);
  });

  it('NEVER exposes the target DID, email, or handle', async () => {
    // Even if a future server leaked extra fields, the parse allowlist drops them.
    const leaky = {
      status: 200,
      json: {
        accountId: DID, resolved: true, inviteTarget: TARGET,
        targetAccountId: 'did:privy:SECRET', email: 'ada@example.com', handle: 'ada_makes',
        display: { displayName: 'Ada', avatarUrl: null },
      },
    };
    const res = await resolveInviteTargetFlow(fakeDeps(leaky), { projectId: 'p1', identifier: 'ada@example.com' });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    const json = JSON.stringify({ inviteTarget: res.inviteTarget, display: res.display });
    expect(json).not.toContain('did:privy:SECRET');
    expect(json).not.toContain('ada@example.com');
    expect(json).not.toContain('ada_makes');
  });

  it('resolved:false is a single neutral outcome — no hidden-vs-missing signal', async () => {
    const res = await resolveInviteTargetFlow(
      fakeDeps({ status: 200, json: { accountId: DID, resolved: false } }),
      { projectId: 'p1', identifier: 'ghost@example.com' },
    );
    expect(res.kind).toBe('unresolved');
    // Exactly one message exists for this case.
    expect(INVITE_TARGET_UNRESOLVED_MESSAGE).toBe('No inviteable Wavi account found.');
  });

  it('normalizes the 429 rate limit to its own reason (never a retry hint)', async () => {
    const res = await resolveInviteTargetFlow(
      fakeDeps({ status: 429, json: { error: 'Too many invite target lookups' } }),
      { projectId: 'p1', identifier: 'ada@example.com' },
    );
    expect(res.kind === 'failure' && res.reason).toBe('rate-limited');
  });

  it('maps a non-owner 403 to forbidden', async () => {
    const res = await resolveInviteTargetFlow(
      fakeDeps({ status: 403, json: {} }), { projectId: 'p1', identifier: 'ada@example.com' });
    expect(res.kind === 'failure' && res.reason).toBe('forbidden');
  });

  it('rejects a malformed inviteTarget rather than trusting it', async () => {
    const res = await resolveInviteTargetFlow(
      fakeDeps({ status: 200, json: { accountId: DID, resolved: true, inviteTarget: 'nope', display: {} } }),
      { projectId: 'p1', identifier: 'ada@example.com' },
    );
    expect(res.kind === 'failure' && res.reason).toBe('malformed');
  });

  it('reports offline when the transport throws', async () => {
    const res = await resolveInviteTargetFlow(fakeDeps({ threw: true }), { projectId: 'p1', identifier: 'ada@example.com' });
    expect(res.kind === 'failure' && res.reason).toBe('offline');
  });
});

describe('invite by opaque target', () => {
  const ok = { status: 200, json: { accountId: DID, invited: true, item: {
    membershipId: 'm1', projectId: 'p1', role: 'comment', canContribute: true,
    state: { active: false, pending: true, declined: false, revoked: false, expired: false },
    actor: { displayName: 'Ada', avatarUrl: null },
    createdAt: null, updatedAt: null, acceptedAt: null, expiresAt: null, revision: 'r1',
  } } };

  it('sends inviteTarget and never a DID', async () => {
    const deps = fakeDeps(ok);
    await inviteCollaboratorFlow(deps, { projectId: 'p1', inviteTarget: TARGET, role: 'comment', canContribute: true });
    expect(deps.calls[0].body.inviteTarget).toBe(TARGET);
    expect('inviteeAccountId' in deps.calls[0].body).toBe(false);
    expect(JSON.stringify(deps.calls[0].body)).not.toContain('did:privy');
  });

  it('rejects supplying both identities (server 400s on both-or-neither)', async () => {
    const deps = fakeDeps(ok);
    const res = await inviteCollaboratorFlow(deps, {
      projectId: 'p1', inviteTarget: TARGET, inviteeAccountId: DID, role: 'view',
    });
    expect(res.kind).toBe('failure');
    expect(deps.calls).toHaveLength(0);
  });

  it('rejects supplying neither', async () => {
    const deps = fakeDeps(ok);
    const res = await inviteCollaboratorFlow(deps, { projectId: 'p1', role: 'view' });
    expect(res.kind).toBe('failure');
    expect(deps.calls).toHaveLength(0);
  });

  it('rejects a malformed target before spending a request', async () => {
    const deps = fakeDeps(ok);
    const res = await inviteCollaboratorFlow(deps, { projectId: 'p1', inviteTarget: 'invt_short', role: 'view' });
    expect(res.kind === 'failure' && res.reason).toBe('invite-target-expired');
    expect(deps.calls).toHaveLength(0);
  });

  it('a `view` invite never claims contribution — the server would force it false', async () => {
    const deps = fakeDeps(ok);
    await inviteCollaboratorFlow(deps, { projectId: 'p1', inviteTarget: TARGET, role: 'view', canContribute: true });
    expect(deps.calls[0].body.canContribute).toBe(false);
    expect(contributionAllowedForRole('view')).toBe(false);
  });

  it('a `comment` invite may carry contribution', async () => {
    const deps = fakeDeps(ok);
    await inviteCollaboratorFlow(deps, { projectId: 'p1', inviteTarget: TARGET, role: 'comment', canContribute: true });
    expect(deps.calls[0].body.canContribute).toBe(true);
    expect(contributionAllowedForRole('comment')).toBe(true);
  });

  it('still rejects `edit` before the network', async () => {
    const deps = fakeDeps(ok);
    const res = await inviteCollaboratorFlow(deps, { projectId: 'p1', inviteTarget: TARGET, role: 'edit' });
    expect(res.kind).toBe('failure');
    expect(deps.calls).toHaveLength(0);
  });

  it('an expired target (server 400) is surfaced honestly, not as success', async () => {
    const res = await inviteCollaboratorFlow(
      fakeDeps({ status: 400, json: { error: 'inviteTarget is invalid or expired' } }),
      { projectId: 'p1', inviteTarget: TARGET, role: 'view' },
    );
    expect(res.kind === 'failure' && res.reason).toBe('rejected');
  });

  it('an already-accepted member (409) is a conflict, never a fresh invite', async () => {
    const res = await inviteCollaboratorFlow(
      fakeDeps({ status: 409, json: { error: 'Account is already a project member' } }),
      { projectId: 'p1', inviteTarget: TARGET, role: 'view' },
    );
    expect(res.kind === 'failure' && res.reason).toBe('conflict');
  });
});

describe('pinvite_ refs', () => {
  const EPOCH = 1;
  function reg() {
    const r = new MultiplayerRefRegistry();
    const ref = r.mint({ kind: 'invite', serverId: TARGET, accountId: DID, projectId: 'p1', epoch: EPOCH, expiresAtMs: 10_000 });
    return { r, ref };
  }

  it('mints an opaque pinvite_ handle that leaks no capability material', () => {
    const { ref } = reg();
    expect(ref).toMatch(/^pinvite_[0-9a-z]{8}$/);
    expect(ref).not.toContain(TARGET);
  });

  it('resolves within the TTL and fails closed after it', () => {
    const { r, ref } = reg();
    expect(r.resolve(ref, { kind: 'invite', accountId: DID, epoch: EPOCH, projectId: 'p1', now: 9_999 }).ok).toBe(true);
    const late = r.resolve(ref, { kind: 'invite', accountId: DID, epoch: EPOCH, projectId: 'p1', now: 10_000 });
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.reason).toBe('expired');
  });

  it('never resolves cross-project', () => {
    const { r, ref } = reg();
    const res = r.resolve(ref, { kind: 'invite', accountId: DID, epoch: EPOCH, projectId: 'p2', now: 0 });
    expect(res.ok === false && res.reason).toBe('project-mismatch');
  });

  it('never resolves under another account', () => {
    const { r, ref } = reg();
    const res = r.resolve(ref, { kind: 'invite', accountId: 'did:privy:other', epoch: EPOCH, now: 0 });
    expect(res.ok === false && res.reason).toBe('account-mismatch');
  });

  it('never resolves after an account switch / logout bumps the epoch', () => {
    const { r, ref } = reg();
    const res = r.resolve(ref, { kind: 'invite', accountId: DID, epoch: EPOCH + 1, now: 0 });
    expect(res.ok === false && res.reason).toBe('stale-session');
  });

  it('logout clears every invite ref', () => {
    const { r, ref } = reg();
    r.clear();
    expect(r.resolve(ref, { kind: 'invite', accountId: DID, epoch: EPOCH, now: 0 }).ok).toBe(false);
  });

  it('an invite ref cannot be used as a membership ref', () => {
    const { r, ref } = reg();
    const res = r.resolve(ref, { kind: 'member', accountId: DID, epoch: EPOCH, now: 0 });
    expect(res.ok === false && res.reason).toBe('wrong-kind');
  });

  it('forget() spends the ref so a consumed capability cannot be reused', () => {
    const { r, ref } = reg();
    r.forget(ref);
    expect(r.resolve(ref, { kind: 'invite', accountId: DID, epoch: EPOCH, now: 0 }).ok).toBe(false);
  });
});
