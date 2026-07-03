import { useState, useEffect, useCallback, useRef } from 'react';
import { FolderPlus, Trash2, FolderOpen, ExternalLink, Sparkles, Plus, RefreshCw, Clock, FileAudio, ChevronDown, ChevronRight, Ban, Loader2, X, AlertTriangle } from 'lucide-react';
import { api, FolderClassification } from '../lib/api';
import { interpretFolderAddResult, confirmationCopy, completeAmbiguousAdd } from '../lib/folderAddFlow';
import { DawLogo } from '../components/DawLogo';

function guessDaw(folderPath: string): string {
  const lower = folderPath.toLowerCase();
  if (lower.includes('fl studio') || lower.includes('image-line')) return 'FL Studio';
  if (lower.includes('pro tools')) return 'Pro Tools';
  if (lower.includes('ableton')) return 'Ableton Live';
  if (lower.includes('logic')) return 'Logic Pro';
  if (lower.includes('reaper')) return 'Reaper';
  if (lower.includes('garageband')) return 'GarageBand';
  if (lower.includes('cubase')) return 'Cubase';
  if (lower.includes('studio one')) return 'Studio One';
  return 'Unknown';
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface ScanMeta { lastScanned: string; fileCount: number }
interface RescanResult { found: number; imported: number; duplicates: number; scanned: number; durationMs: number; cancelled: boolean }

interface DiscoveryProgress {
  phase: 'scanning' | 'importing' | 'done' | 'cancelled' | 'limit_reached';
  scanned?: number;
  found?: number;
  imported?: number;
  duplicates?: number;
  permissionErrors?: number;
}

export function FoldersPage({ visible }: { visible?: boolean }) {
  const [folders, setFolders] = useState<string[]>([]);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [scanMeta, setScanMeta] = useState<Record<string, ScanMeta>>({});
  const [fileCounts, setFileCounts] = useState<Record<string, number>>({});
  const [excluded, setExcluded] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [addingPath, setAddingPath] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState<string | null>(null);
  const [rescanResult, setRescanResult] = useState<{ folder: string; result: RescanResult } | null>(null);
  const [expandedExcludes, setExpandedExcludes] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<DiscoveryProgress | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<FolderClassification | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  useEffect(() => {
    const handler = (p: unknown) => setProgress(p as DiscoveryProgress);
    api.on('discovery:progress', handler);
    return () => api.off('discovery:progress', handler);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [f, d, meta, counts, excl] = await Promise.all([
        api.folders.getAll(),
        api.folders.discover(),
        api.folders.scanMeta(),
        api.folders.fileCounts(),
        api.folders.getExcluded(),
      ]);
      if (!mountedRef.current) return;
      setFolders(f ?? []);
      setDiscovered(d ?? []);
      setScanMeta(meta ?? {});
      setFileCounts(counts ?? {});
      setExcluded(excl ?? []);
    } catch {}
  }, []);

  useEffect(() => { if (visible) refresh(); }, [visible, refresh]);

  // Routes every add result through the full contract: added → refresh,
  // needs-confirmation → show the dialog, error → visible banner. A folder
  // must never silently disappear without explanation.
  const applyAddOutcome = useCallback(async (outcome: ReturnType<typeof interpretFolderAddResult>) => {
    switch (outcome.kind) {
      case 'added':
        setAddError(null);
        await refresh();
        break;
      case 'needs-confirmation':
        setAddError(null);
        setPendingConfirmation(outcome.classification);
        break;
      case 'error':
        setAddError(outcome.message);
        break;
      case 'cancelled':
        break; // user closed the native dialog — nothing to do
    }
  }, [refresh]);

  const handleAdd = async () => {
    setAdding(true);
    try {
      const result = await api.folders.add().catch((e) => {
        setAddError(`Could not add folder: ${(e as Error)?.message ?? 'unknown error'}`);
        return null;
      });
      if (result !== null) await applyAddOutcome(interpretFolderAddResult(result));
    } finally {
      setAdding(false);
    }
  };

  const handleAddPath = async (folderPath: string) => {
    setAddingPath(folderPath);
    try {
      const result = await api.folders.addPath(folderPath).catch((e) => {
        setAddError(`Could not add “${folderPath.split('/').pop()}”: ${(e as Error)?.message ?? 'unknown error'}`);
        return null;
      });
      if (result !== null) await applyAddOutcome(interpretFolderAddResult(result));
    } finally {
      setAddingPath(null);
    }
  };

  const handleConfirmAddAnyway = async () => {
    if (!pendingConfirmation) return;
    setConfirming(true);
    try {
      const outcome = await completeAmbiguousAdd(api.folders.confirmAmbiguous, pendingConfirmation.path);
      setPendingConfirmation(null);
      await applyAddOutcome(outcome);
    } finally {
      setConfirming(false);
    }
  };

  const handleCancelConfirmation = () => {
    // Explicit cancel: no folder is indexed, dialog closes, no state changes.
    setPendingConfirmation(null);
  };

  const handleRemove = async (folder: string) => {
    await api.folders.remove(folder);
    await refresh();
  };

  const handleRescan = async (folder: string) => {
    setRescanning(folder);
    setRescanResult(null);
    setProgress({ phase: 'scanning', scanned: 0, found: 0 });
    try {
      const result = await api.folders.rescan(folder);
      if (mountedRef.current) {
        setRescanResult({ folder, result });
        await refresh(); // reload file counts + scan meta
      }
    } finally {
      if (mountedRef.current) {
        setRescanning(null);
        setProgress(null);
      }
    }
  };

  const handleCancelRescan = async () => {
    await api.files.discoverCancel();
  };

  const handleUnexclude = async (subPath: string) => {
    await api.folders.unexcludePath(subPath);
    await refresh();
  };

  const toggleExpandExcludes = (folder: string) => {
    setExpandedExcludes(prev => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder); else next.add(folder);
      return next;
    });
  };

  const unaddedDiscovered = discovered.filter(d => !folders.includes(d));
  const progressLabel = (() => {
    if (!progress) return '';
    if (progress.phase === 'scanning') return `Scanning… ${(progress.scanned ?? 0).toLocaleString()} checked, ${progress.found ?? 0} found`;
    if (progress.phase === 'importing') return `Importing ${progress.found ?? 0} files…`;
    return '';
  })();

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-3xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">Indexed Folders</h1>
            <p className="text-xs text-white/30 mt-0.5">
              Wavi indexes only the folders you explicitly add. Nothing is scanned automatically.
            </p>
          </div>
          <button
            onClick={handleAdd}
            disabled={adding}
            className="flex items-center gap-2 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-black text-sm font-semibold rounded-lg transition-colors"
          >
            <FolderPlus className="w-4 h-4" />
            {adding ? 'Selecting…' : 'Add Folder'}
          </button>
        </div>

        {/* Folder-add error banner */}
        {addError && (
          <div className="bg-red-500/5 border border-red-500/20 rounded-xl px-4 py-3 flex items-center gap-3">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
            <p className="flex-1 text-xs text-red-300/80">{addError}</p>
            <button
              onClick={() => setAddError(null)}
              className="text-white/30 hover:text-white/60 transition-colors flex-shrink-0"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Ambiguous-folder confirmation dialog */}
        {pendingConfirmation && (() => {
          const copy = confirmationCopy(pendingConfirmation);
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="dialog" aria-modal="true">
              <div className="bg-[#111] border border-amber-500/30 rounded-xl p-5 max-w-md mx-4 space-y-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white/90">{copy.title}</p>
                    <p className="text-[10px] text-white/25 font-mono truncate mt-0.5">{pendingConfirmation.path}</p>
                  </div>
                </div>
                <p className="text-xs text-white/50 leading-relaxed">{copy.body}</p>
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    onClick={handleCancelConfirmation}
                    disabled={confirming}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-white/60 hover:text-white/90 border border-white/10 hover:border-white/20 transition-colors disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirmAddAnyway}
                    disabled={confirming}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 transition-colors disabled:opacity-40"
                  >
                    {confirming && <Loader2 className="w-3 h-3 animate-spin" />}
                    Add Anyway
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Rescan progress bar */}
        {rescanning && (
          <div className="bg-[#0d1117] border border-cyan-500/20 rounded-xl p-4 flex items-center gap-3">
            <Loader2 className="w-4 h-4 text-cyan-400 animate-spin flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-white/60 truncate">{progressLabel || 'Starting scan…'}</p>
            </div>
            <button
              onClick={handleCancelRescan}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-white/10 text-red-400/70 hover:text-red-400 transition-colors flex-shrink-0"
            >
              <X className="w-3 h-3" />Cancel
            </button>
          </div>
        )}

        {/* Last rescan result */}
        {rescanResult && !rescanning && (
          <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl px-4 py-3 text-xs text-emerald-300/70">
            Scan complete in {(rescanResult.result.durationMs / 1000).toFixed(1)}s —{' '}
            {rescanResult.result.found.toLocaleString()} audio files found,{' '}
            {rescanResult.result.imported} new,{' '}
            {rescanResult.result.duplicates} already indexed
            {rescanResult.result.cancelled ? ' (cancelled)' : ''}
          </div>
        )}

        {/* Auto-discovered folders */}
        {unaddedDiscovered.length > 0 && (
          <div className="bg-[#0d1117] border border-cyan-500/20 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-cyan-400" />
              <p className="text-sm font-semibold text-white/80">DAW folders detected on your Mac</p>
              <span className="ml-auto text-[10px] text-white/30">click Add to index</span>
            </div>
            <div className="space-y-2">
              {unaddedDiscovered.map((folder) => {
                const daw = guessDaw(folder);
                const isAdding = addingPath === folder;
                return (
                  <div key={folder} className="flex items-center gap-3 bg-black/30 rounded-lg px-3 py-2.5 group">
                    <DawLogo daw={daw} size={28} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-white/70 truncate">{folder.split('/').pop()}</p>
                      <p className="text-[10px] text-white/20 font-mono truncate">{folder}</p>
                    </div>
                    <button
                      onClick={() => handleAddPath(folder)}
                      disabled={isAdding}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 text-xs font-semibold transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      <Plus className="w-3 h-3" />
                      {isAdding ? 'Adding…' : 'Add'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Watched folders */}
        {folders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FolderOpen className="w-12 h-12 text-white/10 mb-4" />
            <p className="text-sm text-white/30">No folders indexed</p>
            <p className="text-xs text-white/20 mt-1 max-w-xs">
              {unaddedDiscovered.length > 0
                ? 'Add one of the detected folders above, or click Add Folder to pick any folder.'
                : 'Click Add Folder to select a folder containing your DAW projects or audio files.'}
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs font-semibold text-white/30 uppercase tracking-wider">Indexed</p>
            <div className="space-y-3">
              {folders.map((folder) => {
                const daw = guessDaw(folder);
                const meta = scanMeta[folder];
                const count = fileCounts[folder] ?? 0;
                const isRescanning = rescanning === folder;
                const folderExcludes = excluded.filter(e => e.startsWith(folder + '/'));
                const showExcludes = expandedExcludes.has(folder);

                return (
                  <div key={folder} className="bg-[#111] border border-[#1a1a1a] hover:border-[#2a2a2a] rounded-xl overflow-hidden transition-colors">
                    <div className="flex items-center gap-3 p-4">
                      <DawLogo daw={daw} size={32} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white/80 truncate">
                          {folder.split('/').pop() || folder}
                        </p>
                        <p className="text-[10px] text-white/20 font-mono truncate">{folder}</p>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="flex items-center gap-1 text-[10px] text-white/30">
                            <FileAudio className="w-3 h-3" />
                            {count.toLocaleString()} files
                          </span>
                          {meta?.lastScanned && (
                            <span className="flex items-center gap-1 text-[10px] text-white/20">
                              <Clock className="w-3 h-3" />
                              {timeAgo(meta.lastScanned)}
                            </span>
                          )}
                          {folderExcludes.length > 0 && (
                            <button
                              onClick={() => toggleExpandExcludes(folder)}
                              className="flex items-center gap-0.5 text-[10px] text-amber-400/50 hover:text-amber-400/80 transition-colors"
                            >
                              {showExcludes ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
                              {folderExcludes.length} excluded
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        {/* Rescan */}
                        <button
                          onClick={() => handleRescan(folder)}
                          disabled={!!rescanning}
                          title="Rescan this folder"
                          className="p-1.5 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 transition-colors disabled:opacity-30"
                        >
                          {isRescanning
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <RefreshCw className="w-3.5 h-3.5" />}
                        </button>
                        {/* Reveal */}
                        <button
                          onClick={() => api.shell.openPath(folder)}
                          title="Open in Finder"
                          className="p-1.5 rounded-lg hover:bg-white/5 text-white/30 hover:text-white/60 transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                        {/* Remove */}
                        <button
                          onClick={() => handleRemove(folder)}
                          title="Stop indexing"
                          className="p-1.5 rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Excluded subfolders */}
                    {showExcludes && folderExcludes.length > 0 && (
                      <div className="border-t border-white/5 px-4 pb-3 pt-2 space-y-1.5">
                        <p className="text-[10px] text-white/25 font-semibold uppercase tracking-wider mb-1.5">Excluded subfolders</p>
                        {folderExcludes.map(sub => (
                          <div key={sub} className="flex items-center gap-2 bg-black/20 rounded-lg px-2.5 py-1.5">
                            <Ban className="w-3 h-3 text-amber-400/40 flex-shrink-0" />
                            <span className="flex-1 text-[10px] font-mono text-white/30 truncate">{sub.replace(folder + '/', '')}</span>
                            <button
                              onClick={() => handleUnexclude(sub)}
                              className="text-[10px] text-white/20 hover:text-white/50 transition-colors"
                            >
                              remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Supported file types */}
        <div className="bg-[#111] border border-[#1a1a1a] rounded-xl p-4">
          <p className="text-xs text-white/40 mb-2 font-medium">Indexed file types</p>
          <div className="flex flex-wrap gap-2">
            {[
              { ext: '.als', label: 'Ableton' },
              { ext: '.flp', label: 'FL Studio' },
              { ext: '.logic', label: 'Logic Pro' },
              { ext: '.ptx', label: 'Pro Tools' },
              { ext: '.rpp', label: 'Reaper' },
              { ext: '.wav', label: 'WAV' },
              { ext: '.aiff', label: 'AIFF' },
              { ext: '.mp3', label: 'MP3' },
              { ext: '.flac', label: 'FLAC' },
              { ext: '.mid', label: 'MIDI' },
              { ext: '.stems', label: 'Stems' },
            ].map(({ ext, label }) => (
              <span key={ext} className="px-2 py-1 text-[10px] font-mono bg-white/5 text-white/40 rounded border border-white/5">
                {ext} <span className="text-white/20">{label}</span>
              </span>
            ))}
          </div>
          <p className="text-[10px] text-white/20 mt-3">
            System folders (node_modules, .git, .cache, Library, application bundles, build/release dirs) are never scanned.
          </p>
        </div>

      </div>
    </div>
  );
}
