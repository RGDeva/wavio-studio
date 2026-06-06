import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Search, Music, FileAudio, ArrowUpDown, Cloud,
  FolderOpen, ChevronDown, RefreshCw, X,
  Upload, Plus, Loader2, Sparkles, UploadCloud, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import { SyncStatusBadge } from '../components/SyncStatusBadge';
import { DawLogo } from '../components/DawLogo';
import { formatBytes, formatRelativeTime } from '../lib/utils';
import { parseSearchQuery, filterFiles, describeQuery } from '../lib/searchParser';
import type { LibraryFile, FileStats, SyncQueueItem, SyncProgress } from '../types';

type SortField = 'file_name' | 'bpm' | 'key_note' | 'duration' | 'file_size' | 'modified_at' | 'role';
type SortDir = 'asc' | 'desc';
type RoleFilter = 'all' | 'stem' | 'mix' | 'master' | 'reference' | 'sample' | 'unknown';

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getRoleColor(role: string): string {
  const map: Record<string, string> = {
    stem: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
    mix: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
    master: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    reference: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    sample: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
    unknown: 'text-white/30 bg-white/5 border-white/10',
  };
  return map[role] ?? map.unknown;
}

export function LibraryPage({ visible }: { visible?: boolean }) {
  const [allFiles, setAllFiles] = useState<LibraryFile[]>([]);
  const [stats, setStats] = useState<FileStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('modified_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [importing, setImporting] = useState(false);
  // Sync progress
  const [syncQueue, setSyncQueue] = useState<SyncQueueItem[]>([]);
  const [syncProgresses, setSyncProgresses] = useState<Record<string, SyncProgress>>({});
  const [syncStatus, setSyncStatus] = useState('idle');

  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Expensive: load files + stats — only on mount or real file changes
  const refreshFiles = useCallback(async () => {
    try {
      const [fetchedFiles, fileStats] = await Promise.all([
        api.files.getAll(500),
        api.files.stats(),
      ]);
      if (!mountedRef.current) return;
      setAllFiles((fetchedFiles ?? []) as LibraryFile[]);
      setStats(fileStats);
      setLoading(false);
    } catch { /* unmounted or IPC error */ }
  }, []);

  // Cheap: only sync queue + status — safe to poll every few seconds
  const refreshSync = useCallback(async () => {
    try {
      const [queue, status] = await Promise.all([
        api.sync.getQueue(),
        api.sync.getStatus(),
      ]);
      if (!mountedRef.current) return;
      setSyncQueue((queue ?? []) as SyncQueueItem[]);
      setSyncStatus(status ?? 'idle');
    } catch { /* unmounted or IPC error */ }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([refreshFiles(), refreshSync()]);
  }, [refreshFiles, refreshSync]);

  // Debounce watcher events — rapid file changes won't flood IPC
  const watcherTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedFileRefresh = useCallback(() => {
    if (watcherTimerRef.current) clearTimeout(watcherTimerRef.current);
    watcherTimerRef.current = setTimeout(() => refreshFiles(), 1500);
  }, [refreshFiles]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const paths: string[] = [];
    for (const file of Array.from(e.dataTransfer.files)) {
      const filePath = (file as any).path;
      if (filePath) paths.push(filePath);
    }
    if (paths.length === 0) return;
    setImporting(true);
    try {
      await api.files.import(paths);
      await refresh();
    } finally {
      setImporting(false);
    }
  }, [refresh]);

  const handleAddFiles = useCallback(async () => {
    setImporting(true);
    try {
      await api.files.addViaDialog();
      await refresh();
    } finally {
      setImporting(false);
    }
  }, [refresh]);

  const handleSyncAll = useCallback(async () => {
    setIsSyncing(true);
    await api.sync.now();
    setTimeout(() => { refresh(); setIsSyncing(false); }, 1500);
  }, [refresh]);

  const didLoadRef = useRef(false);
  useEffect(() => {
    if (!didLoadRef.current) {
      didLoadRef.current = true;
      refresh();
    }
    const syncInterval = setInterval(refreshSync, 8000);
    return () => clearInterval(syncInterval);
  }, [refresh, refreshSync]);

  useEffect(() => {
    const onProgress = (progress: unknown) => {
      const p = progress as SyncProgress;
      setSyncProgresses(prev => ({ ...prev, [p.itemId]: p }));
    };
    api.on('watcher:event', debouncedFileRefresh);
    api.on('sync:progress', onProgress);
    return () => {
      api.off('watcher:event', debouncedFileRefresh);
      api.off('sync:progress', onProgress);
    };
  }, [debouncedFileRefresh]);

  // ── AI-powered search: parse natural language then filter locally ──
  const parsedQuery = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return null;
    return parseSearchQuery(q);
  }, [searchQuery]);

  const queryDescription = useMemo(() => {
    if (!parsedQuery) return '';
    return describeQuery(parsedQuery);
  }, [parsedQuery]);

  // Whether the parsed query extracted any structured filters
  const hasStructuredFilters = useMemo(() => {
    if (!parsedQuery) return false;
    return !!(
      parsedQuery.bpmExact !== undefined ||
      parsedQuery.bpmMin !== undefined ||
      parsedQuery.key ||
      parsedQuery.mode ||
      parsedQuery.roles.length ||
      parsedQuery.fileTypes.length ||
      parsedQuery.durationMaxSecs !== undefined ||
      parsedQuery.durationMinSecs !== undefined
    );
  }, [parsedQuery]);

  // Derive unique file types for filter dropdown
  const fileTypes = useMemo(() => {
    const types = new Set(allFiles.map(f => f.file_type));
    return Array.from(types).sort();
  }, [allFiles]);

  // Filter + sort pipeline
  const displayFiles = useMemo(() => {
    let filtered = allFiles;

    // AI search filter (handles BPM, key, role, duration, free text)
    if (parsedQuery) {
      filtered = filterFiles(filtered, parsedQuery);
    }

    // Manual dropdown filters (additive)
    if (roleFilter !== 'all') filtered = filtered.filter(f => f.role === roleFilter);
    if (typeFilter !== 'all') filtered = filtered.filter(f => f.file_type === typeFilter);

    return [...filtered].sort((a, b) => {
      let aVal: any = a[sortField];
      let bVal: any = b[sortField];
      if (aVal == null) aVal = sortDir === 'asc' ? Infinity : -Infinity;
      if (bVal == null) bVal = sortDir === 'asc' ? Infinity : -Infinity;
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [allFiles, parsedQuery, roleFilter, typeFilter, sortField, sortDir]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir(field === 'file_name' ? 'asc' : 'desc'); }
  };

  const activeUploads = syncQueue.filter(q => q.status === 'uploading');
  const pendingCount = syncQueue.filter(q => q.status === 'pending' || q.status === 'retrying').length;

  const SortHeader = ({ field, label, className = '' }: { field: SortField; label: string; className?: string }) => (
    <button
      onClick={() => toggleSort(field)}
      className={`flex items-center gap-1 text-[10px] uppercase tracking-wider font-medium hover:text-white/60 transition-colors ${
        sortField === field ? 'text-cyan-400' : 'text-white/30'
      } ${className}`}
    >
      {label}
      {sortField === field && <ArrowUpDown className="w-2.5 h-2.5" />}
    </button>
  );

  return (
    <div
      className="h-full overflow-y-auto relative"
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); }}
      onDrop={handleDrop}
    >
      {/* Drag-over overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="border-2 border-dashed border-cyan-500/50 rounded-2xl p-12 text-center">
            <Upload className="w-12 h-12 text-cyan-400 mx-auto mb-3" />
            <p className="text-lg font-semibold text-white">Drop audio files here</p>
            <p className="text-sm text-white/40 mt-1">WAV, MP3, AIFF, FLAC, M4A, OGG, AAC</p>
          </div>
        </div>
      )}

      {/* Importing overlay */}
      {importing && (
        <div className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center">
          <div className="flex items-center gap-3 text-white">
            <Loader2 className="w-5 h-5 animate-spin text-cyan-400" />
            <span className="text-sm">Importing files...</span>
          </div>
        </div>
      )}

      <div className="p-6 max-w-6xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <Music className="w-5 h-5 text-cyan-400" />
              Library
            </h1>
            <p className="text-xs text-white/30 mt-0.5">
              {stats ? `${stats.totalFiles} files · ${formatBytes(stats.totalSize)} · ${stats.syncedFiles} synced` : 'Loading...'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleAddFiles}
              disabled={importing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-[#111] border border-[#222] text-white/60 hover:text-white/80 hover:border-[#333] transition-colors disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Files
            </button>
            <button
              onClick={handleSyncAll}
              disabled={isSyncing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-cyan-600/20 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-600/30 transition-colors disabled:opacity-50"
            >
              {isSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cloud className="w-3.5 h-3.5" />}
              {isSyncing ? 'Syncing...' : 'Sync All'}
            </button>
            <button
              onClick={refresh}
              title="Refresh"
              className="p-1.5 rounded-lg bg-[#111] border border-[#222] text-white/40 hover:text-white/70 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Live sync progress panel */}
        {(activeUploads.length > 0 || pendingCount > 0) && (
          <div className="bg-[#0d0d0d] border border-cyan-500/20 rounded-xl p-3 space-y-2">
            <div className="flex items-center gap-2 mb-1">
              <UploadCloud className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
              <span className="text-xs font-semibold text-cyan-400">
                {activeUploads.length > 0 ? `Uploading ${activeUploads.length} file${activeUploads.length !== 1 ? 's' : ''}` : `${pendingCount} file${pendingCount !== 1 ? 's' : ''} queued`}
              </span>
              <span className="ml-auto text-[10px] text-white/20">
                {syncStatus.includes('uploading') ? 'syncing…' : syncStatus === 'paused:auth' ? 'paused — sign in' : syncStatus === 'paused:limit' ? 'plan limit' : 'idle'}
              </span>
            </div>
            {activeUploads.slice(0, 3).map((item) => {
              const p = syncProgresses[item.id];
              const pct = p?.percentage ?? 0;
              const name = item.file_name ?? item.type;
              return (
                <div key={item.id} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-white/50 font-mono truncate max-w-[260px]">{name}</span>
                    <span className="text-[10px] text-cyan-400 tabular-nums">{pct}%</span>
                  </div>
                  <div className="h-0.5 bg-white/5 rounded-full overflow-hidden">
                    <div className="h-full bg-cyan-500 rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
                  </div>
                  {p?.bytesUploaded !== undefined && (
                    <p className="text-[9px] text-white/20">{formatBytes(p.bytesUploaded)} / {formatBytes(p.bytesTotal ?? 0)}</p>
                  )}
                </div>
              );
            })}
            {activeUploads.length === 0 && pendingCount > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span className="text-[10px] text-white/30">{pendingCount} file{pendingCount !== 1 ? 's' : ''} waiting to upload</span>
              </div>
            )}
          </div>
        )}

        {/* Stats cards */}
        {stats && (
          <div className="grid grid-cols-5 gap-2">
            {(stats.byRole ?? []).slice(0, 5).map(({ role, count }: any) => (
              <button
                key={role}
                onClick={() => setRoleFilter(roleFilter === role ? 'all' : role)}
                className={`px-3 py-2 rounded-lg border text-left transition-all ${
                  roleFilter === role ? 'border-cyan-500/40 bg-cyan-500/5' : 'border-[#1a1a1a] bg-[#111] hover:border-[#2a2a2a]'
                }`}
              >
                <span className={`text-[10px] uppercase tracking-wider ${getRoleColor(role).split(' ')[0]}`}>{role}</span>
                <p className="text-lg font-bold text-white/70 mt-0.5">{count}</p>
              </button>
            ))}
          </div>
        )}

        {/* AI Search + Filters */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fuchsia-400/60" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Try: 140 bpm G# stems · trap beats · minor key samples under 3 minutes"
              className="w-full pl-9 pr-8 py-2 text-xs bg-[#111] border border-[#222] rounded-lg text-white placeholder:text-white/20 focus:outline-none focus:border-fuchsia-500/30"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Type filter */}
          <div className="relative">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="appearance-none pl-3 pr-7 py-2 text-xs bg-[#111] border border-[#222] rounded-lg text-white/60 focus:outline-none focus:border-cyan-500/40 cursor-pointer"
            >
              <option value="all">All types</option>
              {fileTypes.map(t => (
                <option key={t} value={t}>.{t}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-white/20 pointer-events-none" />
          </div>

          {/* Role filter */}
          <div className="relative">
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
              className="appearance-none pl-3 pr-7 py-2 text-xs bg-[#111] border border-[#222] rounded-lg text-white/60 focus:outline-none focus:border-cyan-500/40 cursor-pointer"
            >
              <option value="all">All roles</option>
              <option value="stem">Stems</option>
              <option value="mix">Mixes</option>
              <option value="master">Masters</option>
              <option value="reference">References</option>
              <option value="sample">Samples</option>
              <option value="unknown">Unclassified</option>
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-white/20 pointer-events-none" />
          </div>
        </div>

        {/* AI search interpretation badge */}
        {searchQuery && hasStructuredFilters && (
          <div className="flex items-center gap-2 -mt-1">
            <Sparkles className="w-3 h-3 text-fuchsia-400/60 shrink-0" />
            <p className="text-[10px] text-fuchsia-300/60">
              Interpreted: <span className="text-fuchsia-300/80 font-medium">{queryDescription}</span>
            </p>
            <span className="text-[10px] text-white/20">·</span>
            <span className="text-[10px] text-white/30">{displayFiles.length} result{displayFiles.length !== 1 ? 's' : ''}</span>
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-5 h-5 border-2 border-white/20 border-t-cyan-500 rounded-full animate-spin" />
          </div>
        ) : displayFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <FileAudio className="w-10 h-10 text-white/10 mb-3" />
            <p className="text-sm text-white/30">
              {searchQuery ? 'No files match your search' : 'No audio files detected yet'}
            </p>
            {searchQuery ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-white/20">Try broader terms — e.g. remove BPM or key filters</p>
                {hasStructuredFilters && (
                  <p className="text-[10px] text-fuchsia-400/50">Parsed: {queryDescription}</p>
                )}
              </div>
            ) : (
              <>
                <p className="text-xs text-white/20 mt-1">Drag &amp; drop audio files here, or click Add Files</p>
                <button
                  onClick={handleAddFiles}
                  className="mt-4 flex items-center gap-2 px-4 py-2 text-xs rounded-lg bg-cyan-600/20 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-600/30 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Audio Files
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="bg-[#111] border border-[#1a1a1a] rounded-xl overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_80px_70px_60px_70px_70px_80px_60px] gap-2 px-4 py-2.5 border-b border-[#1a1a1a] bg-[#0d0d0d]">
              <SortHeader field="file_name" label="Name" />
              <SortHeader field="role" label="Role" />
              <SortHeader field="bpm" label="BPM" />
              <SortHeader field="key_note" label="Key" />
              <SortHeader field="duration" label="Duration" />
              <SortHeader field="file_size" label="Size" />
              <SortHeader field="modified_at" label="Modified" />
              <span className="text-[10px] uppercase tracking-wider text-white/30 font-medium">Sync</span>
            </div>

            {/* Rows */}
            <div className="divide-y divide-[#1a1a1a]">
              {displayFiles.map((file) => (
                <div
                  key={file.id}
                  className="grid grid-cols-[1fr_80px_70px_60px_70px_70px_80px_60px] gap-2 px-4 py-2.5 hover:bg-white/[0.02] transition-colors group cursor-default"
                  title={file.file_path}
                >
                  {/* Name + project */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {file.daw_type && <DawLogo daw={file.daw_type} size={16} />}
                      <span className="text-xs text-white/80 truncate font-medium">{file.file_name}</span>
                      <span className="text-[10px] text-white/15 font-mono">.{file.file_type}</span>
                    </div>
                    {file.project_name && (
                      <p className="text-[10px] text-white/20 mt-0.5 flex items-center gap-1 truncate">
                        <FolderOpen className="w-2.5 h-2.5 inline shrink-0" />
                        {file.project_name}
                      </p>
                    )}
                  </div>

                  {/* Role */}
                  <div className="flex items-center">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${getRoleColor(file.role)}`}>
                      {file.role}
                    </span>
                  </div>

                  {/* BPM */}
                  <div className="flex items-center">
                    <span className={`text-xs tabular-nums ${file.bpm ? 'text-white/60' : 'text-white/15'}`}>
                      {file.bpm ?? '—'}
                    </span>
                  </div>

                  {/* Key */}
                  <div className="flex items-center">
                    <span className={`text-xs ${file.key_note ? 'text-white/60' : 'text-white/15'}`}>
                      {file.key_note ?? '—'}
                    </span>
                  </div>

                  {/* Duration */}
                  <div className="flex items-center">
                    <span className={`text-xs tabular-nums ${file.duration ? 'text-white/60' : 'text-white/15'}`}>
                      {formatDuration(file.duration)}
                    </span>
                  </div>

                  {/* Size */}
                  <div className="flex items-center">
                    <span className="text-xs text-white/40 tabular-nums">{formatBytes(file.file_size)}</span>
                  </div>

                  {/* Modified */}
                  <div className="flex items-center">
                    <span className="text-[10px] text-white/25">{formatRelativeTime(file.modified_at)}</span>
                  </div>

                  {/* Sync status */}
                  <div className="flex items-center">
                    <SyncStatusBadge status={file.sync_status} />
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-[#1a1a1a] bg-[#0d0d0d] flex items-center justify-between text-[10px] text-white/20">
              <span>Showing {displayFiles.length} of {allFiles.length} files</span>
              {(roleFilter !== 'all' || typeFilter !== 'all' || searchQuery) && (
                <button
                  onClick={() => { setRoleFilter('all'); setTypeFilter('all'); setSearchQuery(''); }}
                  className="text-cyan-500/60 hover:text-cyan-400 transition-colors"
                >
                  Clear all filters
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
