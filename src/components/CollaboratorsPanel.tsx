/**
 * Project Detail → Collaborators (Multiplayer v1, P3-4).
 *
 * A thin presentational shell over src/lib/collaborationView.ts. All rules
 * (who may be removed, whether contribution is possible, what a lookup failure
 * means) live in that pure module and are unit-tested there.
 *
 * Boundary: everything rendered here arrives already-safe from the main process
 * — opaque refs plus display-only fields. There is no canonical DID, membership
 * id, or `invt_…` capability in this file, and none may be introduced.
 */

import { useCallback, useEffect, useState } from 'react';
import { UserPlus, Users, Search, ShieldAlert, Activity, GitBranch } from 'lucide-react';
import { api, type SafeCollaborator, type SafeActivity, type SafeContribution } from '../lib/api';
import { Button } from './ui/Button';
import { StatusBadge } from './ui/StatusBadge';
import { EmptyState } from './ui/EmptyState';
import { ErrorState } from './ui/ErrorState';
import { SectionHeader } from './ui/SectionHeader';
import { Skeleton } from './ui/Skeleton';
import {
  type ResolveState, type InviteRole,
  resolveStateText, resolveStateFromReason, isTargetExpired,
  contributionToggleEnabled, contributionHelpText, canSubmitInvite,
  collaboratorTone, COLLABORATOR_STATE_LABEL, permissionSummary,
  canRemoveCollaborator, sortRoster, roleChangeSupport, mutationOutcome,
  activityLine, activityFootnote,
  contributionActions, CONTRIBUTION_STATE_LABEL, contributionTone, lineageCaption,
} from '../lib/collaborationView';

const TONE_BADGE = {
  active: 'success', pending: 'warning', inactive: 'offline', unknown: 'local',
} as const;

interface Props {
  projectId: string;
  /** Whether the signed-in account owns this project (server-authoritative). */
  isOwner: boolean;
  /**
   * Reports ownership back once the roster resolves it. The server decides —
   * the parent starts as non-owner so owner-only controls never flash on
   * before truth arrives.
   */
  onOwnershipResolved?: (isOwner: boolean) => void;
}

