import { useState, useEffect, useCallback, useRef } from 'react';
import {
  CheckCircle2, XCircle, Clock, RefreshCw, Layers, Music2,
  FileAudio, FileText, ImageIcon, Piano, Wand2, AlertCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import type { AssociationQueueItem } from '../types';

interface FileReviewPageProps {
  visible?: boolean;
  onPendingCountChange?: (count: number) => void;
}

// ── Role styling ──────────────────────────────────────────────────────────────

const ROLE_STYLE: Record<string, { label: string; color: string; Icon: React.FC<{ className?: string }> }> = {
  daw_project:  { label: 'DAW Project', color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',     Icon: Music2 },
  bounce:       { label: 'Bounce',      color: 'text-blue-400 bg-blue-500/10 border-blue-500/20',      Icon: FileAudio },
  master:       { label: 'Master',      color: 'text-amber-400 bg-amber-500/10 border-amber-500/20',   Icon: FileAudio },
  stem:         { label: 'Stem',        color: 'text-violet-400 bg-violet-500/10 border-violet-500/20',Icon: FileAudio },
  vocal_take:   { label: 'Vocal',       color: 'text-pink-400 bg-pink-500/10 border-pink-500/20',      Icon: FileAudio },
  midi:         { label: 'MIDI',        color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', Icon: Piano },
  sample:       { label: 'Sample',      color: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20',Icon: FileAudio },
  beat:         { label: 'Beat',        color: 'text-orange-400 bg-orange-500/10 border-orange-500/20',Icon: FileAudio },
  artwork:      { label: 'Artwork',     color: 'text-rose-400 bg-rose-500/10 border-rose-500/20',      Icon: ImageIcon },
  lyrics:       { label: 'Lyrics',      color: 'text-lime-400 bg-lime-500/10 border-lime-500/20',      Icon: FileText },
  reference:    { label: 'Reference',   color: 'text-teal-400 bg-teal-500/10 border-teal-500/20',      Icon: FileAudio },
  mix:          { label: 'Mix',         color: 'text-sky-400 bg-sky-500/10 border-sky-500/20',         Icon: FileAudio },
  misc:         { label: 'File',        color: 'text-white/30 bg-white/5 border-white/10',             Icon: FileAudio },
};

function RoleBadge({ role }: { role: string }) {
  const s = ROLE_STYLE[role] ?? ROLE_STYLE.misc;
  const { Icon } = s;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${s.color}`}>
      <Icon className="w-2.5 h-2.5" />
      {s.label}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-white/30">{pct}%</span>
    </div>
  );
}

// ── Signal pill ───────────────────────────────────────────────────────────────

function SignalPill({ label }: { label: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded bg-white/5 text-[10px] text-white/30 border border-white/8">
      {label}
    </span>
  );
}

function signalLabels(signals: AssociationQueueItem['signals']): string[] {
  const labels: string[] = [];
  if (signals.sameFolder)         labels.push('same folder');
  if (signals.parentChildFolder)  labels.push('parent/child folder');
  if (signals.sharedHint)         labels.push(`shared "${signals.sharedHint}"`);
  if ((signals.tokenOverlap ?? 0) > 0) labels.push(`${signals.tokenOverlap} shared tokens`);
  if (signals.timestampProximity) labels.push('close timestamps');
  if (signals.hasDawProject)      labels.push('DAW project');
  if (signals.hasExportFile)      labels.push('export file');
  if (signals.exportUnderProject) labels.push('export in project folder');
  return labels;
}

// ── Queue card ────────────────────────────────────────────────────────────────

interface CardProps {
  item: AssociationQueueItem;
  fileNames: Record<string, string>;  // fileId → file_name
  fileRoles: Record<string, string>;  // fileId → classifier_role
  onConfirm: (id: string, name: string) => void;
  onReject:  (id: string) => void;
  onDefer:   (id: string) => void;
}

function AssociationCard({ item, fileNames, fileRoles, onConfirm, onReject, onDefer }: CardProps) {
  const suggested = (item.signals.suggestedProjectName as string | undefined) ?? 'Untitled Project';
  const [projectName, setProjectName] = useState(suggested);
  const signals = signalLabels(item.signals);

  return (
    <div className="bg-[#111] border border-[#1e1e1e] hover:border-[#2a2a2a] rounded-2xl overflow-hidden transition-colors">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-[#1a1a1a]">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Layers className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span className="text-xs text-white/40 font-medium uppercase tracking-wider">
                Suggested Group · {item.file_ids.length} file{item.file_ids.length !== 1 ? 's' : ''}
              </span>
            </div>
            {/* Editable project name */}
            <input
              className="w-full bg-transparent text-white font-semibold text-sm placeholder:text-white/20 outline-none border-b border-transparent focus:border-cyan-500/40 pb-0.5 transition-colors"
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              placeholder="Project name…"
            />
          </div>
          <ConfidenceBar value={item.confidence} />
        </div>

        {/* Signals */}
        {signals.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {signals.map(s => <SignalPill key={s} label={s} />)}
          </div>
        )}
      </div>

      {/* File list */}
      <div className="px-5 py-3 space-y-1.5 max-h-52 overflow-y-auto">
        {item.file_ids.map(fid => {
          const name = fileNames[fid] ?? fid;
          const role = fileRoles[fid] ?? 'misc';
          return (
            <div key={fid} className="flex items-center gap-2">
              <RoleBadge role={role} />
              <span className="text-xs text-white/60 font-mono truncate flex-1" title={name}>{name}</span>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="px-5 py-3 border-t border-[#1a1a1a] flex items-center gap-2">
        <button
          onClick={() => onConfirm(item.id, projectName)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black text-xs font-semibold transition-colors"
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          Confirm Group
        </button>
        <button
          onClick={() => onDefer(item.id)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/8 text-white/50 text-xs font-medium transition-colors border border-white/10"
        >
          <Clock className="w-3.5 h-3.5" />
          Defer
        </button>
        <button
          onClick={() => onReject(item.id)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400 text-xs font-medium transition-colors ml-auto"
        >
          <XCircle className="w-3.5 h-3.5" />
          Reject
        </button>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function FileReviewPage({ visible, onPendingCountChange }: FileReviewPageProps) {
  const [items, setItems] = useState<AssociationQueueItem[]>([]);
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [fileRoles, setFileRoles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => { if (mountedRef.current) setToast(null); }, 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const raw = (await api.association.getPending()) as AssociationQueueItem[];
      if (!mountedRef.current) return;
      setItems(raw);
      onPendingCountChange?.(raw.length);

      // Resolve file names + roles for all file IDs
      const allIds = [...new Set(raw.flatMap(r => r.file_ids))];
      if (allIds.length > 0) {
        try {
          const allFiles = await api.files.getAll(500) as any[];
          const names: Record<string, string> = {};
          const roles: Record<string, string> = {};
          for (const f of allFiles) {
            if (allIds.includes(f.id)) {
              names[f.id] = f.file_name;
              roles[f.id] = f.classifier_role ?? f.role ?? 'misc';
            }
          }
          if (mountedRef.current) {
            setFileNames(names);
            setFileRoles(roles);
          }
        } catch { /* non-fatal */ }
      }
    } catch { /* IPC unavailable */ }
    if (mountedRef.current) setLoading(false);
  }, [onPendingCountChange]);

  const didLoad = useRef(false);
  useEffect(() => {
    if (!visible) return;
    if (!didLoad.current) { didLoad.current = true; load(); }
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [visible, load]);

  const handleConfirm = useCallback(async (id: string, name: string) => {
    setItems(prev => prev.filter(i => i.id !== id));
    onPendingCountChange?.(items.length - 1);
    try {
      await api.association.confirm(id, name);
      showToast(`Group confirmed: "${name}"`);
    } catch { showToast('Failed to confirm — please try again'); load(); }
  }, [items.length, load, onPendingCountChange]);

  const handleReject = useCallback(async (id: string) => {
    setItems(prev => prev.filter(i => i.id !== id));
    onPendingCountChange?.(items.length - 1);
    try {
      await api.association.reject(id);
      showToast('Group rejected');
    } catch { showToast('Failed to reject'); load(); }
  }, [items.length, load, onPendingCountChange]);

  const handleDefer = useCallback(async (id: string) => {
    setItems(prev => prev.filter(i => i.id !== id));
    onPendingCountChange?.(items.length - 1);
    try {
      await api.association.reject(id);
      showToast('Deferred — will resurface later');
    } catch { load(); }
  }, [items.length, load, onPendingCountChange]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-2xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <Wand2 className="w-5 h-5 text-cyan-400" />
              File Review
            </h1>
            <p className="text-xs text-white/30 mt-0.5">
              Review suggested file groupings — nothing moves without your confirmation
            </p>
          </div>
          <button
            onClick={load}
            title="Refresh"
            className="p-1.5 rounded-lg bg-[#111] border border-[#222] text-white/40 hover:text-white/70 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Toast */}
        {toast && (
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            {toast}
          </div>
        )}

        {/* Content */}
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-5 h-5 border-2 border-white/20 border-t-cyan-500 rounded-full animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <CheckCircle2 className="w-10 h-10 text-white/10 mb-3" />
            <p className="text-sm text-white/30">No pending suggestions</p>
            <p className="text-xs text-white/20 mt-1">
              Wavi will surface groupings as it classifies your music files
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/5 border border-amber-500/15 text-xs text-amber-400/80">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              Wavi found {items.length} possible group{items.length !== 1 ? 's' : ''}. Review and confirm — no files will be moved.
            </div>
            <div className="space-y-4">
              {items.map(item => (
                <AssociationCard
                  key={item.id}
                  item={item}
                  fileNames={fileNames}
                  fileRoles={fileRoles}
                  onConfirm={handleConfirm}
                  onReject={handleReject}
                  onDefer={handleDefer}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
