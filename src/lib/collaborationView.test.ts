/**
 * Pure collaboration view-model (P3-4). Every rule here mirrors the locked
 * server contract; the React shell only renders what these functions decide.
 */
import { describe, it, expect } from 'vitest';
import {
  UNRESOLVED_TEXT, resolveStateText, resolveStateFromReason, isTargetExpired,
  contributionToggleEnabled, effectiveCanContribute, contributionHelpText, canSubmitInvite,
  collaboratorTone, COLLABORATOR_STATE_LABEL, permissionSummary, canRemoveCollaborator,
  sortRoster, roleChangeSupport, ACTIVITY_LABEL, activityLine, activityFootnote,
  contributionActions, CONTRIBUTION_STATE_LABEL, contributionTone, lineageCaption,
  mutationOutcome, type ResolveState,
} from './collaborationView';
import type { SafeCollaborator, SafeActivity } from './api';

function collab(o: Partial<SafeCollaborator> = {}): SafeCollaborator {
  return {
    ref: 'pmember_00000001', projectId: 'p1', role: 'view', canContribute: false,
    state: 'active',
    stateFlags: { active: true, pending: false, declined: false, revoked: false, expired: false },
    displayName: 'Ada', avatarUrl: null,
    createdAt: null, updatedAt: null, acceptedAt: null, expiresAt: null, revision: null, ...o,
  };
}

describe('resolution states', () => {
  it('has exactly one message for a non-resolving lookup', () => {
    expect(UNRESOLVED_TEXT).toBe('No inviteable Wavi account found.');
    expect(resolveStateText({ kind: 'unresolved' })).toBe(UNRESOLVED_TEXT);
  });

  it('never distinguishes a hidden account from a nonexistent one', () => {
    // Both paths land on the SAME state and therefore the same words.
    const a = resolveStateText({ kind: 'unresolved' });
    const b = resolveStateText({ kind: 'unresolved' });
    expect(a).toBe(b);
    expect(a).not.toMatch(/hidden|private|not discoverable|exists/i);
  });

  it('maps failure reasons to distinct honest states', () => {
    expect(resolveStateFromReason('rate-limited').kind).toBe('rate-limited');
    expect(resolveStateFromReason('offline').kind).toBe('offline');
    expect(resolveStateFromReason('unauthorized').kind).toBe('auth-required');
    expect(resolveStateFromReason('weird', 'boom')).toEqual({ kind: 'error', message: 'boom' });
  });

  it('a rate limit tells the user to wait rather than retry', () => {
    expect(resolveStateText({ kind: 'rate-limited' })).toMatch(/wait a few minutes/i);
  });

  it('a resolved target expires with the server TTL', () => {
    const s: ResolveState = { kind: 'resolved', ref: 'pinvite_1', displayName: 'Ada', avatarUrl: null, expiresAtMs: 1_000 };
    expect(isTargetExpired(s, 999)).toBe(false);
    expect(isTargetExpired(s, 1_000)).toBe(true);
    expect(canSubmitInvite(s, 999)).toBe(true);
    expect(canSubmitInvite(s, 1_000)).toBe(false);
  });

  it('an unresolved state can never be invited from', () => {
    expect(canSubmitInvite({ kind: 'unresolved' })).toBe(false);
    expect(canSubmitInvite({ kind: 'idle' })).toBe(false);
    expect(canSubmitInvite({ kind: 'rate-limited' })).toBe(false);
  });
});

describe('invite form rules', () => {
  it('only a comment collaborator may contribute', () => {
    expect(contributionToggleEnabled('comment')).toBe(true);
    expect(contributionToggleEnabled('view')).toBe(false);
  });

  it('a view invite can never carry contribution, even if requested', () => {
    expect(effectiveCanContribute('view', true)).toBe(false);
    expect(effectiveCanContribute('comment', true)).toBe(true);
    expect(effectiveCanContribute('comment', false)).toBe(false);
  });

  it('explains why the toggle is unavailable for view', () => {
    expect(contributionHelpText('view')).toMatch(/only a “comment” collaborator/i);
    expect(contributionHelpText('comment')).toMatch(/submit new versions/i);
  });
});

