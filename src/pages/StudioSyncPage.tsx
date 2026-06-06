import { useState, useEffect, useCallback } from 'react';
import {
  Music2, FolderOpen, RefreshCw, CheckCircle2, AlertCircle,
  UploadCloud, XCircle, RotateCcw, ChevronDown, ChevronRight, Clock,
} from 'lucide-react';
import { api } from '../lib/api';
import { FLStudioStatusPanel } from '../components/FLStudioStatusPanel';
import { formatBytes, formatRelativeTime } from '../lib/utils';
import type { SyncProgress } from '../types';

interface StudioSyncPageProps {
  syncProgresses: Record<string, SyncProgress>;
  visible?: boolean;
}

export function StudioSyncPage({ syncProgresses, visible }: StudioSyncPageProps) {
  const [projects, setProjects] = useState<any[]>([]);
  const [queue, setQueue] = useState<any[]>([]);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [syncStatus, setSyncStatus] = useState('idle');
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [p, q, s, c] = await Promise.all([
        api.projects.getAll(),
        api.sync.getQueue(),
        api.sync.getStatus(),
        api.bounces.getPending(),
      ]);
      setProjects(p ?? []);
      setQueue(q ?? []);
      setSyncStatus(s ?? 'idle');
      setCandidates((c ?? []).filter((x: any) => x.status === 'pending'));
      setLoading(false);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    refresh();
    const interval = setInterval(refresh, 8000);
    const handler = () => setTimeout(refresh, 800);
    api.on('watcher:event', handler);
    api.on('sync:progress', handler);
    return () => {
      clearInterval(interval);
      api.off('watcher:event', handler);
      api.off('sync:progress', handler);
    };
  }, [visible, refresh]);

  const handleRetryAll = async () => {
    setRetrying(true);
    await api.sync.retryAll();
    setTimeout(() => { refresh(); setRetrying(false); }, 1500);
  };

  const resolveCandidate = async (id: string, action: string) => {
    await api.bounces.resolve(id, action);
    setCandidates(prev => prev.filter(c => c.id !== id));
  };

  const dawProjects = projects.filter(p => p.daw_type === 'FL Studio' || p.daw_type?.includes('FL'));
  const otherProjects = projects.filter(p => !dawProjects.find(d => d.id === p.id));
  const failedItems = queue.filter(q => q.status === 'failed');
  const activeItems = queue.filter(q => q.status === 'uploading' || q.status === 'retrying');
  const pendingItems = queue.filter(q => q.status === 'pending');

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-3xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">Studio Sync</h1>
            <p className="text-xs text-white/30 mt-0.5">
              Local DAW projects · bounces · upload health
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#111] border border-[#222] text-xs`}>
              <div className={`w-1.5 h-1.5 rounded-full ${
                syncStatus.includes('uploading') ? 'bg-cyan-400 animate-pulse'
                : syncStatus.includes('paused') ? 'bg-amber-400'
                : 'bg-emerald-400'}`} />
              <span className="text-white/50">
                {syncStatus === 'idle' ? 'Up to date'
                  : syncStatus === 'paused:auth' ? 'Paused — sign in'
                  : syncStatus === 'paused:limit' ? 'Plan limit'
                  : syncStatus.includes('uploading') ? 'Uploading…'
                  : syncStatus}
              </span>
            </div>
            <button
              onClick={refresh}
              className="p-1.5 rounded-lg bg-[#111] border border-[#222] text-white/40 hover:text-white/70 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* FL Studio project status panels */}
        {dawProjects.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-xs font-semibold text-white/40 uppercase tracking-wider flex items-center gap-2">
              <Music2 className="w-3.5 h-3.5 text-[#FF5A26]" />
              FL Studio Projects
            </h2>
            {dawProjects.map(p => (
              <FLStudioStatusPanel key={p.id} projectId={p.id} />
            ))}
          </div>
        )}

        {/* Other DAW projects — compact list */}
        {otherProjects.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold text-white/40 uppercase tracking-wider">Other Projects</h2>
            {otherProjects.map(p => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3 bg-[#0d0d0d] border border-[#1e1e1e] rounded-xl">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{
                  background: p.sync_status === 'synced' ? '#34d399'
                    : p.sync_status === 'failed' ? '#f87171'
                    : p.sync_status === 'uploading' ? '#22d3ee' : '#6b7280'
                }} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-white/70 truncate">{p.project_name}</p>
                  <p className="text-[10px] text-white/25 font-mono truncate">{p.file_path.split('/').slice(-2).join('/')}</p>
                </div>
                <span className="text-[10px] text-white/25">{p.daw_type}</span>
                <span className="text-[10px] text-white/25">{formatRelativeTime(p.modified_at)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Pending bounce candidates */}
        {candidates.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold text-white/40 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-amber-400" />
              Pending Bounces ({candidates.length})
            </h2>
            {candidates.map(c => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3 bg-[#0d0d0d] border border-amber-500/20 rounded-xl">
                <Music2 className="w-4 h-4 text-amber-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-white/70 truncate font-medium">{c.file_name}</p>
                  <p className="text-[10px] text-white/25">{formatBytes(c.file_size)} · {c.role}</p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => resolveCandidate(c.id, 'confirmed')}
                    className="px-2 py-1 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors"
                  >New version</button>
                  <button
                    onClick={() => resolveCandidate(c.id, 'stem')}
                    className="px-2 py-1 rounded text-[10px] font-medium bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 transition-colors"
                  >Stem</button>
                  <button
                    onClick={() => resolveCandidate(c.id, 'master')}
                    className="px-2 py-1 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 transition-colors"
                  >Master</button>
                  <button
                    onClick={() => resolveCandidate(c.id, 'ignored')}
                    className="p-1 rounded text-white/20 hover:text-white/50 transition-colors"
                  ><XCircle className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Active uploads */}
        {activeItems.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold text-white/40 uppercase tracking-wider flex items-center gap-1.5">
              <UploadCloud className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
              Uploading
            </h2>
            {activeItems.map(item => {
              const prog = syncProgresses[item.id];
              const pct = prog?.percentage ?? 0;
              return (
                <div key={item.id} className="px-4 py-3 bg-[#0d0d0d] border border-[#1e1e1e] rounded-xl space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-white/60 truncate max-w-[220px]">{item.file_name ?? item.type}</span>
                    <span className="text-cyan-400 tabular-nums text-[10px]">{pct}%</span>
                  </div>
                  <div className="h-0.5 bg-white/5 rounded-full overflow-hidden">
                    <div className="h-full bg-cyan-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pending queue */}
        {pendingItems.length > 0 && (
          <div className="space-y-1">
            <h2 className="text-xs font-semibold text-white/40 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Queue ({pendingItems.length})
            </h2>
            {pendingItems.slice(0, 10).map(item => (
              <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl">
                <div className="w-1.5 h-1.5 rounded-full bg-white/20 flex-shrink-0" />
                <span className="text-xs text-white/40 truncate flex-1">{item.file_name ?? item.type}</span>
                <span className="text-[10px] text-white/20">{item.type.replace('_', ' ')}</span>
              </div>
            ))}
            {pendingItems.length > 10 && (
              <p className="text-[10px] text-white/20 text-center">+{pendingItems.length - 10} more</p>
            )}
          </div>
        )}

        {/* Failed uploads */}
        {failedItems.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold text-red-400/70 uppercase tracking-wider flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" />
                Failed ({failedItems.length})
              </h2>
              <button
                onClick={handleRetryAll}
                disabled={retrying}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium text-red-400 border border-red-400/20 hover:bg-red-400/5 transition-colors disabled:opacity-40"
              >
                <RotateCcw className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`} />
                Retry all
              </button>
            </div>
            {failedItems.map(item => (
              <div key={item.id} className="flex items-center gap-3 px-4 py-3 bg-[#0d0d0d] border border-red-500/15 rounded-xl">
                <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-white/60 truncate">{item.file_name ?? item.type}</p>
                  {item.error_message && (
                    <p className="text-[10px] text-red-400/60 truncate mt-0.5">{item.error_message}</p>
                  )}
                </div>
                <span className="text-[10px] text-white/20">{item.retries ?? 0} retries</span>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {projects.length === 0 && candidates.length === 0 && queue.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <FolderOpen className="w-10 h-10 text-white/10 mb-3" />
            <p className="text-sm text-white/30">No DAW projects linked yet</p>
            <p className="text-xs text-white/20 mt-1">Add a folder in the Folders tab to get started</p>
          </div>
        )}
      </div>
    </div>
  );
}
