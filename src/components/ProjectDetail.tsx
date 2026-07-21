import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api, LinkListItem } from '../lib/api';
import {
  X, FolderOpen, Music, FileText, Image, Archive, File, Play, Pause,
  Package, AlertTriangle, CheckCircle2, Zap, Sparkles,
  ExternalLink, RefreshCw, ChevronDown, ChevronRight, Copy, Link2, Puzzle, ArrowRight,
} from 'lucide-react';
import type { Project, Page } from '../types';
import { formatBytes } from '../lib/utils';
import { DawLogo } from './DawLogo';
import { SyncStatusBadge } from './SyncStatusBadge';
import {
  DetailFile, ROLE_LABELS, groupFilesByRole, pickLatestBounce, expiryToIso, pickShareAsset, ROLE_ORDER,
  buildBounceMediaUrl, deriveProjectSummary, formatFileSize, deriveNextAction,
} from '../lib/projectDetailView';
import { deriveLinkStatus, linkDisplayName } from '../lib/linksView';
import { Button } from './ui/Button';
import { Tabs } from './ui/Tabs';
import { Progress } from './ui/Progress';
import { SectionHeader } from './ui/SectionHeader';
import { FileRow } from './ui/FileRow';
import { EmptyState } from './ui/EmptyState';
import { Skeleton } from './ui/Skeleton';
import { deriveCompatibilityRows, compatibilityHeadline, DawCapabilityReport } from '../lib/compatibilityView';

const ROLE_ICONS: Record<string, React.FC<any>> = {
  project: FolderOpen, audio: Music, stem: Music, sample: Music, midi: FileText,
  artwork: Image, document: FileText, archive: Archive, missing: AlertTriangle, other: File,
};

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
  { id: 'versions', label: 'Versions' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'compatibility', label: 'Compatibility' },
  { id: 'activity', label: 'Activity' },
];
type Tab = 'overview' | 'files' | 'versions' | 'dependencies' | 'compatibility' | 'activity';

interface ProjectDetailProps {
  project: Project;
  onClose: () => void;
  onNavigate?: (page: Page) => void;
}

