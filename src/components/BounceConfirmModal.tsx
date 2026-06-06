import { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, Music2, Layers, X, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import { formatBytes } from '../lib/utils';

interface BounceCandidate {
  id: string;
  project_id: string | null;
  file_path: string;
  file_name: string;
  file_size: number;
  role: string;
  detected_at: string;
  status: string;
}

const ROLE_COLORS: Record<string, string> = {
  master:  'text-amber-300 bg-amber-500/15 border-amber-500/30',
  mix:     'text-cyan-300 bg-cyan-500/15 border-cyan-500/30',
  stem:    'text-violet-300 bg-violet-500/15 border-violet-500/30',
  bounce:  'text-blue-300 bg-blue-500/15 border-blue-500/30',
};

export function BounceConfirmModal() {
  const [candidates, setCandidates] = useState<BounceCandidate[]>([]);
  const [resolving, setResolving] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      const data = await api.bounces.getPending();
      setCandidates((data ?? []).filter((c: BounceCandidate) => c.status === 'pending'));
    } catch { /* IPC unavailable */ }
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    api.on('watcher:event', handler);
    return () => api.off('watcher:event', handler);
  }, [refresh]);

  const resolve = async (id: string, action: string) => {
    setResolving(r => ({ ...r, [id]: true }));
    try {
      await api.bounces.resolve(id, action);
      setCandidates(prev => prev.filter(c => c.id !== id));
    } finally {
      setResolving(r => { const n = { ...r }; delete n[id]; return n; });
    }
  };

  if (candidates.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full">
      {candidates.map((c) => {
        const roleClass = ROLE_COLORS[c.role] ?? 'text-white/60 bg-white/5 border-white/10';
        const busy = resolving[c.id];
        return (
          <div
            key={c.id}
            className="bg-[#111] border border-[#2a2a2a] rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-2 fade-in"
          >
            <div className="flex items-start gap-3 p-4">
              <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Music2 className="w-4 h-4 text-cyan-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-white/80 truncate" title={c.file_name}>
                  {c.file_name}
                </p>
                <p className="text-[10px] text-white/30 mt-0.5">{formatBytes(c.file_size)}</p>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${roleClass}`}>
                    {c.role}
                  </span>
                  <span className="text-[10px] text-white/25">detected in export folder</span>
                </div>
              </div>
              <button
                onClick={() => resolve(c.id, 'ignored')}
                disabled={busy}
                className="text-white/20 hover:text-white/50 transition-colors flex-shrink-0"
                title="Ignore"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="border-t border-[#1a1a1a] grid grid-cols-3 divide-x divide-[#1a1a1a]">
              <button
                onClick={() => resolve(c.id, 'confirmed')}
                disabled={busy}
                className="flex items-center justify-center gap-1 py-2.5 text-[11px] font-medium text-emerald-400 hover:bg-emerald-500/5 transition-colors disabled:opacity-40"
              >
                <CheckCircle2 className="w-3 h-3" />
                New version
              </button>
              <button
                onClick={() => resolve(c.id, 'stem')}
                disabled={busy}
                className="flex items-center justify-center gap-1 py-2.5 text-[11px] font-medium text-violet-400 hover:bg-violet-500/5 transition-colors disabled:opacity-40"
              >
                <Layers className="w-3 h-3" />
                Stem
              </button>
              <button
                onClick={() => resolve(c.id, 'master')}
                disabled={busy}
                className="flex items-center justify-center gap-1 py-2.5 text-[11px] font-medium text-amber-400 hover:bg-amber-500/5 transition-colors disabled:opacity-40"
              >
                <ChevronRight className="w-3 h-3" />
                Master
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
