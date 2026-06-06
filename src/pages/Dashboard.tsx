import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, UploadCloud, FolderOpen, CheckCircle2, AlertCircle, Clock, PauseCircle, ChevronDown, ChevronRight, History, Zap, Globe, Wand2 } from 'lucide-react';
import { api } from '../lib/api';
import { SyncStatusBadge } from '../components/SyncStatusBadge';
import { DawLogo } from '../components/DawLogo';
import { formatBytes, formatRelativeTime, getDawColor, truncatePath } from '../lib/utils';
import type { Project, SyncQueueItem, SyncProgress } from '../types';

interface Version {
  id: string;
  project_id: string;
  file_path: string | null;
  file_size: number;
  checksum: string | null;
  cloud_url: string | null;
  created_at: string;
  label?: string;
  version_type?: string;
  version_number?: number;
}

interface DashboardProps {
  syncProgresses: Record<string, SyncProgress>;
  visible?: boolean;
  onNavigate?: (page: import('../types').Page) => void;
}

export function Dashboard({ syncProgresses, onNavigate }: DashboardProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [queue, setQueue] = useState<SyncQueueItem[]>([]);
  const [syncStatus, setSyncStatus] = useState('idle');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pendingAssociations, setPendingAssociations] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const refresh = useCallback(async () => {
    try {
      const [p, q, s, assoc] = await Promise.all([
        api.projects.getAll(),
        api.sync.getQueue(),
        api.sync.getStatus(),
        api.association.getPending().catch(() => []),
      ]);
      if (!mountedRef.current) return;
      setProjects(p ?? []);
      setQueue(q ?? []);
      setSyncStatus(s ?? 'idle');
      setPendingAssociations(Array.isArray(assoc) ? assoc.length : 0);
      setLoading(false);
    } catch { /* component may have unmounted or IPC failed */ }
  }, []);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    await api.sync.now();
    setTimeout(() => { refresh(); setSyncing(false); }, 1500);
  }, [refresh]);

  const watcherTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRefresh = useCallback(() => {
    if (watcherTimerRef.current) clearTimeout(watcherTimerRef.current);
    watcherTimerRef.current = setTimeout(() => refresh(), 1500);
  }, [refresh]);

  const didLoadRef = useRef(false);
  useEffect(() => {
    if (!didLoadRef.current) {
      didLoadRef.current = true;
      refresh();
    }
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    const traySyncHandler = () => handleSyncNow();
    api.on('watcher:event', debouncedRefresh);
    api.on('sync:progress', debouncedRefresh);
    api.on('tray:sync-now', traySyncHandler);
    return () => {
      api.off('watcher:event', debouncedRefresh);
      api.off('sync:progress', debouncedRefresh);
      api.off('tray:sync-now', traySyncHandler);
    };
  }, [debouncedRefresh, handleSyncNow]);

  // Handle drag/drop file import
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;

    setImportStatus(`Importing ${files.length} file${files.length > 1 ? 's' : ''}...`);
    
    try {
      // Filter to audio files and DAW projects
      const validFiles = files.filter(file => {
        const ext = file.name.toLowerCase().split('.').pop();
        const audioExts = ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'aiff'];
        const dawExts = ['flp', 'als', 'logicx', 'ptx', 'cpr', 'band', 'sesx', 'project'];
        return audioExts.includes(ext || '') || dawExts.includes(ext || '');
      });

      if (validFiles.length === 0) {
        setImportStatus('No valid audio or DAW files found');
        setTimeout(() => setImportStatus(null), 3000);
        return;
      }

      // Get active project or create a default one
      let activeProject = projects.find(p => p.active);
      if (!activeProject) {
        // Create a default project for imported files
        const projectName = `Imported Files ${new Date().toLocaleDateString()}`;
        activeProject = await api.projects.create({
          project_name: projectName,
          daw_type: 'manual',
          file_path: `${require('os').homedir()}/Music/${projectName}`,
        });
        if (activeProject) {
          setProjects(prev => [...prev, activeProject]);
        }
      }

      if (!activeProject) {
        setImportStatus('No active project to import to');
        setTimeout(() => setImportStatus(null), 3000);
        return;
      }

      // Process each file through the sync agent
      const filePaths = validFiles.map(file => file.path || (file as any).webkitRelativePath || file.name);
      await api.files.import(filePaths);

      setImportStatus(`Imported ${validFiles.length} file${validFiles.length > 1 ? 's' : ''}`);
      refresh(); // Refresh the UI
      setTimeout(() => setImportStatus(null), 3000);
    } catch (err) {
      console.error('[Dashboard] Import error:', err);
      setImportStatus('Import failed');
      setTimeout(() => setImportStatus(null), 3000);
    }
  }, [projects, refresh]);

  const synced = projects.filter((p) => p.sync_status === 'synced').length;
  const pending = projects.filter((p) => p.sync_status === 'pending').length;
  const failed = projects.filter((p) => p.sync_status === 'failed').length;
  const activeUploads = queue.filter((q) => q.status === 'uploading');

  return (
    <div 
      className={`h-full overflow-y-auto relative ${isDragOver ? 'bg-cyan-500/5' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-cyan-500/10 backdrop-blur-sm border-2 border-dashed border-cyan-400/50">
          <div className="text-center">
            <UploadCloud className="w-12 h-12 text-cyan-400 mx-auto mb-2" />
            <p className="text-lg font-semibold text-cyan-300">Drop files to import</p>
            <p className="text-sm text-cyan-400/60">Audio files and DAW projects</p>
          </div>
        </div>
      )}
      
      <div className="p-6 max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">Dashboard</h1>
            <p className="text-xs text-white/30 mt-0.5">
              {projects.length} project{projects.length !== 1 ? 's' : ''} detected
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Sync status pill */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#111] border border-[#222]">
              <div className={`w-1.5 h-1.5 rounded-full ${
                syncStatus.includes('uploading') ? 'bg-cyan-400 animate-pulse'
                : syncStatus.includes('paused') ? 'bg-amber-400'
                : 'bg-emerald-400'
              }`} />
              <span className="text-xs text-white/50">
                {syncStatus === 'idle' ? 'Up to date'
                  : syncStatus === 'paused:auth' ? 'Paused — sign in'
                  : syncStatus === 'paused:limit' ? 'Paused — plan limit'
                  : syncStatus.includes('uploading') ? 'Syncing…'
                  : syncStatus}
              </span>
            </div>
            {/* Sync Now */}
            <button
              onClick={handleSyncNow}
              disabled={syncing || syncStatus.includes('paused')}
              title="Sync now"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-black text-xs font-semibold transition-colors"
            >
              <Zap className={`w-3.5 h-3.5 ${syncing ? 'animate-pulse' : ''}`} />
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
            {/* Open Vault */}
            <button
              onClick={() => api.shell.openExternal('https://wavi.stream/vault')}
              title="Open Vault in browser"
              className="p-1.5 rounded-lg bg-[#111] border border-[#222] text-white/40 hover:text-cyan-400 transition-colors"
            >
              <Globe className="w-3.5 h-3.5" />
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

        {/* Sync explanation */}
        <div className="text-[11px] text-white/20 bg-[#0d0d0d] border border-[#1a1a1a] rounded-lg px-3 py-2 leading-relaxed">
          <span className="text-white/40 font-medium">How sync works: </span>
          Wavi Studio watches your DAW folders and automatically uploads new and changed project files to your Vault at
          <button onClick={() => api.shell.openExternal('https://wavi.stream/vault')} className="text-cyan-500/70 hover:text-cyan-400 mx-1 underline">wavi.stream/vault</button>
          whenever they change. Use <span className="text-white/40">Sync Now</span> to force an immediate upload.
        </div>

        {/* Stats */}
        <div className="grid grid-cols-5 gap-3">
          {[
            { label: 'Total', value: projects.length, icon: FolderOpen, color: 'text-white/60', onClick: undefined },
            { label: 'Synced', value: synced, icon: CheckCircle2, color: 'text-emerald-400', onClick: undefined },
            { label: 'Pending', value: pending, icon: Clock, color: 'text-amber-400', onClick: undefined },
            { label: 'Failed', value: failed, icon: AlertCircle, color: 'text-red-400', onClick: undefined },
            { label: 'Review', value: pendingAssociations, icon: Wand2, color: pendingAssociations > 0 ? 'text-cyan-400' : 'text-white/20', onClick: pendingAssociations > 0 ? () => onNavigate?.('review') : undefined },
          ].map(({ label, value, icon: Icon, color, onClick }) => (
            <div
              key={label}
              onClick={onClick}
              className={`bg-[#111] border border-[#1a1a1a] rounded-xl p-4 ${
                onClick ? 'cursor-pointer hover:border-cyan-500/30 transition-colors' : ''
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-white/30">{label}</span>
                <Icon className={`w-3.5 h-3.5 ${color}`} />
              </div>
              <p className={`text-2xl font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        {/* Paused / auth error */}
        {syncStatus === 'paused:auth' && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-xs text-amber-400">
            <PauseCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">Sync paused — session expired.</span>
            <button
              onClick={() => api.shell.openExternal('https://wavi.stream/auth?desktop=1')}
              className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-medium transition-colors whitespace-nowrap"
            >
              Sign in again
            </button>
          </div>
        )}

        {/* Paused / plan limit */}
        {syncStatus === 'paused:limit' && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-cyan-500/5 border border-cyan-500/20 text-xs text-cyan-400">
            <PauseCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">Sync paused — you've reached your free plan limit.</span>
            <button
              onClick={() => api.shell.openExternal('https://wavi.stream/pricing')}
              className="px-2.5 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 font-semibold transition-colors whitespace-nowrap"
            >
              Upgrade
            </button>
          </div>
        )}

        {/* Active uploads */}
        {activeUploads.length > 0 && (
          <div className="bg-[#111] border border-[#1a1a1a] rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <UploadCloud className="w-4 h-4 text-cyan-400 animate-pulse" />
              <h2 className="text-sm font-semibold text-white/80">Uploading</h2>
              <span className="ml-auto text-[10px] text-white/20">{activeUploads.length} file{activeUploads.length !== 1 ? 's' : ''}</span>
            </div>
            {activeUploads.map((item) => {
              const progress = syncProgresses[item.id];
              const pct = progress?.percentage ?? 0;
              const fileName = item.file_name ?? item.type.replace('_', ' ');
              const isError = progress?.status === 'error';
              return (
                <div key={item.id} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-white/60 font-mono truncate max-w-[200px]" title={fileName}>{fileName}</span>
                    {isError
                      ? <span className="text-red-400 text-[10px]">error</span>
                      : <span className="text-cyan-400 tabular-nums">{pct}%</span>
                    }
                  </div>
                  <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${isError ? 'bg-red-500' : 'bg-cyan-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {progress?.bytesUploaded !== undefined && (
                    <div className="flex justify-between text-[10px] text-white/20">
                      <span>{formatBytes(progress.bytesUploaded)} / {formatBytes(progress.bytesTotal ?? 0)}</span>
                      {item.retries > 0 && <span className="text-amber-500/60">retry {item.retries}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Projects list */}
        <div>
          <h2 className="text-sm font-semibold text-white/50 mb-3 uppercase tracking-wider">Projects</h2>
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-5 h-5 border-2 border-white/20 border-t-cyan-500 rounded-full animate-spin" />
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <FolderOpen className="w-10 h-10 text-white/10 mb-3" />
              <p className="text-sm text-white/30">No projects detected yet</p>
              <p className="text-xs text-white/20 mt-1">Add a folder to start monitoring</p>
            </div>
          ) : (
            <div className="space-y-2">
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  progress={Object.values(syncProgresses).find(p => p.projectId === project.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Retry failed */}
        {failed > 0 && (
          <button
            onClick={() => api.sync.retryAll().then(refresh)}
            className="w-full py-2 text-sm text-red-400 border border-red-400/20 rounded-xl hover:bg-red-400/5 transition-colors"
          >
            Retry {failed} failed upload{failed !== 1 ? 's' : ''}
          </button>
        )}
      </div>
    </div>
  );
}

function ProjectRow({ project, progress }: { project: Project; progress?: SyncProgress }) {
  const dawColor = getDawColor(project.daw_type);
  const pct = progress?.percentage;
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);

  const toggleVersions = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (versions.length > 0) return;
    setLoadingVersions(true);
    try {
      const local = await api.versions.getByProject(project.id);
      if (local?.length) { setVersions(local); setLoadingVersions(false); return; }
      // Fallback: try cloud if token available
      const token = await api.auth.getToken();
      if (token && project.cloud_id) {
        const res = await fetch(`https://wavi.stream/api/desktop/versions?projectId=${encodeURIComponent(project.cloud_id)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) setVersions(await res.json());
      }
    } catch { /* non-fatal */ }
    setLoadingVersions(false);
  };

  return (
    <div className="bg-[#111] border border-[#1a1a1a] hover:border-[#2a2a2a] rounded-xl overflow-hidden transition-colors">
      <div className="flex items-center gap-3 p-4">
        <DawLogo daw={project.daw_type} size={34} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-semibold text-white truncate">{project.project_name}</span>
          </div>
          <p className="text-xs text-white/25 font-mono truncate">{truncatePath(project.file_path)}</p>
          {pct !== undefined && (
            <div className="mt-2 h-0.5 bg-white/5 rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-500 rounded-full transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <SyncStatusBadge status={project.sync_status} />
          <div className="flex items-center gap-3 text-[10px] text-white/20">
            <span>{formatBytes(project.file_size)}</span>
            <button
              onClick={toggleVersions}
              className="flex items-center gap-0.5 hover:text-white/50 transition-colors"
              title="Show version history"
            >
              <History className="w-2.5 h-2.5" />
              v{project.version_count}
              {expanded ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
            </button>
            <span>{formatRelativeTime(project.modified_at)}</span>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-[#1a1a1a] px-4 py-3 space-y-2">
          <p className="text-[10px] text-white/25 uppercase tracking-wider flex items-center gap-1">
            <History className="w-3 h-3" /> Version history
          </p>
          {loadingVersions ? (
            <div className="flex items-center gap-2 py-2">
              <div className="w-3 h-3 border border-white/20 border-t-white/60 rounded-full animate-spin" />
              <span className="text-xs text-white/30">Loading…</span>
            </div>
          ) : versions.length === 0 ? (
            <p className="text-xs text-white/20 py-1">No cloud versions yet — sync to create a version.</p>
          ) : (
            <div className="space-y-1">
              {versions.map((v, i) => {
                const labelColor: Record<string, string> = {
                  master: 'text-amber-400 bg-amber-500/10',
                  stem:   'text-violet-400 bg-violet-500/10',
                  bounce: 'text-blue-400 bg-blue-500/10',
                  mix:    'text-cyan-400 bg-cyan-500/10',
                };
                const tag = v.version_type ?? v.label ?? 'project';
                const tagClass = labelColor[tag] ?? 'text-white/30 bg-white/5';
                return (
                  <div key={v.id} className="flex items-center gap-2 py-1.5 border-b border-white/5 last:border-0">
                    <span className="text-[10px] text-white/20 w-5 tabular-nums">{versions.length - i}</span>
                    <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${tagClass}`}>{tag}</span>
                    <span className="text-xs text-white/50 flex-1">{formatRelativeTime(v.created_at)}</span>
                    <span className="text-[10px] text-white/30 font-mono">{formatBytes(v.file_size)}</span>
                    {v.checksum && (
                      <span className="text-[9px] text-white/20 font-mono" title={v.checksum}>{v.checksum.slice(0, 8)}</span>
                    )}
                    {v.cloud_url && (
                      <button
                        onClick={() => api.shell.openExternal(v.cloud_url!)}
                        className="text-[10px] text-cyan-500/50 hover:text-cyan-400 transition-colors"
                      >
                        ↗
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
