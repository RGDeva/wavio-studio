/**
 * Multiplayer v1 — privacy boundary, ref isolation, and source invariants.
 *
 * Proves the things the renderer (and, later, the assistant) must never see:
 * the canonical account DID, the auth token, canonical membership/contribution
 * ids, raw server error text, and local filesystem paths.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  MultiplayerRefRegistry, toSafeMembership, toSafeActivity, toSafeContribution,
  membershipDisplayState, contributionDisplayState, MULTIPLAYER_FAILURE_MESSAGE,
} from './multiplayerRefs';
import type { ActivityEvent, Contribution, Membership } from './multiplayerService';

const DID_A = 'did:privy:aaaa1111';
const DID_B = 'did:privy:bbbb2222';

const MEMBER: Membership = {
  membershipId: 'mem-secret-1', projectId: 'proj-1', role: 'comment', canContribute: true,
  state: { active: true, pending: false, declined: false, revoked: false, expired: false },
  actor: { displayName: 'Ada', avatarUrl: null },
  createdAt: '2026-08-01T00:00:00Z', updatedAt: null, acceptedAt: null, expiresAt: null, revision: 'r1',
};

const CONTRIB: Contribution = {
  contributionId: 'contrib-secret-1', projectId: 'proj-1', parentVersionId: 'v-0', childVersionId: 'v-1',
  state: { submitted: true, accepted: false, rejected: false, withdrawn: false },
  contributorNote: 'note', clientCorrelationId: 'corr-secret',
  createdAt: null, updatedAt: null, reviewedAt: null, withdrawnAt: null, revision: 'r1',
};

const ACTIVITY: ActivityEvent = {
  activityId: 'act-secret-1', projectId: 'proj-1', type: 'contribution_submitted',
  actor: { displayName: 'Ada', avatarUrl: null },
  subject: { versionId: null, contributionId: 'contrib-secret-1', membershipId: null, trackingId: null, commentId: null },
  occurredAt: '2026-08-05T00:00:00Z', revision: 'r2',
};

function mintMember(reg: MultiplayerRefRegistry, accountId = DID_A, epoch = 1, projectId = 'proj-1') {
  return reg.mint({ kind: 'member', serverId: MEMBER.membershipId, accountId, projectId, epoch });
}

describe('opaque reference isolation', () => {
  it('mints refs with the expected opaque shapes', () => {
    const reg = new MultiplayerRefRegistry();
    expect(mintMember(reg)).toMatch(/^pmember_[0-9a-z]{8}$/);
    expect(reg.mint({ kind: 'contrib', serverId: 'c', accountId: DID_A, projectId: 'proj-1', epoch: 1 }))
      .toMatch(/^pcontrib_[0-9a-z]{8}$/);
  });

  it('leaks no server id or DID inside the ref itself', () => {
    const reg = new MultiplayerRefRegistry();
    const ref = mintMember(reg);
    expect(ref).not.toContain('mem-secret-1');
    expect(ref).not.toContain('aaaa1111');
  });

  it('reuses one ref for the same member within a session', () => {
    const reg = new MultiplayerRefRegistry();
    expect(mintMember(reg)).toBe(mintMember(reg));
    expect(reg.size()).toBe(1);
  });

  it('resolves under the minting account, project, and epoch', () => {
    const reg = new MultiplayerRefRegistry();
    const ref = mintMember(reg);
    const r = reg.resolve(ref, { kind: 'member', accountId: DID_A, epoch: 1, projectId: 'proj-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binding.serverId).toBe('mem-secret-1');
  });

  it('never resolves under a different account', () => {
    const reg = new MultiplayerRefRegistry();
    const ref = mintMember(reg);
    const r = reg.resolve(ref, { kind: 'member', accountId: DID_B, epoch: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('account-mismatch');
  });

  it('never resolves with no active account', () => {
    const reg = new MultiplayerRefRegistry();
    const ref = mintMember(reg);
    expect(reg.resolve(ref, { kind: 'member', accountId: null, epoch: 1 }).ok).toBe(false);
  });

  it('never resolves against a different project', () => {
    const reg = new MultiplayerRefRegistry();
    const ref = mintMember(reg);
    const r = reg.resolve(ref, { kind: 'member', accountId: DID_A, epoch: 1, projectId: 'proj-OTHER' });
    expect(r.ok === false && r.reason).toBe('project-mismatch');
  });

  it('never resolves after the session epoch advances', () => {
    const reg = new MultiplayerRefRegistry();
    const ref = mintMember(reg);
    const r = reg.resolve(ref, { kind: 'member', accountId: DID_A, epoch: 2 });
    expect(r.ok === false && r.reason).toBe('stale-session');
  });

  it('never lets a member ref act as a contribution ref', () => {
    const reg = new MultiplayerRefRegistry();
    const ref = mintMember(reg);
    const r = reg.resolve(ref, { kind: 'contrib', accountId: DID_A, epoch: 1 });
    expect(r.ok === false && r.reason).toBe('wrong-kind');
  });

  it('rejects malformed and unknown refs', () => {
    const reg = new MultiplayerRefRegistry();
    mintMember(reg);
    for (const bad of ['', 'pmember_', 'mem-secret-1', 'pmember_TOOLONGREF', 42, null, undefined, {}]) {
      const r = reg.resolve(bad, { kind: 'member', accountId: DID_A, epoch: 1 });
      expect(r.ok).toBe(false);
    }
    const unknown = reg.resolve('pmember_zzzzzzzz', { kind: 'member', accountId: DID_A, epoch: 1 });
    expect(unknown.ok === false && unknown.reason).toBe('unknown-reference');
  });

  it('invalidates every ref on clear (logout / account switch)', () => {
    const reg = new MultiplayerRefRegistry();
    const ref = mintMember(reg);
    reg.clear();
    expect(reg.size()).toBe(0);
    expect(reg.resolve(ref, { kind: 'member', accountId: DID_A, epoch: 1 }).ok).toBe(false);
  });
});

describe('safe projections', () => {
  it('omits the canonical membership id and the DID', () => {
    const view = toSafeMembership('pmember_00000001', MEMBER);
    const json = JSON.stringify(view);
    expect(json).not.toContain('mem-secret-1');
    expect(json).not.toContain('did:privy');
    expect(view.ref).toBe('pmember_00000001');
  });

  it('keeps role and canContribute as separate fields', () => {
    const view = toSafeMembership('pmember_00000001', { ...MEMBER, role: 'comment', canContribute: false });
    expect(view.role).toBe('comment');
    expect(view.canContribute).toBe(false);
  });

  it('carries the raw state booleans alongside the display state', () => {
    const view = toSafeMembership('pmember_00000001', MEMBER);
    expect(view.state).toBe('active');
    expect(view.stateFlags).toEqual(MEMBER.state);
  });

  it('derives a display state with revoked/expired taking precedence', () => {
    expect(membershipDisplayState({ active: false, pending: true, declined: false, revoked: true, expired: false })).toBe('revoked');
    expect(membershipDisplayState({ active: false, pending: true, declined: false, revoked: false, expired: true })).toBe('expired');
    expect(membershipDisplayState({ active: false, pending: true, declined: false, revoked: false, expired: false })).toBe('pending');
    expect(membershipDisplayState({ active: false, pending: false, declined: false, revoked: false, expired: false })).toBe('unknown');
  });

  it('drops raw subject ids from activity, keeping only the subject kind', () => {
    const view = toSafeActivity(ACTIVITY);
    const json = JSON.stringify(view);
    expect(json).not.toContain('contrib-secret-1');
    expect(json).not.toContain('act-secret-1');
    expect(view.subjectKind).toBe('contribution');
    expect(view.type).toBe('contribution_submitted');
  });

  it('omits the contribution id, version ids, and correlation id', () => {
    const view = toSafeContribution('pcontrib_00000001', CONTRIB);
    const json = JSON.stringify(view);
    expect(json).not.toContain('contrib-secret-1');
    expect(json).not.toContain('corr-secret');
    expect(json).not.toContain('v-1');
    expect(view.state).toBe('submitted');
  });

  it('derives contribution display state from the booleans', () => {
    expect(contributionDisplayState({ submitted: true, accepted: false, rejected: false, withdrawn: true })).toBe('withdrawn');
    expect(contributionDisplayState({ submitted: false, accepted: true, rejected: false, withdrawn: false })).toBe('accepted');
    expect(contributionDisplayState({ submitted: false, accepted: false, rejected: false, withdrawn: false })).toBe('unknown');
  });

  it('has honest user-facing copy for every failure reason, with no raw server text', () => {
    for (const reason of [
      'offline', 'unauthorized', 'forbidden', 'rejected', 'not-found', 'conflict',
      'invite-expired', 'retryable', 'malformed', 'contribution-outcome-unknown', 'stale-session',
    ]) {
      const msg = MULTIPLAYER_FAILURE_MESSAGE[reason];
      expect(msg, reason).toBeTruthy();
      expect(msg).not.toMatch(/HTTP \d|stack|Bearer|did:privy/i);
    }
  });
});

describe('source invariants', () => {
  const root = path.resolve(__dirname, '..');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  it('the multiplayer service has no second HTTP implementation', () => {
    const src = read('electron/multiplayerService.ts');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toContain('Authorization');
    expect(src).not.toContain('X-Desktop-Action');
  });

  it('no multiplayer module sends sourceRestoreId', () => {
    for (const f of ['electron/multiplayerService.ts', 'electron/multiplayerRefs.ts']) {
      // Present only as the field being stripped/documented, never as a value sent.
      const src = read(f);
      const sends = src.match(/sourceRestoreId:\s*[^_\s]/g);
      expect(sends, f).toBeNull();
    }
  });

  it('the multiplayer assistant tools are implemented, not stubbed', () => {
    const src = read('electron/copilotTools/localTools.ts');
    for (const tool of ['invite_collaborator', 'inspect_collaborator_activity', 'publish_child_version']) {
      expect(src, tool).toContain(`name: '${tool}'`);
    }
    // Nothing is left declared as contract-blocked.
    expect(src).toContain('BLOCKED_CAPABILITIES: { name: string; description: string; reason: BlockedReason }[] = []');
  });

  it('no assistant tool reaches an IPC channel directly — only injected deps', () => {
    const src = read('electron/copilotTools/localTools.ts');
    expect(src).not.toContain('ipcRenderer');
    expect(src).not.toMatch(/invoke\(['"]multiplayer:/);
  });

  it('no multiplayer IPC result carries a raw absolute path', () => {
    const src = read('electron/multiplayerRefs.ts');
    expect(src).not.toMatch(/file_path|filePath|\/Users\//);
  });

  it('the contribution path reuses the single manifest builder', () => {
    const src = read('electron/main.ts');
    // Exactly one manifest builder definition, used by every publish path.
    const defs = src.match(/function buildPublishManifestBody/g) ?? [];
    expect(defs).toHaveLength(1);
    const uses = src.match(/buildPublishManifestBody\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4); // 1 definition + 3 call sites
  });
});