describe('roster', () => {
  it('maps every state to a tone and a label', () => {
    for (const s of ['active', 'pending', 'declined', 'revoked', 'expired', 'unknown'] as const) {
      expect(collaboratorTone(s)).toBeTruthy();
      expect(COLLABORATOR_STATE_LABEL[s]).toBeTruthy();
    }
    expect(collaboratorTone('pending')).toBe('pending');
    expect(collaboratorTone('revoked')).toBe('inactive');
  });

  it('summarizes role and contribution separately', () => {
    expect(permissionSummary({ role: 'view', canContribute: false })).toBe('Can view');
    expect(permissionSummary({ role: 'comment', canContribute: false })).toBe('Can comment');
    expect(permissionSummary({ role: 'comment', canContribute: true })).toBe('Can comment · can contribute versions');
    expect(permissionSummary({ role: 'owner', canContribute: true })).toBe('Owner');
  });

  it('the owner row can never be removed (the server 409s)', () => {
    expect(canRemoveCollaborator({ role: 'owner', state: 'active' }, true)).toBe(false);
  });

  it('a non-owner viewer gets no remove control', () => {
    expect(canRemoveCollaborator({ role: 'view', state: 'active' }, false)).toBe(false);
    expect(canRemoveCollaborator({ role: 'view', state: 'active' }, true)).toBe(true);
  });

  it('an already-revoked row offers no remove control', () => {
    expect(canRemoveCollaborator({ role: 'view', state: 'revoked' }, true)).toBe(false);
  });

  it('sorts owner, then active, pending, inactive', () => {
    const rows = [
      collab({ ref: 'a', state: 'revoked', displayName: 'Zoe' }),
      collab({ ref: 'b', state: 'pending', displayName: 'Bo' }),
      collab({ ref: 'c', role: 'owner', displayName: 'Owner' }),
      collab({ ref: 'd', state: 'active', displayName: 'Ann' }),
    ];
    expect(sortRoster(rows).map((r) => r.ref)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('does not offer role editing the contract cannot perform', () => {
    const s = roleChangeSupport();
    expect(s.supported).toBe(false);
    expect(s.explanation).toMatch(/remove this collaborator and invite them again/i);
  });
});

describe('activity', () => {
  const ev = (o: Partial<SafeActivity> = {}): SafeActivity => ({
    projectId: 'p1', type: 'version_published', displayName: 'Ada', avatarUrl: null,
    subjectKind: 'version', occurredAt: null, revision: null, ...o,
  });

  it('has a label for every value of the closed enum', () => {
    for (const t of [
      'collaborator_invited', 'collaborator_joined', 'collaborator_removed', 'version_published',
      'contribution_submitted', 'contribution_accepted', 'contribution_rejected', 'contribution_withdrawn',
    ] as const) {
      expect(ACTIVITY_LABEL[t], t).toBeTruthy();
    }
  });

  it('renders a compact line with a safe actor', () => {
    expect(activityLine(ev())).toBe('Ada published a version');
    expect(activityLine(ev({ displayName: null }))).toBe('Someone published a version');
  });

  it('discloses partial pages and undescribable events, and stays silent otherwise', () => {
    expect(activityFootnote(true, 0)).toBeNull();
    expect(activityFootnote(false, 0)).toMatch(/more activity/i);
    expect(activityFootnote(true, 1)).toMatch(/1 newer event could not be shown/);
    expect(activityFootnote(true, 3)).toMatch(/3 newer events could not be shown/);
  });
});

describe('contributions + lineage', () => {
  it('only a submitted contribution is actionable', () => {
    for (const state of ['accepted', 'rejected', 'withdrawn', 'unknown'] as const) {
      expect(contributionActions({ state }, { isOwner: true, isContributor: true })).toEqual([]);
    }
  });

  it('the owner reviews; the contributor withdraws', () => {
    expect(contributionActions({ state: 'submitted' }, { isOwner: true, isContributor: false })).toEqual(['accept', 'reject']);
    expect(contributionActions({ state: 'submitted' }, { isOwner: false, isContributor: true })).toEqual(['withdraw']);
  });

  it('labels and tones every contribution state', () => {
    for (const s of ['submitted', 'accepted', 'rejected', 'withdrawn', 'unknown'] as const) {
      expect(CONTRIBUTION_STATE_LABEL[s], s).toBeTruthy();
      expect(contributionTone(s), s).toBeTruthy();
    }
    expect(contributionTone('submitted')).toBe('pending');
  });

  it('describes lineage relative to the parent, never as a modification', () => {
    expect(lineageCaption({ parentVersionLabel: 'v12', isContribution: false })).toBe('Based on v12');
    expect(lineageCaption({ parentVersionLabel: 'v12', isContribution: true, state: 'accepted' }))
      .toBe('Based on v12 · Contribution · Accepted');
    expect(lineageCaption({ parentVersionLabel: null, isContribution: true, state: 'rejected' }))
      .toBe('Contribution · Rejected');
    expect(lineageCaption({ parentVersionLabel: null, isContribution: false })).toBeNull();
  });

  it('a lineage caption never claims the parent changed', () => {
    const caption = lineageCaption({ parentVersionLabel: 'v12', isContribution: true, state: 'accepted' })!;
    expect(caption).not.toMatch(/overwrit|replac|modif|edit/i);
  });
});

describe('mutation outcomes (never optimistic)', () => {
  it('applies only on explicit server confirmation', () => {
    expect(mutationOutcome({ ok: true })).toEqual({ kind: 'applied', alreadyResolved: false });
    expect(mutationOutcome({ ok: true, alreadyResolved: true })).toEqual({ kind: 'applied', alreadyResolved: true });
    expect(mutationOutcome({ ok: true, alreadyRevoked: true })).toEqual({ kind: 'applied', alreadyResolved: true });
  });

  it('a 409 reconciles rather than reporting success', () => {
    const o = mutationOutcome({ reason: 'conflict', error: 'no longer submitted' });
    expect(o.kind).toBe('reconcile');
  });

  it('any other failure is a failure, never a silent success', () => {
    expect(mutationOutcome({ reason: 'offline', error: 'offline' }).kind).toBe('failed');
    expect(mutationOutcome({}).kind).toBe('failed');
  });
});
