import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Link2, Copy, Check, ExternalLink, Pencil, Ban, RefreshCw, Loader2,
  AlertTriangle, CopyPlus, X, WifiOff,
} from 'lucide-react';
import { api, LinkListItem } from '../lib/api';
import { canDuplicate, linkDisplayName, CAPABILITY_LABELS, linkCapabilities } from '../lib/linksView';
import { ProjectLinkClient, type LinkView } from '../lib/projectLinkClient';
import { createProjectLinkClient, sharedAccountResolver } from '../lib/projectLinkClientFactory';
import {
  LINK_STATE_PRESENTATION, LINK_GROUP_META, LINK_GROUP_ORDER,
  type LinkGroup, type LinkResult,
} from '../lib/projectLinks';
import { PageHeader } from '../components/ui/PageHeader';
import { Surface } from '../components/ui/Surface';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Skeleton } from '../components/ui/Skeleton';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Translate a typed LinkResult into an honest, user-facing sentence. */
function describeResult(r: LinkResult): string | null {
  switch (r.kind) {
    case 'confirmed': return null;
    case 'offline': return "You appear to be offline. Nothing was changed on the server — try again when you're back online.";
    case 'unauthorized': return 'Your session is not authorized. Sign in again and retry.';
    case 'rejected': return `The server rejected the request: ${r.message}`;
    case 'retryable': return `Temporary server problem: ${r.message}. Try again shortly.`;
    case 'unsupported': return `Not supported yet: ${r.message}`;
    case 'malformed': return 'The server response could not be confirmed, so nothing is shown as done.';
    case 'permanent': return r.message;
  }
}

