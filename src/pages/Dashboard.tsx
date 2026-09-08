import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, UploadCloud, FolderOpen, CheckCircle2, AlertCircle, Clock, PauseCircle, ChevronDown, ChevronRight, History, Zap, Globe, Wand2 } from 'lucide-react';
import { api } from '../lib/api';
import { SyncStatusBadge } from '../components/SyncStatusBadge';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { DawLogo } from '../components/DawLogo';
import { ProjectDetail } from '../components/ProjectDetail';
import { formatBytes, formatRelativeTime, truncatePath } from '../lib/utils';
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
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
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

      // Process each file through the sync agent
      const filePaths = validFiles.map(file => (file as any).path || (file as any).webkitRelativePath || file.name);
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
      className={`h-full overflow-y-auto relative ${isDragOver ? 'bg-primary/5' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {selectedProject && (
        <ProjectDetail
          project={selectedProject}
          onClose={() => { setSelectedProject(null); refresh(); }}
          onNavigate={onNavigate}
        />
      )}

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-sm border-2 border-dashed border-primary/50">
          <div className="text-center">
            <UploadCloud className="w-12 h-12 text-primary mx-auto mb-2" />
            <p className="text-lg font-semibold text-primary">Drop files to import</p>
            <p className="text-sm text-primary/60">Audio files and DAW projects</p>
          </div>
        </div>
      )}
      
      <div className="p-6 max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-brand text-lg font-bold text-foreground">Dashboard</h1>
            <p className="text-xs text-muted-fg mt-0.5">
              {projects.length} project{projects.length !== 1 ? 's' : ''} detected
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Sync status pill */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#111] border border-[#222]">
              <div className={`w-1.5 h-1.5 rounded-full ${
                syncStatus.includes('uploading') ? 'bg-primary animate-pulse'
                : syncStatus.includes('paused') ? 'bg-warning'
                : 'bg-success'
              }`} />
              <span className="text-xs text-fg-tertiary">
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:bg-primary disabled:opacity-40 text-black text-xs font-semibold transition-colors"
            >
              <Zap className={`w-3.5 h-3.5 ${syncing ? 'animate-pulse' : ''}`} />
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
            {/* Open Vault */}
            <button
              onClick={() => api.shell.openExternal('https://wavi.stream/vault')}
              title="Open Vault in browser"
              className="p-1.5 rounded-lg bg-[#111] border border-[#222] text-fg-quaternary hover:text-primary transition-colors"
            >
              <Globe className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={refresh}
              title="Refresh"
              className="p-1.5 rounded-lg bg-[#111] border border-[#222] text-fg-quaternary hover:text-fg-secondary transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Sync explanation */}
        <div className="text-meta text-fg-quaternary bg-[#0d0d0d] border border-[#1a1a1a] rounded-lg px-3 py-2 leading-relaxed">
          <span className="text-fg-quaternary font-medium">How sync works: </span>
          Wavi Studio watches your DAW folders and automatically uploads new and changed project files to your Vault at
          <button onClick={() => api.shell.openExternal('https://wavi.stream/vault')} className="text-primary/70 hover:text-primary mx-1 underline">wavi.stream/vault</button>
          whenever they change. Use <span className="text-fg-quaternary">Sync Now</span> to force an immediate upload.
        </div>

        {/* Stats */}
        <div className="grid grid-cols-5 gap-3">
          {[
            { label: 'Total', value: projects.length, icon: FolderOpen, color: 'text-fg-tertiary', onClick: undefined },
            { label: 'Synced', value: synced, icon: CheckCircle2, color: 'text-success', onClick: undefined },
            { label: 'Pending', value: pending, icon: Clock, color: 'text-warning', onClick: undefined },
            { label: 'Failed', value: failed, icon: AlertCircle, color: 'text-destructive', onClick: undefined },
            { label: 'Review', value: pendingAssociations, icon: Wand2, color: pendingAssociations > 0 ? 'text-primary' : 'text-fg-quaternary', onClick: pendingAssociations > 0 ? () => onNavigate?.('review') : undefined },
          ].map(({ label, value, icon: Icon, color, onClick }) => (
            <div
              key={label}
              onClick={onClick}
              className={`bg-[#111] border border-[#1a1a1a] rounded-xl p-4 ${
                onClick ? 'cursor-pointer hover:border-primary/30 transition-colors' : ''
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-fg-quaternary">{label}</span>
                <Icon className={`w-3.5 h-3.5 ${color}`} />
              </div>
              <p className={`text-2xl font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        {/* Paused / auth error */}
        {syncStatus === 'paused:auth' && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-warning/5 border border-warning/20 text-xs text-warning">
            <PauseCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">Sync paused — session expired.</span>
            <button
              onClick={() => api.shell.openExternal('https://wavi.stream/auth?desktop=1')}
              className="px-2.5 py-1 rounded-lg bg-warning/20 hover:bg-warning/30 text-warning font-medium transition-colors whitespace-nowrap"
            >
              Sign in again
            </button>
          </div>
        )}

        {/* Paused / plan limit */}
        {syncStatus === 'paused:limit' && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-primary/5 border border-primary/20 text-xs text-primary">
            <PauseCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">Sync paused — you've reached your free plan limit.</span>
            <button
              onClick={() => api.shell.openExternal('https://wavi.stream/pricing')}
              className="px-2.5 py-1 rounded-lg bg-primary/20 hover:bg-primary/30 text-primary font-semibold transition-colors whitespace-nowrap"
            >
              Upgrade
            </button>
          </div>
        )}

        {/* Active uploads */}
        {activeUploads.length > 0 && (
          <div className="bg-[#111] border border-[#1a1a1a] rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <UploadCloud className="w-4 h-4 text-primary animate-pulse" />
              <h2 className="text-sm font-semibold text-fg-secondary">Uploading</h2>
              <span className="ml-auto text-meta text-fg-quaternary">{activeUploads.length} file{activeUploads.length !== 1 ? 's' : ''}</span>
            </div>
            {activeUploads.map((item) => {
              const progress = syncProgresses[item.id];
              const pct = progress?.percentage ?? 0;
              const fileName = item.file_name ?? item.type.replace('_', ' ');
              const isError = progress?.status === 'error';
              return (
                <div key={item.id} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-fg-tertiary font-mono truncate max-w-[200px]" title={fileName}>{fileName}</span>
                    {isError
                      ? <span className="text-destructive text-meta">error</span>
                      : <span className="text-primary tabular-nums">{pct}%</span>
                    }
                  </div>
                  <div className="h-1 bg-layer-2 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${isError ? 'bg-destructive' : 'bg-primary'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {progress?.bytesUploaded !== undefined && (
                    <div className="flex justify-between text-meta text-fg-quaternary">
                      <span>{formatBytes(progress.bytesUploaded)} / {formatBytes(progress.bytesTotal ?? 0)}</span>
                      {item.retries > 0 && <span className="text-warning/60">retry {item.retries}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Projects list */}
        <div>
          <h2 className="text-sm font-semibold text-fg-tertiary mb-3 uppercase tracking-wider">Projects</h2>
          {loading ? (
            <div className="space-y-2 py-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14 w-2/3" />
            </div>
          ) : projects.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title="No projects detected yet"
              description="Add a watched folder and Wavi will detect your DAW projects automatically."
            />
          ) : (
            <div className="space-y-2">
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  progress={Object.values(syncProgresses).find(p => p.projectId === project.id)}
                  onOpen={() => setSelectedProject(project)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Retry failed */}
        {failed > 0 && (
          <button
            onClick={() => api.sync.retryAll().then(refresh)}
            className="w-full py-2 text-sm text-destructive border border-destructive/20 rounded-xl hover:bg-destructive/5 transition-colors"
          >
            Retry {failed} failed upload{failed !== 1 ? 's' : ''}
          </button>
        )}
      </div>
    </div>
  );
}

function ProjectRow({ project, progress, onOpen }: { project: Project; progress?: SyncProgress; onOpen: () => void }) {
  const pct = progress?.percentage;
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [prioritizing, setPrioritizing] = useState(false);
  const [prioritizeNote, setPrioritizeNote] = useState<string | null>(null);

  const handlePrioritize = async () => {
    setPrioritizing(true);
    setPrioritizeNote(null);
    try {
      let result = await api.sync.prioritizeProject(project.id);
      if (result.needsConfirmation) {
        // Large retry batches can use significant bandwidth — confirm first.
        const ok = window.confirm(
          `Retry ${result.retryCount} failed uploads for “${project.project_name}”?\n\n` +
          `This may use significant network bandwidth. Uploads run in the background and can be paused from Settings.`
        );
        if (!ok) return;
        result = await api.sync.prioritizeProject(project.id, { force: true });
      }
      if (!result.needsConfirmation && result.bumped + result.requeued === 0) {
        // The click must never look like it worked when nothing could be done.
        if (result.skippedMissing > 0) setPrioritizeNote('Local files are missing on disk — nothing to retry.');
        else if (result.blockedPermanent > 0) setPrioritizeNote('Uploads are blocked by permission or not-found errors — see Activity.');
        else setPrioritizeNote('Nothing is queued for this project.');
      }
    } catch (e) {
      setPrioritizeNote(`Could not prioritize: ${(e as Error)?.message ?? 'unknown error'}`);
    } finally {
      setPrioritizing(false);
    }
  };
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
        const res = await fetch(`${window.waviAPI.config.apiBase}/desktop/versions?projectId=${encodeURIComponent(project.cloud_id)}`, {
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
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onOpen} title="Open project details">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-semibold text-white truncate">{project.project_name}</span>
          </div>
          <p className="text-xs text-fg-quaternary font-mono truncate">{truncatePath(project.file_path)}</p>
          {pct !== undefined && (
            <div className="mt-2 h-0.5 bg-layer-2 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <SyncStatusBadge status={project.sync_status} />
          <div className="flex items-center gap-3 text-meta text-fg-quaternary">
            <span>{formatBytes(project.file_size)}</span>
            <button
              onClick={toggleVersions}
              className="flex items-center gap-0.5 hover:text-fg-tertiary transition-colors"
              title="Show version history"
            >
              <History className="w-2.5 h-2.5" />
              v{project.version_count}
              {expanded ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
            </button>
            <span>{formatRelativeTime(project.modified_at)}</span>
          </div>
          {(project.sync_status === 'pending' || project.sync_status === 'failed') && (
            <div className="flex flex-col items-end gap-0.5">
              <button
                onClick={handlePrioritize}
                disabled={prioritizing}
                className="flex items-center gap-1 text-meta font-medium text-primary hover:text-primary transition-colors disabled:opacity-40"
                title="Jump this project ahead of the rest of the sync queue (retries failed uploads too)"
              >
                {prioritizing
                  ? <div className="w-2.5 h-2.5 border border-primary border-t-transparent rounded-full animate-spin" />
                  : <Zap className="w-2.5 h-2.5" />}
                {prioritizing ? 'Prioritizing…' : 'Sync This Project'}
              </button>
              {prioritizeNote && (
                <p className="text-meta text-warning/70 max-w-[180px] text-right">{prioritizeNote}</p>
              )}
            </div>
          )}
          {/* Sharing, publishing and file management moved to Project Detail —
              the row stays focused on status and quick sync actions. */}
          <button
            onClick={onOpen}
            className="flex items-center gap-1 text-meta font-medium text-fg-quaternary hover:text-primary transition-colors"
            title="Open project details — play, publish, share and manage files"
          >
            Open project <ChevronRight className="w-2.5 h-2.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-[#1a1a1a] px-4 py-3 space-y-2">
          <p className="text-meta text-fg-quaternary uppercase tracking-wider flex items-center gap-1">
            <History className="w-3 h-3" /> Version history
          </p>
          {loadingVersions ? (
            <div className="flex items-center gap-2 py-2">
              <div className="w-3 h-3 border border-hairline-focus border-t-white/60 rounded-full animate-spin" />
              <span className="text-xs text-fg-quaternary">Loading…</span>
            </div>
          ) : versions.length === 0 ? (
            <p className="text-xs text-fg-quaternary py-1">No cloud versions yet — sync to create a version.</p>
          ) : (
            <div className="space-y-1">
              {versions.map((v, i) => {
                const labelColor: Record<string, string> = {
                  master: 'text-warning bg-warning/10',
                  stem:   'text-accent bg-accent/10',
                  bounce: 'text-info bg-info/10',
                  mix:    'text-primary bg-primary/10',
                };
                const tag = v.version_type ?? v.label ?? 'project';
                const tagClass = labelColor[tag] ?? 'text-fg-quaternary bg-layer-2';
                return (
                  <div key={v.id} className="flex items-center gap-2 py-1.5 border-b border-hairline last:border-0">
                    <span className="text-meta text-fg-quaternary w-5 tabular-nums">{versions.length - i}</span>
                    <span className={`px-1 py-0.5 rounded text-meta font-medium ${tagClass}`}>{tag}</span>
                    <span className="text-xs text-fg-tertiary flex-1">{formatRelativeTime(v.created_at)}</span>
                    <span className="text-meta text-fg-quaternary font-mono">{formatBytes(v.file_size)}</span>
                    {v.checksum && (
                      <span className="text-meta text-fg-quaternary font-mono" title={v.checksum}>{v.checksum.slice(0, 8)}</span>
                    )}
                    {v.cloud_url && (
                      <button
                        onClick={() => api.shell.openExternal(v.cloud_url!)}
                        className="text-meta text-primary/50 hover:text-primary transition-colors"
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
