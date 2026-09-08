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
  master:  'text-warning bg-warning/15 border-warning/30',
  mix:     'text-primary bg-primary/15 border-primary/30',
  stem:    'text-accent bg-accent/15 border-accent/30',
  bounce:  'text-info bg-info/15 border-info/30',
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
        const roleClass = ROLE_COLORS[c.role] ?? 'text-fg-tertiary bg-layer-2 border-hairline-strong';
        const busy = resolving[c.id];
        return (
          <div
            key={c.id}
            className="bg-[#111] border border-[#2a2a2a] rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-2 fade-in"
          >
            <div className="flex items-start gap-3 p-4">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Music2 className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-fg-secondary truncate" title={c.file_name}>
                  {c.file_name}
                </p>
                <p className="text-meta text-fg-quaternary mt-0.5">{formatBytes(c.file_size)}</p>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span className={`px-1.5 py-0.5 rounded text-meta font-medium border ${roleClass}`}>
                    {c.role}
                  </span>
                  <span className="text-meta text-fg-quaternary">detected in export folder</span>
                </div>
              </div>
              <button
                onClick={() => resolve(c.id, 'ignored')}
                disabled={busy}
                className="text-fg-quaternary hover:text-fg-tertiary transition-colors flex-shrink-0"
                title="Ignore"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="border-t border-[#1a1a1a] grid grid-cols-3 divide-x divide-[#1a1a1a]">
              <button
                onClick={() => resolve(c.id, 'confirmed')}
                disabled={busy}
                className="flex items-center justify-center gap-1 py-2.5 text-meta font-medium text-success hover:bg-success/5 transition-colors disabled:opacity-40"
              >
                <CheckCircle2 className="w-3 h-3" />
                New version
              </button>
              <button
                onClick={() => resolve(c.id, 'stem')}
                disabled={busy}
                className="flex items-center justify-center gap-1 py-2.5 text-meta font-medium text-accent hover:bg-accent/5 transition-colors disabled:opacity-40"
              >
                <Layers className="w-3 h-3" />
                Stem
              </button>
              <button
                onClick={() => resolve(c.id, 'master')}
                disabled={busy}
                className="flex items-center justify-center gap-1 py-2.5 text-meta font-medium text-warning hover:bg-warning/5 transition-colors disabled:opacity-40"
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