export function LinksPage({ visible }: { visible?: boolean }) {
  const clientRef = useRef<ProjectLinkClient | null>(null);
  if (!clientRef.current) clientRef.current = createProjectLinkClient();
  const client = clientRef.current;

  const [views, setViews] = useState<LinkView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'listen' | 'project'>('all');
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<LinkListItem | null>(null);
  const [dupAllowDownload, setDupAllowDownload] = useState(true);
  const [dupMode, setDupMode] = useState<'view' | 'comment'>('view');

  const refresh = useCallback(async () => {
    try {
      setLoadError(null);
      // Pull authoritative server state first (paginated, account-scoped); the
      // main process persists reconciliation + stamps account ownership. Failure
      // here is non-fatal — we still render the last-known local cache.
      await api.projectLinks.reconcile().catch(() => undefined);
      const rows = await client.list(); // account-scoped, honest per-record state
      setViews(rows);
    } catch (e) {
      setLoadError((e as Error)?.message ?? 'Could not load links');
      setViews([]);
    }
  }, [client]);

  useEffect(() => { if (visible) refresh(); }, [visible, refresh]);

  // Track connectivity so states flip to/from `offline` honestly.
  useEffect(() => {
    const on = () => { setOnline(true); refresh(); };
    const off = () => { setOnline(false); refresh(); };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (views ?? []).filter((v) => {
      if (kindFilter !== 'all' && v.record.kind !== kindFilter) return false;
      if (!q) return true;
      const hay = `${v.record.label ?? ''} ${v.record.project_name ?? ''} ${v.record.url}`.toLowerCase();
      return hay.includes(q);
    });
  }, [views, query, kindFilter]);

  const grouped = useMemo(() => {
    const g: Record<LinkGroup, LinkView[]> = { active: [], 'needs-attention': [], expired: [], revoked: [] };
    for (const v of filtered) g[v.group].push(v);
    return g;
  }, [filtered]);

  const handleCopy = async (link: LinkListItem) => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(link.tracking_id);
      setTimeout(() => setCopied(null), 1500);
    } catch { setActionError('Could not copy to clipboard.'); }
  };

  const handleRenameCommit = async (trackingId: string) => {
    const label = editValue.trim() || null;
    setEditing(null);
    const result = await api.links.rename({ trackingId, label });
    if (result?.error) setActionError(`Rename failed: ${result.error}`);
    await refresh();
  };

  const handleRevoke = async (trackingId: string) => {
    setConfirmRevoke(null);
    setBusy(trackingId);
    try {
      const kind = views?.find((v) => v.record.tracking_id === trackingId)?.record.kind;
      if (kind === 'listen') {
        // Listen links are OUTSIDE the Project Link contract — legacy share path.
        const r = await api.links.revoke({ trackingId });
        if (r?.error) setActionError(`Revoke failed: ${r.error}`);
      } else {
        const result = await client.revoke(trackingId); // authoritative; never false success
        const msg = describeResult(result);
        if (msg) setActionError(msg);
      }
      await refresh();
    } finally { setBusy(null); }
  };

  const handleDuplicate = async () => {
    if (!duplicating) return;
    setBusy(duplicating.tracking_id);
    try {
      let msg: string | null = null;
      if (duplicating.kind === 'listen' && duplicating.asset_id) {
        const r = await api.share.createLink({
          assetId: duplicating.asset_id,
          projectId: duplicating.project_id ?? undefined,
          allowDownload: dupAllowDownload,
        });
        if (r.error) msg = `Duplicate failed: ${r.error}`;
      } else if (duplicating.kind === 'project' && duplicating.project_id) {
        const result = await client.create({
          projectId: duplicating.project_id,
          allowDownload: dupAllowDownload,
          collaboratorMode: dupMode,
        });
        msg = describeResult(result);
      }
      if (msg) setActionError(msg);
      setDuplicating(null);
      await refresh();
    } finally { setBusy(null); }
  };

  const total = views?.length ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-4xl mx-auto space-y-5">
        <PageHeader
          title="Links"
          subtitle="Links created on this computer. Status reflects what this device knows — the server is the source of truth for live access. Links created or revoked elsewhere appear once cloud link sync arrives."
          status={!online
            ? <StatusBadge tone="offline" label="Offline" title="Showing last known local state" />
            : undefined}
          actions={
            <Button variant="secondary" size="compact" onClick={refresh} aria-label="Refresh links">
              <RefreshCw className="w-4 h-4" /> Refresh
            </Button>
          }
        />

        {/* Account attribution status (P3-2b prep): honest, non-alarming note while
            the canonical account-identity contract is pending. Records stay
            device-scoped and ownership-unknown until it lands. */}
        {sharedAccountResolver.current().kind === 'missing-account-context' && total > 0 && (
          <Surface variant="inset" className="border border-white/5 px-4 py-2.5">
            <p className="text-[11px] text-white/35 leading-relaxed">
              Account attribution isn't available yet, so these records are scoped to this
              computer rather than to your account. Ownership can't be verified per record
              until account-aware link sync arrives.
            </p>
          </Surface>
        )}

        {actionError && (
          <Surface variant="inset" className="border border-destructive/20 px-4 py-3 flex items-center gap-3">
            <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0" />
            <p className="flex-1 text-xs text-destructive/80">{actionError}</p>
            <button onClick={() => setActionError(null)} className="text-white/30 hover:text-white/60" aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </Surface>
        )}

        {/* Search + type filter */}
        {total > 0 && (
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by label, project or URL…"
              className="flex-1 bg-surface-inset border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder:text-white/20 focus:outline-none focus:border-primary/40"
            />
            <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as any)}
              className="bg-surface-inset border border-white/10 rounded-lg px-2 py-2 text-xs text-white/60">
              <option value="all">All types</option>
              <option value="listen">Listen Links</option>
              <option value="project">Project Links</option>
            </select>
          </div>
        )}

        {/* Loading */}
        {views === null && !loadError && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
          </div>
        )}

        {loadError && (
          <ErrorState
            title="Couldn't load your links"
            description={loadError}
            onRetry={refresh}
          />
        )}

        {/* Empty */}
        {views !== null && !loadError && total === 0 && (
          <EmptyState
            icon={Link2}
            title="No links yet"
            description="Create a Listen Link or Project Link from a synced project, and it will appear here."
          />
        )}

        {/* No match */}
        {views !== null && total > 0 && filtered.length === 0 && (
          <p className="text-center text-xs text-white/25 py-10">No links match the current search or filters.</p>
        )}

        {/* Grouped rows */}
        {LINK_GROUP_ORDER.map((group) => {
          const rows = grouped[group];
          if (!rows.length) return null;
          const meta = LINK_GROUP_META[group];
          return (
            <section key={group} className="space-y-2">
              <div className="flex items-baseline gap-2">
                <h2 className="text-sm font-semibold text-white/80">{meta.title}</h2>
                <span className="text-[10px] text-white/25">{rows.length}</span>
                <span className="text-[10px] text-white/25">· {meta.hint}</span>
              </div>
              <div className="space-y-2">
                {rows.map((v) => {
                  const link = v.record as LinkListItem;
                  const pres = LINK_STATE_PRESENTATION[v.state];
                  const isBusy = busy === link.tracking_id;
                  const inactive = group === 'expired' || group === 'revoked';
                  const caps = linkCapabilities(link);
                  return (
                    <Surface key={link.tracking_id} variant="base"
                      className={`border border-white/5 p-4 ${inactive ? 'opacity-60' : 'hover:border-white/10'} transition-colors`}>
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          {editing === link.tracking_id ? (
                            <div className="flex items-center gap-2">
                              <input autoFocus value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleRenameCommit(link.tracking_id); if (e.key === 'Escape') setEditing(null); }}
                                placeholder="Internal label (only you see this)"
                                className="flex-1 bg-black/40 border border-primary/30 rounded px-2 py-1 text-sm text-white/90 focus:outline-none" />
                              <button onClick={() => handleRenameCommit(link.tracking_id)} className="text-[10px] text-primary">Save</button>
                              <button onClick={() => setEditing(null)} className="text-[10px] text-white/30">Cancel</button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 min-w-0">
                              <p className="text-sm font-medium text-white/85 truncate">{linkDisplayName(link)}</p>
                              <button
                                onClick={() => { setEditing(link.tracking_id); setEditValue(link.label ?? ''); }}
                                title="Rename internal label (stored on this computer)"
                                className="text-white/20 hover:text-white/60 flex-shrink-0" aria-label="Rename label">
                                <Pencil className="w-3 h-3" />
                              </button>
                            </div>
                          )}
                          <p className="text-[10px] text-white/20 font-mono truncate mt-0.5">{link.url}</p>

                          <div className="flex flex-wrap items-center gap-2 mt-2">
                            <StatusBadge tone={pres.tone} label={pres.label} title={pres.note} />
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-primary/10 text-primary/80">
                              {link.kind === 'project' ? 'Project Link' : 'Listen Link'}
                            </span>
                            {caps.map((c) => (
                              <span key={c} className="px-1.5 py-0.5 rounded text-[10px] bg-white/5 text-white/40">{CAPABILITY_LABELS[c] ?? c}</span>
                            ))}
                          </div>

                          {/* Honest per-state note */}
                          <p className="text-[10px] text-white/30 mt-1.5 leading-relaxed">{pres.note}</p>

                          <div className="flex items-center gap-4 mt-2 text-[10px] text-white/25">
                            <span>Created {formatDate(link.created_at)}</span>
                            <span>Expires {link.expires_at ? formatDate(link.expires_at) : 'never'}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button onClick={() => handleCopy(link)} disabled={inactive}
                            title={inactive ? 'Link is no longer active' : 'Copy link'} aria-label="Copy link"
                            className="p-1.5 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 disabled:opacity-30 transition-colors">
                            {copied === link.tracking_id ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => api.shell.openExternal(link.url)} title="Open public page" aria-label="Open public page"
                            className="p-1.5 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 transition-colors">
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => {
                              setDuplicating(link);
                              setDupAllowDownload(!!link.allow_download);
                              // Coerce legacy cached modes (e.g. 'edit') to a server-supported one.
                              setDupMode(link.collaborator_mode === 'comment' ? 'comment' : 'view');
                            }}
                            disabled={!canDuplicate(link) || isBusy}
                            title={canDuplicate(link) ? 'Duplicate with different permissions' : 'Duplicate unavailable for links created before this version'}
                            aria-label="Duplicate link"
                            className="p-1.5 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 disabled:opacity-30 transition-colors">
                            <CopyPlus className="w-3.5 h-3.5" />
                          </button>
                          {group !== 'revoked' && (
                            <button onClick={() => setConfirmRevoke(link.tracking_id)} disabled={isBusy || !online}
                              title={online ? 'Revoke link' : 'Revoking needs a connection'} aria-label="Revoke link"
                              className="p-1.5 rounded-lg hover:bg-destructive/10 text-white/30 hover:text-destructive disabled:opacity-30 transition-colors">
                              {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : !online ? <WifiOff className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                            </button>
                          )}
                        </div>
                      </div>
                    </Surface>
                  );
                })}
              </div>
            </section>
          );
        })}

        {/* Revoke confirmation */}
        {confirmRevoke && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="dialog" aria-modal="true">
            <Surface variant="elevated" className="border border-destructive/30 p-5 max-w-sm mx-4 space-y-4">
              <div className="flex items-start gap-3">
                <Ban className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-white/90">Revoke this link?</p>
                  <p className="text-xs text-white/50 mt-1 leading-relaxed">
                    This asks the server to revoke access. Once the server confirms, anyone with this link
                    loses access immediately. This can't be undone — you can create a new link later.
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="compact" onClick={() => setConfirmRevoke(null)}>Cancel</Button>
                <Button variant="destructive" size="compact" onClick={() => handleRevoke(confirmRevoke)}>Revoke Link</Button>
              </div>
            </Surface>
          </div>
        )}

        {/* Duplicate dialog */}
        {duplicating && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="dialog" aria-modal="true">
            <Surface variant="elevated" className="border border-primary/30 p-5 max-w-sm mx-4 space-y-4">
              <p className="text-sm font-semibold text-white/90">Duplicate link with different permissions</p>
              <label className="flex items-center justify-between text-xs text-white/60">
                Allow download
                <input type="checkbox" checked={dupAllowDownload} onChange={(e) => setDupAllowDownload(e.target.checked)} />
              </label>
              {duplicating.kind === 'project' && (
                <label className="flex items-center justify-between text-xs text-white/60">
                  Collaborator access
                  {/* Server supports only view|comment (create-project-link rejects
                      others) — offering "edit" would claim an unenforced permission. */}
                  <select value={dupMode} onChange={(e) => setDupMode(e.target.value as any)}
                    className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs text-white/70">
                    <option value="view">View</option>
                    <option value="comment">Comment</option>
                  </select>
                </label>
              )}
              {!online && (
                <p className="text-[10px] text-warning/80">You're offline — this won't be created until the server confirms.</p>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="compact" onClick={() => setDuplicating(null)}>Cancel</Button>
                <Button variant="primary" size="compact" loading={busy !== null} onClick={handleDuplicate}>Create Duplicate</Button>
              </div>
            </Surface>
          </div>
        )}
      </div>
    </div>
  );
}
