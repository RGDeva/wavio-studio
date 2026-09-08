import { useState, useEffect, useCallback, useRef } from 'react';
import { Activity, RefreshCw, FolderOpen, UploadCloud, CheckCircle2, AlertCircle, Info, Music2, Sparkles, Tag } from 'lucide-react';
import { api } from '../lib/api';
import { formatRelativeTime } from '../lib/utils';
import type { ActivityEntry } from '../types';

const TYPE_CONFIG: Record<string, { icon: typeof Activity; color: string; bg: string }> = {
  project_added:    { icon: FolderOpen,    color: 'text-primary',    bg: 'bg-primary/10' },
  project_changed:  { icon: FolderOpen,    color: 'text-warning',   bg: 'bg-warning/10' },
  project_synced:   { icon: CheckCircle2,  color: 'text-success', bg: 'bg-success/10' },
  file_synced:      { icon: CheckCircle2,  color: 'text-success', bg: 'bg-success/10' },
  sync_error:       { icon: AlertCircle,   color: 'text-destructive',     bg: 'bg-destructive/10' },
  folder_added:     { icon: FolderOpen,    color: 'text-accent',  bg: 'bg-accent/10' },
  folder_removed:   { icon: FolderOpen,    color: 'text-fg-quaternary',    bg: 'bg-layer-2' },
  dependency_found: { icon: UploadCloud,   color: 'text-info',    bg: 'bg-info/10' },
  file_analyzed:    { icon: Music2,        color: 'text-fuchsia-400', bg: 'bg-fuchsia-400/10' },
  bpm_detected:     { icon: Music2,        color: 'text-fuchsia-400', bg: 'bg-fuchsia-400/10' },
  file_imported:    { icon: UploadCloud,   color: 'text-info',    bg: 'bg-info/10' },
  bounce_detected:  { icon: Sparkles,      color: 'text-primary',    bg: 'bg-primary/10' },
  version_created:  { icon: Tag,           color: 'text-success', bg: 'bg-success/10' },
  upload_started:   { icon: UploadCloud,   color: 'text-info',    bg: 'bg-info/10' },
  upload_complete:  { icon: CheckCircle2,  color: 'text-success', bg: 'bg-success/10' },
};

const ROLE_COLORS: Record<string, string> = {
  master:    'bg-warning/20 text-warning',
  mix:       'bg-primary/20 text-primary',
  stem:      'bg-accent/20 text-accent',
  reference: 'bg-success/20 text-success',
  sample:    'bg-info/20 text-info',
};

export function ActivityPage({ visible }: { visible?: boolean }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api.activity.getAll();
      if (!mountedRef.current) return;
      setEntries(data ?? []);
      setLoading(false);
    } catch { /* unmounted or IPC error */ }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    const handler = () => setTimeout(refresh, 600); // slight delay for DB write
    api.on('watcher:event', handler);
    api.on('sync:progress', handler);
    return () => {
      clearInterval(interval);
      api.off('watcher:event', handler);
      api.off('sync:progress', handler);
    };
  }, [refresh]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">Activity</h1>
            <p className="text-xs text-fg-quaternary mt-0.5">Sync history and file events</p>
          </div>
          <button
            onClick={refresh}
            className="p-1.5 rounded-lg bg-[#111] border border-[#222] text-fg-quaternary hover:text-fg-secondary transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-5 h-5 border-2 border-hairline-focus border-t-cyan-500 rounded-full animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Activity className="w-10 h-10 text-fg-quaternary mb-3" />
            <p className="text-sm text-fg-quaternary">No activity yet</p>
            <p className="text-xs text-fg-quaternary mt-1">Events will appear here as files are detected and synced</p>
          </div>
        ) : (
          <div className="space-y-1">
            {entries.map((entry) => {
              const config = TYPE_CONFIG[entry.type] ?? { icon: Info, color: 'text-fg-quaternary', bg: 'bg-layer-2' };
              const Icon = config.icon;
              return (
                <div
                  key={entry.id}
                  className="flex items-start gap-3 p-3 rounded-xl hover:bg-layer-1 transition-colors group"
                >
                  <div className={`w-7 h-7 rounded-lg ${config.bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                    <Icon className={`w-3.5 h-3.5 ${config.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-fg-secondary">{entry.message}</p>
                    {entry.metadata && (() => {
                      try {
                        const meta = JSON.parse(entry.metadata);
                        const badges: React.ReactNode[] = [];
                        if (meta.bpm)      badges.push(<span key="bpm"  className="px-1.5 py-0.5 rounded text-meta font-mono bg-layer-3 text-fg-quaternary">{meta.bpm} BPM</span>);
                        if (meta.key_note) badges.push(<span key="key"  className="px-1.5 py-0.5 rounded text-meta font-mono bg-layer-3 text-fg-quaternary">{meta.key_note}</span>);
                        if (meta.role && meta.role !== 'unknown') {
                          const cls = ROLE_COLORS[meta.role] ?? 'bg-layer-3 text-fg-quaternary';
                          badges.push(<span key="role" className={`px-1.5 py-0.5 rounded text-meta font-mono ${cls}`}>{meta.role}</span>);
                        }
                        return (
                          <>
                            {badges.length > 0 && <div className="flex items-center gap-1.5 mt-1 flex-wrap">{badges}</div>}
                            {meta.filePath && <p className="text-xs text-fg-quaternary font-mono mt-0.5 truncate">{meta.filePath}</p>}
                          </>
                        );
                      } catch { return null; }
                    })()}
                  </div>
                  <span className="text-meta text-fg-quaternary flex-shrink-0 mt-1 group-hover:text-fg-quaternary transition-colors">
                    {formatRelativeTime(entry.created_at)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