export function ProjectDetail({ project, onClose, onNavigate }: ProjectDetailProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const [files, setFiles] = useState<DetailFile[]>([]);
  const [versions, setVersions] = useState<any[]>([]);
  const [links, setLinks] = useState<LinkListItem[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [sharingProject, setSharingProject] = useState(false);
  const [prioritizing, setPrioritizing] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(ROLE_ORDER));
  const [showListenPanel, setShowListenPanel] = useState(false);
  const [listenBusy, setListenBusy] = useState(false);
  const [allowDownload, setAllowDownload] = useState(true);
  const [expiry, setExpiry] = useState<'never' | '24h' | '7d' | '30d'>('never');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState(false);
  const [compat, setCompat] = useState<DawCapabilityReport | null>(null);

  // Guards against stale async: a load() resolving after the user switched
  // projects must not paint the previous project's files (which would let the
  // media element load a bounce from the prior project).
  const loadedProjectRef = useRef<string>(project.id);

  const load = useCallback(async () => {
    const forProject = project.id;
    setLoading(true);
    try {
      const [f, v, l, a] = await Promise.all([
        api.files.getByProject(forProject),
        api.versions.getByProject(forProject).catch(() => []),
        api.links.getAll().catch(() => []),
        api.activity.getAll().catch(() => []),
      ]);
      if (loadedProjectRef.current !== forProject) return; // switched away mid-flight
      setFiles(f as unknown as DetailFile[]);
      setVersions(Array.isArray(v) ? v : []);
      setLinks((Array.isArray(l) ? l : []).filter((x: LinkListItem) => x.project_id === forProject));
      setActivity((Array.isArray(a) ? a : []).filter((x: any) => x.project_id === forProject).slice(0, 50));
    } catch { /* individual sections degrade */ }
    if (loadedProjectRef.current === forProject) setLoading(false);
  }, [project.id]);

  // On project switch: stop playback, clear the previous media source and
  // player state, then reload for the new project.
  useEffect(() => {
    loadedProjectRef.current = project.id;
    const el = audioRef.current;
    if (el) { el.pause(); el.removeAttribute('src'); el.load(); }
    setFiles([]);
    setPlaying(false);
    setPlayError(false);
    setTab('overview');
    load();
  }, [project.id, load]);

  // DAW compatibility report for this project (stale-async guarded by project id).
  useEffect(() => {
    let active = true;
    setCompat(null);
    api.daw.getCapabilities({ dawType: project.daw_type, filePath: project.file_path })
      .then((r) => { if (active) setCompat(r); })
      .catch(() => { if (active) setCompat(null); });
    return () => { active = false; };
  }, [project.id, project.daw_type, project.file_path]);

  const projectRoot = project.file_path ? project.file_path.split(/[/\\]/).slice(0, -1).join('/') + '/' : '';
  const groups = useMemo(() => groupFilesByRole(files), [files]);
  const summary = useMemo(() => deriveProjectSummary(files), [files]);
  const bounce = useMemo(() => pickLatestBounce(files), [files]);
  // Opaque, id-only media URL — never a raw filesystem path. null → no playable
  // bounce, so we never hand the <audio> element an empty or file:// src.
  const bounceMediaUrl = useMemo(() => buildBounceMediaUrl(project.id, bounce), [project.id, bounce]);
  const missingFiles = useMemo(() => files.filter((f) => f.local_status === 'missing'), [files]);
  const activeLinks = links.filter((l) => deriveLinkStatus(l) === 'active');

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); setPlaying(false); }
    else { el.play().then(() => setPlaying(true)).catch(() => setPlayError(true)); }
  };

  const handleOpenInDaw = () => { if (project.file_path) api.shell.openPath(project.file_path); };
  const handleRevealFolder = () => { if (project.file_path) api.shell.revealInFinder(project.file_path); };

  const handlePrioritize = async () => {
    setPrioritizing(true);
    setStatusMsg(null);
    try {
      let result = await api.sync.prioritizeProject(project.id);
      if (result.needsConfirmation) {
        const ok = window.confirm(
          `Retry ${result.retryCount} failed uploads for “${project.project_name}”?\n\nThis may use significant network bandwidth.`,
        );
        if (!ok) return;
        result = await api.sync.prioritizeProject(project.id, { force: true });
      }
      if (!result.needsConfirmation) {
        if (result.bumped + result.requeued === 0) {
          if (result.skippedMissing > 0) setStatusMsg('Local files are missing on disk — nothing to retry.');
          else if (result.blockedPermanent > 0) setStatusMsg('Uploads are blocked by permission or not-found errors — see Activity.');
          else setStatusMsg('Nothing is queued for this project.');
        } else {
          setStatusMsg('Project moved to the front of the sync queue.');
        }
      }
    } catch (e) {
      setStatusMsg(`Error: ${(e as Error)?.message ?? 'unknown'}`);
    } finally { setPrioritizing(false); }
  };

  const handlePublish = async () => {
    setPublishing(true);
    setStatusMsg(null);
    try {
      const r = await api.project.publishVersion({ localProjectId: project.id });
      if (r.error) setStatusMsg(`Error: ${r.error}`);
      else if (r.skipped) setStatusMsg(`Already up to date (v${r.versionNumber})`);
      else { setStatusMsg(`Published v${r.versionNumber} — ${r.fileCount} files`); await load(); }
    } catch (e: any) { setStatusMsg(`Error: ${e?.message ?? 'unknown'}`); }
    setPublishing(false);
  };

  const handleShareProject = async () => {
    setSharingProject(true);
    setStatusMsg(null);
    try {
      const r = await api.project.createLink({ projectId: project.id, cloudProjectId: project.cloud_id ?? undefined, allowDownload: true });
      if (r.error) setStatusMsg(`Error: ${r.error}`);
      else if (r.linkUrl) {
        await navigator.clipboard.writeText(r.linkUrl);
        setStatusMsg('Project Link created and copied.');
        await load();
      }
    } catch (e: any) { setStatusMsg(`Error: ${e?.message ?? 'unknown'}`); }
    setSharingProject(false);
  };

  const handleCreateListenLink = async () => {
    setListenBusy(true);
    setStatusMsg(null);
    try {
      const best = pickShareAsset(files);
      if (!best) { setStatusMsg('No synced audio yet — wait for the upload to complete.'); return; }
      const assetId = (best.cloud_asset_id ?? null) as string | null;
      if (!assetId) { setStatusMsg('Audio not yet registered with Wavi. Sync the project first.'); return; }
      const result = await api.share.createLink({ assetId, projectId: project.id, allowDownload, expiresAt: expiryToIso(expiry) });
      if (result.error) setStatusMsg(`Error: ${result.error}`);
      else if (result.shareUrl) {
        await navigator.clipboard.writeText(result.shareUrl);
        setStatusMsg('Listen Link created and copied.');
        setShowListenPanel(false);
        await load();
      }
    } catch (e: any) { setStatusMsg(`Error: ${e?.message ?? 'unknown'}`); }
    finally { setListenBusy(false); }
  };

  const cloudReady = !!project.cloud_id && project.sync_status === 'synced';

  // Honest next recommended action (uses only present data).
  const nextAction = useMemo(() => loading ? null : deriveNextAction({
    missingCount: missingFiles.length,
    cloudReady,
    versionCount: versions.length,
    activeLinkCount: activeLinks.length,
  }), [loading, missingFiles.length, cloudReady, versions.length, activeLinks.length]);

  const relOf = (f: DetailFile) => f.file_path.startsWith(projectRoot)
    ? f.file_path.slice(projectRoot.length).replace(/^[/\\]/, '') : f.file_name;

  const lastUpdated = project.modified_at ? new Date(project.modified_at).toLocaleDateString() : null;

  const player = bounce && (
    <div className="flex items-center gap-3 bg-surface-2 border border-border rounded-lg px-3 py-2">
      <button type="button" onClick={togglePlay} disabled={playError || !bounceMediaUrl} aria-label={playing ? 'Pause' : 'Play'}
        className="w-8 h-8 rounded-full bg-primary hover:bg-primary/90 disabled:opacity-30 text-primary-foreground flex items-center justify-center flex-shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
      </button>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground/80 truncate">{bounce.file_name}</p>
        <p className="text-[10px] text-muted-fg">
          {!bounceMediaUrl ? 'Bounce unavailable — file is missing on disk.'
            : playError ? "Couldn't play this file — use Open instead."
            : 'Latest bounce'}
        </p>
      </div>
      {/* Opaque protocol URL only; never file://. Element omitted (no src="") when unplayable. */}
      {bounceMediaUrl && (
        <audio ref={audioRef} src={bounceMediaUrl} onEnded={() => setPlaying(false)} onError={() => setPlayError(true)} />
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-overlay/60 backdrop-blur-sm flex items-end justify-end" onClick={onClose}>
      <div className="w-[560px] h-full bg-surface border-l border-border flex flex-col shadow-lg" onClick={(e) => e.stopPropagation()}>

        {/* Compact header */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border">
          <DawLogo daw={project.daw_type ?? 'Unknown'} size={32} />
          <div className="flex-1 min-w-0">
            <h2 className="font-brand text-base font-bold text-foreground truncate">{project.project_name}</h2>
            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-fg">
              <SyncStatusBadge status={project.sync_status ?? 'pending'} />
              <span>·</span>
              <span className="truncate">{project.daw_type ?? 'DAW'}</span>
              <span>·</span>
              <span className="font-mono">v{project.version_count ?? 1}</span>
              {lastUpdated && <><span>·</span><span>{lastUpdated}</span></>}
            </div>
          </div>
          <Button variant="ghost" size="compact" onClick={() => onNavigate?.('copilot')} title="Ask Copilot about this project">
            <Sparkles /> Copilot
          </Button>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="w-4 h-4 text-white/50" />
          </button>
        </div>

        {/* Primary + secondary actions */}
        <div className="px-5 py-3 border-b border-border-subtle space-y-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="primary" onClick={handleOpenInDaw}><ExternalLink /> Open in DAW</Button>
            <Button variant="secondary" onClick={handlePrioritize} loading={prioritizing}
              disabled={!(project.sync_status === 'pending' || project.sync_status === 'failed')}
              title="Move this project to the front of the sync queue">
              {!prioritizing && <Zap />} Sync Changes
            </Button>
            <Button variant="secondary" onClick={handlePublish} loading={publishing} disabled={!cloudReady}
              title={cloudReady ? 'Create an immutable version of this project' : 'Available once the project is synced'}>
              {!publishing && <RefreshCw />} Publish Version
            </Button>
            <Button variant="secondary" onClick={handleShareProject} loading={sharingProject} disabled={!cloudReady}
              title={cloudReady ? 'Share the full project (restore + open in DAW)' : 'Available once the project is synced'}>
              {!sharingProject && <Package />} Share Project
            </Button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" size="compact" onClick={() => setShowListenPanel((v) => !v)} disabled={!cloudReady}
              title={cloudReady ? 'Share a playable Listen Link' : 'Available once the project is synced'}>
              <Link2 /> Copy Listen Link
            </Button>
            <Button variant="ghost" size="compact" onClick={handleRevealFolder} disabled={!project.file_path} title="Reveal the project folder in Finder">
              <FolderOpen /> Reveal Folder
            </Button>
          </div>

          {showListenPanel && (
            <div className="bg-surface-2 border border-border rounded-lg p-3 space-y-2">
              <label className="flex items-center justify-between text-xs text-foreground/70">
                Allow download
                <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} />
              </label>
              <label className="flex items-center justify-between text-xs text-foreground/70">
                Expires
                <select value={expiry} onChange={(e) => setExpiry(e.target.value as any)}
                  className="bg-input border border-border rounded px-2 py-1 text-xs text-foreground/80">
                  <option value="never">Never</option>
                  <option value="24h">In 24 hours</option>
                  <option value="7d">In 7 days</option>
                  <option value="30d">In 30 days</option>
                </select>
              </label>
              <div className="flex justify-end">
                <Button variant="secondary" size="compact" onClick={handleCreateListenLink} loading={listenBusy}>Create &amp; Copy</Button>
              </div>
            </div>
          )}

          {statusMsg && (
            <p role="status" className={`text-[11px] ${statusMsg.startsWith('Error') ? 'text-destructive' : 'text-primary'}`}>{statusMsg}</p>
          )}
        </div>

        {/* Workspace tabs */}
        <Tabs tabs={TABS} value={tab} onValueChange={(id) => setTab(id as Tab)} />

        {/* Content */}
        <div className="flex-1 overflow-y-auto" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {loading ? (
            <div className="p-5 space-y-3" aria-busy>
              <Skeleton className="h-16" />
              <Skeleton lines={4} />
            </div>
          ) : tab === 'overview' ? (
            <div className="p-5 space-y-5">
              {player}
              {nextAction && (
                <div className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 border ${
                  nextAction.tone === 'warn' ? 'text-warning border-warning/20 bg-warning/[0.06]'
                  : nextAction.tone === 'ok' ? 'text-success border-success/20 bg-success/[0.06]'
                  : 'text-foreground/70 border-border bg-surface-2'}`}>
                  <ArrowRight className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {nextAction.text}
                </div>
              )}
              <div>
                <SectionHeader label="Package" action={<span className="text-[10px] text-muted-fg font-mono">{formatFileSize(summary.totalSize)}</span>} />
                <Progress value={summary.packageCompleteness} label="Completeness" />
                <div className="grid grid-cols-3 gap-x-4 gap-y-1.5 mt-3 text-[11px]">
                  <Stat label="Native project" value={summary.hasNativeProject ? 'Yes' : 'No'} warn={!summary.hasNativeProject} />
                  <Stat label="Latest bounce" value={summary.hasBounce ? 'Yes' : 'No'} />
                  <Stat label="Stems" value={String(summary.stemCount)} />
                  <Stat label="MIDI" value={String(summary.midiCount)} />
                  <Stat label="Synced" value={`${summary.syncedCount}/${summary.totalFiles}`} />
                  <Stat label="Missing" value={String(summary.missingCount)} warn={summary.missingCount > 0} />
                </div>
              </div>
              {activity.length > 0 && (
                <div>
                  <SectionHeader label="Recent activity" action={<button onClick={() => setTab('activity')} className="text-[10px] text-primary/80 hover:text-primary">View all</button>} />
                  <div className="space-y-1">
                    {activity.slice(0, 3).map((a: any) => (
                      <div key={a.id} className="flex items-start gap-2 text-[11px]">
                        <span className="text-muted-fg w-24 flex-shrink-0 font-mono">{a.created_at ? new Date(a.created_at).toLocaleDateString() : ''}</span>
                        <span className="text-foreground/60 min-w-0 truncate" title={a.message}>{a.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {activeLinks.length > 0 && (
                <div>
                  <SectionHeader label="Links" count={activeLinks.length} action={<button onClick={() => onNavigate?.('links')} className="text-[10px] text-primary/80 hover:text-primary">Manage</button>} />
                  <div className="space-y-1">
                    {activeLinks.slice(0, 3).map((l) => (
                      <div key={l.tracking_id} className="flex items-center gap-2 text-[11px]">
                        <Link2 className="w-3 h-3 text-primary/50 flex-shrink-0" />
                        <span className="text-foreground/70 truncate">{linkDisplayName(l)}</span>
                        <button onClick={() => navigator.clipboard.writeText(l.url)} title="Copy" className="ml-auto p-0.5 rounded hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><Copy className="w-3 h-3 text-white/40" /></button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : tab === 'files' ? (
            <div className="py-2">
              {groups.length === 0 ? (
                <EmptyState icon={File} title="No files indexed" description="This project has no associated files yet, or they are still being discovered." />
              ) : groups.map(({ role, files: roleFiles }) => {
                const Icon = ROLE_ICONS[role] ?? File;
                const expanded = expandedGroups.has(role);
                return (
                  <div key={role}>
                    <button type="button" onClick={() => setExpandedGroups((p) => { const n = new Set(p); n.has(role) ? n.delete(role) : n.add(role); return n; })}
                      aria-expanded={expanded}
                      className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-white/[0.02] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
                      {expanded ? <ChevronDown className="w-3 h-3 text-white/30" /> : <ChevronRight className="w-3 h-3 text-white/30" />}
                      <Icon className="w-3.5 h-3.5 text-white/30" />
                      <span className="text-xs font-medium text-white/40 uppercase tracking-wider">{ROLE_LABELS[role] ?? role}</span>
                      <span className="text-[10px] text-muted-fg ml-auto font-mono">{roleFiles.length}</span>
                    </button>
                    {expanded && roleFiles.map((fl) => (
                      <FileRow
                        key={fl.id}
                        fileName={fl.file_name}
                        relPath={relOf(fl)}
                        size={formatBytes(fl.file_size)}
                        missing={fl.local_status === 'missing'}
                        synced={fl.sync_status === 'synced' && !!fl.cloud_asset_id}
                        checksum={fl.checksum}
                        onOpen={() => api.shell.openPath(fl.file_path)}
                        onReveal={() => api.shell.revealInFinder(fl.file_path)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          ) : tab === 'versions' ? (
            <div className="p-4">
              {versions.length === 0 ? (
                <EmptyState icon={CheckCircle2} title="No versions yet"
                  description="Publish Version creates an immutable snapshot you can share and restore." />
              ) : (
                <div className="space-y-2">
                  {versions.map((v: any) => (
                    <div key={v.id} className="flex items-center gap-3 py-2.5 border-b border-border-subtle">
                      <CheckCircle2 className="w-3.5 h-3.5 text-primary/50 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground/75">{v.label ?? 'Version'} <span className="text-[10px] text-muted-fg ml-1 font-mono">{v.created_at ? new Date(v.created_at).toLocaleString() : ''}</span></p>
                        {v.file_size ? <p className="text-[10px] text-muted-fg font-mono">{formatBytes(v.file_size)}</p> : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : tab === 'dependencies' ? (
            <div className="p-5 space-y-4">
              <div>
                <SectionHeader label="Missing files" count={missingFiles.length} />
                {missingFiles.length === 0 ? (
                  <p className="text-[11px] text-muted-fg">All indexed files are present on disk.</p>
                ) : (
                  <div className="space-y-1">
                    {missingFiles.map((f) => (
                      <div key={f.id} className="flex items-center gap-2 text-[11px]">
                        <AlertTriangle className="w-3 h-3 text-warning flex-shrink-0" />
                        <span className="text-foreground/70 truncate">{f.file_name}</span>
                        <span className="ml-auto font-mono text-muted-fg truncate max-w-[180px]" title={relOf(f)}>{relOf(f)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <SectionHeader label="Plugins" />
                <div className="flex items-center gap-2 text-[11px] text-muted-fg">
                  <Puzzle className="w-3.5 h-3.5" />
                  {compat?.capabilities.scanPlugins
                    ? 'Plugin scan available.'
                    : 'Plugin scanning is not yet implemented — plugin dependencies are unknown.'}
                </div>
              </div>
              <p className="text-[10px] text-white/25">
                Portable-session dependency reports arrive with the DAWproject packaging pipeline.
              </p>
            </div>
          ) : tab === 'compatibility' ? (
            <div className="p-5">
              {!compat ? (
                <p className="text-[11px] text-muted-fg">Checking compatibility…</p>
              ) : (
                <>
                  <p className="text-xs font-semibold text-foreground/75 mb-3">{compatibilityHeadline(compat)}</p>
                  <div className="space-y-1.5">
                    {deriveCompatibilityRows(compat).map((row) => (
                      <div key={row.label} className="flex items-center justify-between text-[11px] py-1 border-b border-border-subtle last:border-0">
                        <span className="text-muted-fg">{row.label}</span>
                        <span className={row.tone === 'ok' ? 'text-success' : row.tone === 'warn' ? 'text-warning' : 'text-white/40'}>{row.value}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="p-4">
              {activity.length === 0 ? (
                <EmptyState icon={AlertTriangle} title="No activity yet" description="Sync, publish, and link events for this project will appear here." />
              ) : (
                <div className="space-y-1">
                  {activity.map((a: any) => (
                    <div key={a.id} className="flex items-start gap-2 py-1.5 border-b border-border-subtle last:border-0">
                      <span className="text-[10px] text-muted-fg w-32 flex-shrink-0 font-mono">{a.created_at ? new Date(a.created_at).toLocaleString() : ''}</span>
                      <span className="text-[11px] text-foreground/55 min-w-0 truncate" title={a.message}>{a.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-muted-fg">{label}</p>
      <p className={`text-xs font-medium ${warn ? 'text-warning' : 'text-foreground/80'}`}>{value}</p>
    </div>
  );
}