export function CollaboratorsPanel({ projectId, isOwner, onOwnershipResolved }: Props) {
  const [roster, setRoster] = useState<SafeCollaborator[] | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; authRequired: boolean } | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);

  const [identifier, setIdentifier] = useState('');
  const [resolveState, setResolveState] = useState<ResolveState>({ kind: 'idle' });
  const [role, setRole] = useState<InviteRole>('view');
  const [wantContribute, setWantContribute] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);

  const loadRoster = useCallback(async () => {
    setLoadError(null);
    const res = await api.multiplayer.listCollaborators({ projectId });
    if (!res.ok) {
      setRoster([]);
      setLoadError({ message: res.error ?? 'Collaborators could not be loaded.', authRequired: res.reason === 'unauthorized' });
      return;
    }
    const rows = res.collaborators ?? [];
    setRoster(sortRoster(rows));
    // The server only returns full roster rows to the owner, and marks the
    // owner's own row `role: 'owner'`. Anything else is not ownership.
    onOwnershipResolved?.(rows.some((c) => c.role === 'owner'));
  }, [projectId, onOwnershipResolved]);

  useEffect(() => { void loadRoster(); }, [loadRoster]);

  // Resolution is rate-limited server-side, so it runs ONLY from this explicit
  // submit — never on keystroke, blur, or mount.
  const onFind = useCallback(async () => {
    setInviteError(null);
    setInviteNotice(null);
    setResolveState({ kind: 'resolving' });
    const res = await api.multiplayer.resolveInviteTarget({ projectId, identifier });
    if (!res.ok) { setResolveState(resolveStateFromReason(res.reason, res.error)); return; }
    if (!res.resolved || !res.target) { setResolveState({ kind: 'unresolved' }); return; }
    setResolveState({
      kind: 'resolved',
      ref: res.target.ref,
      displayName: res.target.displayName,
      avatarUrl: res.target.avatarUrl,
      expiresAtMs: res.target.expiresAtMs,
    });
  }, [projectId, identifier]);

  const onInvite = useCallback(async () => {
    if (resolveState.kind !== 'resolved') return;
    if (isTargetExpired(resolveState)) {
      setResolveState({ kind: 'idle' });
      setInviteError('That lookup expired. Search again.');
      return;
    }
    setInviteError(null);
    const res = await api.multiplayer.inviteCollaborator({
      projectId, targetRef: resolveState.ref, role, canContribute: wantContribute,
    });
    if (!res.ok) { setInviteError(res.error ?? 'The invitation could not be sent.'); return; }
    setInviteNotice(res.alreadyInvited
      ? 'They already had a pending invitation — nothing changed.'
      : 'Invitation sent. They must accept before they get access.');
    setIdentifier('');
    setResolveState({ kind: 'idle' });
    setWantContribute(false);
    await loadRoster();          // never optimistic: re-read server truth
  }, [projectId, resolveState, role, wantContribute, loadRoster]);

  const onRemove = useCallback(async (ref: string) => {
    setBusyRef(ref);
    const res = await api.multiplayer.revokeCollaborator({ ref });
    setBusyRef(null);
    const outcome = mutationOutcome(res);
    if (outcome.kind === 'failed') { setInviteError(outcome.message); return; }
    await loadRoster();
  }, [loadRoster]);

  const roleNote = roleChangeSupport();
  const targetExpired = isTargetExpired(resolveState);

  return (
    <div className="p-5 space-y-6">
      {isOwner && (
        <section>
          <SectionHeader label="Invite a collaborator" />
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-muted-fg absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden />
              <input
                value={identifier}
                onChange={(e) => { setIdentifier(e.target.value); setResolveState({ kind: 'idle' }); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && identifier.trim()) void onFind(); }}
                placeholder="Email or @handle"
                aria-label="Collaborator email or handle"
                className="w-full bg-surface-2 border border-border rounded-lg pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-fg focus:outline-none focus:border-primary/40"
              />
            </div>
            <Button
              variant="secondary" size="compact"
              onClick={() => void onFind()}
              loading={resolveState.kind === 'resolving'}
              disabled={!identifier.trim() || resolveState.kind === 'resolving'}
            >
              Find collaborator
            </Button>
          </div>

          {resolveState.kind !== 'idle' && resolveState.kind !== 'resolved' && (
            <p className={`mt-2 text-[11px] ${resolveState.kind === 'resolving' ? 'text-muted-fg' : 'text-warning'}`} role="status">
              {resolveStateText(resolveState)}
            </p>
          )}

          {resolveState.kind === 'resolved' && (
            <div className="mt-3 rounded-lg border border-border bg-surface-2 p-3 space-y-3">
              <div className="flex items-center gap-2">
                {resolveState.avatarUrl
                  ? <img src={resolveState.avatarUrl} alt="" className="w-6 h-6 rounded-full object-cover" />
                  : <div className="w-6 h-6 rounded-full bg-white/[0.06] border border-border" aria-hidden />}
                <span className="text-xs text-foreground">{resolveState.displayName ?? 'Wavi account'}</span>
                {targetExpired && <span className="text-[10px] text-warning ml-auto">Lookup expired — search again</span>}
              </div>

              <div className="flex items-center gap-4">
                <label className="flex items-center gap-1.5 text-[11px] text-foreground/70">
                  Role
                  <select
                    value={role}
                    onChange={(e) => {
                      const next = e.target.value as InviteRole;
                      setRole(next);
                      // `view` can never contribute — clear rather than send a
                      // request the server would silently downgrade.
                      if (!contributionToggleEnabled(next)) setWantContribute(false);
                    }}
                    className="bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground"
                  >
                    <option value="view">View</option>
                    <option value="comment">Comment</option>
                  </select>
                </label>
                <label className={`flex items-center gap-1.5 text-[11px] ${contributionToggleEnabled(role) ? 'text-foreground/70' : 'text-muted-fg'}`}>
                  <input
                    type="checkbox"
                    checked={wantContribute}
                    disabled={!contributionToggleEnabled(role)}
                    onChange={(e) => setWantContribute(e.target.checked)}
                  />
                  Can contribute versions
                </label>
              </div>
              <p className="text-[10px] text-muted-fg">{contributionHelpText(role)}</p>

              <Button
                variant="primary" size="compact"
                onClick={() => void onInvite()}
                disabled={!canSubmitInvite(resolveState)}
              >
                Invite
              </Button>
            </div>
          )}

          {inviteError && <p className="mt-2 text-[11px] text-destructive" role="alert">{inviteError}</p>}
          {inviteNotice && <p className="mt-2 text-[11px] text-success" role="status">{inviteNotice}</p>}
        </section>
      )}

      <section>
        <SectionHeader label="Collaborators" count={roster?.length ?? undefined} />
        {roster === null ? (
          <div className="space-y-2" aria-busy><Skeleton lines={3} /></div>
        ) : loadError ? (
          loadError.authRequired
            ? <EmptyState icon={ShieldAlert} title="Sign in to Wavi" description="Collaborators are only available when you're signed in." />
            : <ErrorState description={loadError.message} onRetry={() => void loadRoster()} />
        ) : roster.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No collaborators yet"
            description={isOwner ? 'Find someone by email or @handle to invite them.' : 'Only the project owner can invite collaborators.'}
          />
        ) : (
          <ul className="space-y-1.5">
            {roster.map((c) => (
              <li key={c.ref} className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
                {c.avatarUrl
                  ? <img src={c.avatarUrl} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
                  : <div className="w-6 h-6 rounded-full bg-white/[0.06] border border-border flex-shrink-0" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-foreground truncate">{c.displayName ?? 'Wavi account'}</div>
                  <div className="text-[10px] text-muted-fg">{permissionSummary(c)}</div>
                </div>
                <StatusBadge tone={TONE_BADGE[collaboratorTone(c.state)]} label={COLLABORATOR_STATE_LABEL[c.state]} />
                {canRemoveCollaborator(c, isOwner) && (
                  <Button
                    variant="ghost" size="compact"
                    loading={busyRef === c.ref}
                    onClick={() => void onRemove(c.ref)}
                    aria-label={`Remove ${c.displayName ?? 'collaborator'}`}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {roster && roster.length > 0 && isOwner && (
          <p className="mt-2 text-[10px] text-muted-fg flex items-start gap-1.5">
            <UserPlus className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden />
            {roleNote.explanation}
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * Server-authoritative collaborator activity. Separate from the existing local
 * activity list, which records this machine's own sync/publish events.
 */
export function CollaboratorActivityFeed({ projectId }: { projectId: string }) {
  const [events, setEvents] = useState<SafeActivity[] | null>(null);
  const [meta, setMeta] = useState<{ pageComplete: boolean; skipped: number }>({ pageComplete: true, skipped: 0 });
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(20);

  const load = useCallback(async (n: number) => {
    setError(null);
    const res = await api.multiplayer.listActivity({ projectId, limit: n });
    if (!res.ok) { setEvents([]); setError(res.error ?? 'Activity could not be loaded.'); return; }
    setEvents(res.events ?? []);
    setMeta({ pageComplete: res.pageComplete !== false, skipped: res.skippedUnknownEvents ?? 0 });
  }, [projectId]);

  useEffect(() => { void load(limit); }, [load, limit]);

  const footnote = activityFootnote(meta.pageComplete, meta.skipped);

  return (
    <section>
      <SectionHeader label="Collaborator activity" count={events?.length ?? undefined} />
      {events === null ? (
        <div aria-busy><Skeleton lines={3} /></div>
      ) : error ? (
        <ErrorState description={error} onRetry={() => void load(limit)} />
      ) : events.length === 0 ? (
        <EmptyState icon={Activity} title="No collaborator activity yet"
          description="Invitations, published versions and contributions will appear here." />
      ) : (
        <>
          <ul className="space-y-1">
            {events.map((e, i) => (
              <li key={`${e.occurredAt ?? ''}-${i}`} className="flex items-start gap-2 py-1.5 border-b border-border-subtle last:border-0">
                <span className="text-[10px] text-muted-fg w-32 flex-shrink-0 font-mono">
                  {e.occurredAt ? new Date(e.occurredAt).toLocaleString() : ''}
                </span>
                <span className="text-[11px] text-foreground/60 min-w-0">{activityLine(e)}</span>
              </li>
            ))}
          </ul>
          {!meta.pageComplete && (
            <Button variant="ghost" size="compact" className="mt-2" onClick={() => setLimit((n) => Math.min(100, n + 20))}>
              Load more
            </Button>
          )}
          {footnote && <p className="mt-2 text-[10px] text-muted-fg">{footnote}</p>}
        </>
      )}
    </section>
  );
}

/**
 * Child-version contributions with their lineage and review controls.
 *
 * Nothing is applied optimistically: every control re-reads server truth after
 * the mutation, and a 409 reconciles rather than reporting a fabricated success.
 */
export function ContributionsList({
  projectId, contributions, isOwner, onChanged,
}: {
  projectId: string;
  contributions: SafeContribution[];
  isOwner: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const act = useCallback(async (ref: string, action: 'accept' | 'reject' | 'withdraw') => {
    setBusy(ref); setNotice(null);
    const res = action === 'withdraw'
      ? await api.multiplayer.withdrawContribution({ ref })
      : await api.multiplayer.respondContribution({ ref, accept: action === 'accept' });
    setBusy(null);
    const outcome = mutationOutcome(res);
    if (outcome.kind === 'failed') { setNotice(outcome.message); return; }
    if (outcome.kind === 'reconcile') setNotice(outcome.message);
    else if (outcome.alreadyResolved) setNotice('That was already decided — nothing changed.');
    await onChanged();
  }, [onChanged]);

  if (!contributions.length) {
    return (
      <EmptyState icon={GitBranch} title="No contributions"
        description="Versions submitted by collaborators for review will appear here." />
    );
  }

  return (
    <div className="space-y-2">
      {contributions.map((c) => {
        const actions = contributionActions(c, { isOwner, isContributor: !isOwner });
        const caption = lineageCaption({ parentVersionLabel: null, isContribution: true, state: c.state });
        return (
          <div key={c.ref} className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <GitBranch className="w-3.5 h-3.5 text-primary/50 flex-shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-foreground/80">{caption}</p>
                {c.contributorNote && <p className="text-[11px] text-foreground/55 mt-0.5">{c.contributorNote}</p>}
                <p className="text-[10px] text-muted-fg font-mono mt-0.5">
                  {c.createdAt ? new Date(c.createdAt).toLocaleString() : ''}
                </p>
              </div>
              <StatusBadge tone={TONE_BADGE[contributionTone(c.state)]} label={CONTRIBUTION_STATE_LABEL[c.state]} />
            </div>
            {actions.length > 0 && (
              <div className="flex gap-2 mt-2">
                {actions.includes('accept') && (
                  <Button variant="primary" size="compact" loading={busy === c.ref} onClick={() => void act(c.ref, 'accept')}>Accept</Button>
                )}
                {actions.includes('reject') && (
                  <Button variant="secondary" size="compact" loading={busy === c.ref} onClick={() => void act(c.ref, 'reject')}>Reject</Button>
                )}
                {actions.includes('withdraw') && (
                  <Button variant="ghost" size="compact" loading={busy === c.ref} onClick={() => void act(c.ref, 'withdraw')}>Withdraw</Button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {notice && <p className="text-[11px] text-warning" role="status">{notice}</p>}
      <p className="text-[10px] text-muted-fg">
        A contribution is a new child version. Accepting or rejecting it never changes the version it was based on.
      </p>
    </div>
  );
}
