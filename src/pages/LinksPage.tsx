import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link2, Copy, Check, ExternalLink, Pencil, Ban, RefreshCw, Loader2, AlertTriangle, CopyPlus, X } from 'lucide-react';
import { api, LinkListItem } from '../lib/api';
import {
  deriveLinkStatus, linkCapabilities, filterLinks, canDuplicate, linkDisplayName,
  CAPABILITY_LABELS, LinkStatus,
} from '../lib/linksView';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_STYLES: Record<LinkStatus, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'text-emerald-400 bg-emerald-500/10' },
  expired: { label: 'Expired', cls: 'text-amber-400 bg-amber-500/10' },
  revoked: { label: 'Revoked', cls: 'text-white/30 bg-white/5' },
};

export function LinksPage({ visible }: { visible?: boolean }) {
  const [links, setLinks] = useState<LinkListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'listen' | 'project'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | LinkStatus>('all');
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [busy, setBusy] = useState<string | null>(null);          // trackingId with an action in flight
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<LinkListItem | null>(null);
  const [dupAllowDownload, setDupAllowDownload] = useState(true);
  const [dupMode, setDupMode] = useState<'view' | 'comment' | 'edit'>('view');

  const refresh = useCallback(async () => {
    try {
      setLoadError(null);
      const rows = await api.links.getAll();
      setLinks(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setLoadError((e as Error)?.message ?? 'Could not load links');
      setLinks([]);
    }
  }, []);

  useEffect(() => { if (visible) refresh(); }, [visible, refresh]);

  const filtered = useMemo(
    () => filterLinks(links ?? [], { query, kind: kindFilter, status: statusFilter }),
    [links, query, kindFilter, statusFilter],
  );

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
    if ((result as any)?.error) setActionError(`Rename failed: ${(result as any).error}`);
    await refresh();
  };

  const handleRevoke = async (trackingId: string) => {
    setConfirmRevoke(null);
    setBusy(trackingId);
    try {
      const result = await api.links.revoke({ trackingId });
      if ((result as any)?.error) setActionError(`Revoke failed: ${(result as any).error}`);
      await refresh();
    } finally { setBusy(null); }
  };

  const handleDuplicate = async () => {
    if (!duplicating) return;
    setBusy(duplicating.tracking_id);
    try {
      let error: string | undefined;
      if (duplicating.kind === 'listen' && duplicating.asset_id) {
        const r = await api.share.createLink({
          assetId: duplicating.asset_id,
          projectId: duplicating.project_id ?? undefined,
          allowDownload: dupAllowDownload,
        });
        error = r.error;
      } else if (duplicating.kind === 'project' && duplicating.project_id) {
        const r = await api.project.createLink({
          projectId: duplicating.project_id,
          allowDownload: dupAllowDownload,
          collaboratorMode: dupMode,
        });
        error = r.error;
      }
      if (error) setActionError(`Duplicate failed: ${error}`);
      setDuplicating(null);
      await refresh();
    } finally { setBusy(null); }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-4xl mx-auto space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">Links</h1>
            <p className="text-xs text-white/30 mt-0.5">
              Every link you've shared from this computer. Revoking a link stops it working for everyone immediately.
            </p>
          </div>
          <button onClick={refresh} title="Refresh"
            className="p-2 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* Action error banner */}
        {actionError && (
          <div className="bg-red-500/5 border border-red-500/20 rounded-xl px-4 py-3 flex items-center gap-3">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
            <p className="flex-1 text-xs text-red-300/80">{actionError}</p>
            <button onClick={() => setActionError(null)} className="text-white/30 hover:text-white/60"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {/* Search + filters */}
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by label, project or URL…"
            className="flex-1 bg-[#111] border border-[#1f1f1f] rounded-lg px-3 py-2 text-sm text-white/80 placeholder:text-white/20 focus:outline-none focus:border-cyan-500/40"
          />
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as any)}
            className="bg-[#111] border border-[#1f1f1f] rounded-lg px-2 py-2 text-xs text-white/60">
            <option value="all">All types</option>
            <option value="listen">Listen Links</option>
            <option value="project">Project Links</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}
            className="bg-[#111] border border-[#1f1f1f] rounded-lg px-2 py-2 text-xs text-white/60">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
          </select>
        </div>

        {/* Loading */}
        {links === null && !loadError && (
          <div className="flex items-center justify-center py-16 text-white/30 text-sm gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading links…
          </div>
        )}

        {/* Load error */}
        {loadError && (
          <div className="bg-red-500/5 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-300/80">
            Couldn't load your links: {loadError}. Try Refresh.
          </div>
        )}

        {/* Empty */}
        {links !== null && !loadError && links.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Link2 className="w-12 h-12 text-white/10 mb-4" />
            <p className="text-sm text-white/30">No links yet</p>
            <p className="text-xs text-white/20 mt-1 max-w-sm">
              Create a Listen Link or Project Link from a synced project on the Dashboard, and it will appear here.
            </p>
          </div>
        )}

        {/* No match */}
        {links !== null && links.length > 0 && filtered.length === 0 && (
          <p className="text-center text-xs text-white/25 py-10">No links match the current search or filters.</p>
        )}

        {/* Rows */}
        <div className="space-y-2">
          {filtered.map((link) => {
            const status = deriveLinkStatus(link);
            const caps = linkCapabilities(link);
            const isBusy = busy === link.tracking_id;
            const inactive = status !== 'active';
            return (
              <div key={link.tracking_id}
                className={`bg-[#111] border border-[#1a1a1a] rounded-xl p-4 transition-colors ${inactive ? 'opacity-60' : 'hover:border-[#2a2a2a]'}`}>
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    {/* Title / inline rename */}
                    {editing === link.tracking_id ? (
                      <div className="flex items-center gap-2">
                        <input autoFocus value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleRenameCommit(link.tracking_id); if (e.key === 'Escape') setEditing(null); }}
                          placeholder="Internal label (only you see this)"
                          className="flex-1 bg-black/40 border border-cyan-500/30 rounded px-2 py-1 text-sm text-white/90 focus:outline-none" />
                        <button onClick={() => handleRenameCommit(link.tracking_id)} className="text-[10px] text-cyan-400">Save</button>
                        <button onClick={() => setEditing(null)} className="text-[10px] text-white/30">Cancel</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-sm font-medium text-white/85 truncate">{linkDisplayName(link)}</p>
                        <button
                          onClick={() => { setEditing(link.tracking_id); setEditValue(link.label ?? ''); }}
                          title="Rename internal label"
                          className="text-white/20 hover:text-white/60 flex-shrink-0"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                    <p className="text-[10px] text-white/20 font-mono truncate mt-0.5">{link.url}</p>

                    {/* Badges */}
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${STATUS_STYLES[status].cls}`}>{STATUS_STYLES[status].label}</span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-cyan-500/10 text-cyan-400/80">
                        {link.kind === 'project' ? 'Project Link' : 'Listen Link'}
                      </span>
                      {caps.map((c) => (
                        <span key={c} className="px-1.5 py-0.5 rounded text-[10px] bg-white/5 text-white/40">{CAPABILITY_LABELS[c] ?? c}</span>
                      ))}
                    </div>

                    {/* Meta */}
                    <div className="flex items-center gap-4 mt-2 text-[10px] text-white/25">
                      <span>Created {formatDate(link.created_at)}</span>
                      <span>Expires {link.expires_at ? formatDate(link.expires_at) : 'never'}</span>
                      <span title="Play and download counts will appear once link analytics sync to the desktop.">Plays — · Downloads —</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => handleCopy(link)} disabled={inactive} title={inactive ? 'Link is no longer active' : 'Copy link'}
                      className="p-1.5 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 disabled:opacity-30 transition-colors">
                      {copied === link.tracking_id ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={() => api.shell.openExternal(link.url)} title="Open public page"
                      className="p-1.5 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 transition-colors">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => { setDuplicating(link); setDupAllowDownload(!!link.allow_download); setDupMode((link.collaborator_mode as any) || 'view'); }}
                      disabled={!canDuplicate(link) || isBusy}
                      title={canDuplicate(link) ? 'Duplicate with different permissions' : 'Duplicate unavailable for links created before this version'}
                      className="p-1.5 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 disabled:opacity-30 transition-colors">
                      <CopyPlus className="w-3.5 h-3.5" />
                    </button>
                    {status !== 'revoked' && (
                      <button onClick={() => setConfirmRevoke(link.tracking_id)} disabled={isBusy} title="Revoke link"
                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400 disabled:opacity-30 transition-colors">
                        {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Revoke confirmation */}
        {confirmRevoke && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="dialog" aria-modal="true">
            <div className="bg-[#111] border border-red-500/30 rounded-xl p-5 max-w-sm mx-4 space-y-4">
              <div className="flex items-start gap-3">
                <Ban className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-white/90">Revoke this link?</p>
                  <p className="text-xs text-white/50 mt-1 leading-relaxed">
                    Anyone who has this link will immediately lose access. This can't be undone — you can create a new link later.
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setConfirmRevoke(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-white/60 hover:text-white/90 border border-white/10">Cancel</button>
                <button onClick={() => handleRevoke(confirmRevoke)}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/20 hover:bg-red-500/30 text-red-300">Revoke Link</button>
              </div>
            </div>
          </div>
        )}

        {/* Duplicate dialog */}
        {duplicating && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="dialog" aria-modal="true">
            <div className="bg-[#111] border border-cyan-500/30 rounded-xl p-5 max-w-sm mx-4 space-y-4">
              <p className="text-sm font-semibold text-white/90">Duplicate link with different permissions</p>
              <label className="flex items-center justify-between text-xs text-white/60">
                Allow download
                <input type="checkbox" checked={dupAllowDownload} onChange={(e) => setDupAllowDownload(e.target.checked)} />
              </label>
              {duplicating.kind === 'project' && (
                <label className="flex items-center justify-between text-xs text-white/60">
                  Collaborator access
                  <select value={dupMode} onChange={(e) => setDupMode(e.target.value as any)}
                    className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs text-white/70">
                    <option value="view">View</option>
                    <option value="comment">Comment</option>
                    <option value="edit">Edit</option>
                  </select>
                </label>
              )}
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setDuplicating(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-white/60 hover:text-white/90 border border-white/10">Cancel</button>
                <button onClick={handleDuplicate} disabled={busy !== null}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 disabled:opacity-40">
                  {busy && <Loader2 className="w-3 h-3 animate-spin" />} Create Duplicate
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
