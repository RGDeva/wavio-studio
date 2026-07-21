import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api, LinkListItem } from '../lib/api';
import {
  X, FolderOpen, Music, FileText, Image, Archive, File, Play, Pause,
  Package, AlertTriangle, CheckCircle2, Cloud, HardDrive, Zap, Sparkles,
  ExternalLink, RefreshCw, ChevronDown, ChevronRight, Copy, Check, Loader2, Link2, Ban,
} from 'lucide-react';
import type { Project, Page } from '../types';
import { formatBytes } from '../lib/utils';
import { DawLogo } from './DawLogo';
import { SyncStatusBadge } from './SyncStatusBadge';
import {
  DetailFile, ROLE_LABELS, groupFilesByRole, pickLatestBounce, expiryToIso, pickShareAsset, ROLE_ORDER,
  buildBounceMediaUrl, deriveProjectSummary, formatFileSize,
} from '../lib/projectDetailView';
import { deriveLinkStatus, linkDisplayName } from '../lib/linksView';
import { deriveCompatibilityRows, compatibilityHeadline, DawCapabilityReport } from '../lib/compatibilityView';

const ROLE_ICONS: Record<string, React.FC<any>> = {
  project: FolderOpen, audio: Music, stem: Music, sample: Music, midi: FileText,
  artwork: Image, document: FileText, archive: Archive, missing: AlertTriangle, other: File,
};

function FileRow({ file, projectRoot }: { file: DetailFile; projectRoot: string }) {
  const [copied, setCopied] = useState(false);
  const synced = file.sync_status === 'synced' && file.cloud_asset_id;
  const localPresent = file.local_status !== 'missing';
  const relPath = file.file_path.startsWith(projectRoot)
    ? file.file_path.slice(projectRoot.length).replace(/^[/\\]/, '')
    : file.file_name;
  return (
    <div className="group flex items-start gap-2 px-3 py-2.5 hover:bg-white/[0.03] transition-colors border-b border-white/5 last:border-0">
      <File className="w-3.5 h-3.5 text-white/25 mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm text-white/80 truncate">{file.file_name}</span>
          {!localPresent && <span className="text-[9px] text-red-400/80 bg-red-900/20 rounded px-1">missing</span>}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-white/30">
          <span className="font-mono truncate max-w-[180px]" title={relPath}>{relPath}</span>
          <span>{formatBytes(file.file_size)}</span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          {synced
            ? <span className="flex items-center gap-0.5 text-[9px] text-cyan-400/70"><Cloud className="w-2.5 h-2.5" /> synced</span>
            : <span className="flex items-center gap-0.5 text-[9px] text-white/30"><HardDrive className="w-2.5 h-2.5" /> local only</span>}
          {file.checksum && (
            <button
              onClick={() => navigator.clipboard.writeText(file.checksum!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
              title="Copy checksum" className="flex items-center gap-0.5 text-[9px] text-white/20 hover:text-white/50">
              {copied ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Copy className="w-2.5 h-2.5" />}
            </button>
          )}
        </div>
      </div>
      {localPresent && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          <button onClick={() => api.shell.openPath(file.file_path)} title="Open" className="p-1 rounded hover:bg-white/10">
            <ExternalLink className="w-3 h-3 text-white/40" />
          </button>
          <button onClick={() => api.shell.revealInFinder(file.file_path)} title="Reveal in Finder" className="p-1 rounded hover:bg-white/10">
            <FolderOpen className="w-3 h-3 text-white/40" />
          </button>
        </div>
      )}
    </div>
  );
}

interface ProjectDetailProps {
  project: Project;
  onClose: () => void;
  onNavigate?: (page: Page) => void;
}

type Tab = 'files' | 'versions' | 'links' | 'activity' | 'overview';

export function ProjectDetail({ project, onClose, onNavigate }: ProjectDetailProps) {
  const [tab, setTab] = useState<Tab>('files');
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
  // Listen-link creation (relocated from the old Dashboard row controls)
  const [showListenPanel, setShowListenPanel] = useState(false);
  const [listenBusy, setListenBusy] = useState(false);
  const [allowDownload, setAllowDownload] = useState(true);
  const [expiry, setExpiry] = useState<'never' | '24h' | '7d' | '30d'>('never');
  // Bounce player
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState(false);
  // DAW compatibility (adapter capability report)
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
  const totalSize = files.reduce((s, f) => s + (f.file_size ?? 0), 0);
  const syncedCount = files.filter((f) => f.sync_status === 'synced').length;

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); setPlaying(false); }
    else { el.play().then(() => setPlaying(true)).catch(() => setPlayError(true)); }
  };

  const handleOpenInDaw = () => { if (project.file_path) api.shell.openPath(project.file_path); };

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

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end justify-end" onClick={onClose}>
      <div className="w-[560px] h-full bg-[#0a0a0a] border-l border-white/8 flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/8">
          <DawLogo daw={project.daw_type ?? 'Unknown'} size={34} />
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-white truncate">{project.project_name}</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <SyncStatusBadge status={project.sync_status ?? 'pending'} />
              <span className="text-[10px] text-white/20 truncate">{files.length} files · {formatBytes(totalSize)} · {syncedCount}/{files.length} synced</span>
            </div>
          </div>
          <button
            onClick={() => onNavigate?.('copilot')}
            title="Ask Copilot about this project"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 transition-colors">
            <Sparkles className="w-3 h-3" /> Copilot
          </button>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/10 transition-colors">
            <X className="w-4 h-4 text-white/50" />
          </button>
        </div>

        {/* Hero: latest bounce + primary actions */}
        <div className="px-5 py-3 border-b border-white/5 space-y-2.5">
          {bounce && (
            <div className="flex items-center gap-3 bg-white/[0.03] rounded-lg px-3 py-2">
              <button onClick={togglePlay} disabled={playError || !bounceMediaUrl}
                className="w-8 h-8 rounded-full bg-cyan-500 hover:bg-cyan-400 disabled:opacity-30 text-black flex items-center justify-center flex-shrink-0 transition-colors">
                {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-white/70 truncate">{bounce.file_name}</p>
                <p className="text-[10px] text-white/25">
                  {!bounceMediaUrl ? 'Bounce unavailable — file is missing on disk.'
                    : playError ? "Couldn't play this file — use Open instead."
                    : 'Latest bounce'}
                </p>
              </div>
              {/* Opaque protocol URL only; never file://. Element omitted (no src="")
                  when there is no playable bounce. */}
              {bounceMediaUrl && (
                <audio ref={audioRef} src={bounceMediaUrl}
                  onEnded={() => setPlaying(false)} onError={() => setPlayError(true)} />
              )}
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={handleOpenInDaw}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-black rounded-lg transition-colors">
              <ExternalLink className="w-3 h-3" /> Open in DAW
            </button>
            {(project.sync_status === 'pending' || project.sync_status === 'failed') && (
              <button onClick={handlePrioritize} disabled={prioritizing}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white/8 hover:bg-white/12 text-white/70 rounded-lg transition-colors disabled:opacity-40">
                {prioritizing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />} Sync This Project
              </button>
            )}
            <button onClick={handlePublish} disabled={publishing || !cloudReady}
              title={cloudReady ? 'Create an immutable version of this project' : 'Available once the project is synced'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white/8 hover:bg-white/12 text-white/60 rounded-lg transition-colors disabled:opacity-40">
              {publishing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Publish Version
            </button>
            <button onClick={handleShareProject} disabled={sharingProject || !cloudReady}
              title={cloudReady ? 'Share the full project (restore + open in DAW)' : 'Available once the project is synced'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-purple-600/80 hover:bg-purple-500/80 text-white rounded-lg transition-colors disabled:opacity-40">
              {sharingProject ? <Loader2 className="w-3 h-3 animate-spin" /> : <Package className="w-3 h-3" />} Project Link
            </button>
            <button onClick={() => setShowListenPanel((v) => !v)} disabled={!cloudReady}
              title={cloudReady ? 'Share a playable Listen Link' : 'Available once the project is synced'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white/8 hover:bg-white/12 text-white/60 rounded-lg transition-colors disabled:opacity-40">
              <Link2 className="w-3 h-3" /> Listen Link
            </button>
          </div>

          {/* Compatibility — honest capability report from the DAW adapter */}
          {compat && (
            <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3">
              <p className="text-[11px] font-semibold text-white/70 mb-2">{compatibilityHeadline(compat)}</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {deriveCompatibilityRows(compat).map((row) => (
                  <div key={row.label} className="flex items-center justify-between text-[11px]">
                    <span className="text-white/40 truncate">{row.label}</span>
                    <span className={
                      row.tone === 'ok' ? 'text-emerald-400'
                        : row.tone === 'warn' ? 'text-amber-400'
                        : 'text-white/35'
                    }>{row.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Project summary — at-a-glance package facts (§6.2) */}
          {!loading && summary.totalFiles > 0 && (
            <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/40">
              <span className={summary.hasNativeProject ? 'text-white/60' : 'text-amber-400'}>
                {summary.hasNativeProject ? 'Native project ✓' : 'No native project'}
              </span>
              <span>·</span><span>{summary.stemCount} stems</span>
              <span>·</span><span>{summary.midiCount} MIDI</span>
              <span>·</span><span>{formatFileSize(summary.totalSize)}</span>
              {summary.missingCount > 0 && (<><span>·</span><span className="text-amber-400">{summary.missingCount} missing</span></>)}
              <span>·</span>
              <span className={summary.packageCompleteness === 100 ? 'text-emerald-400' : 'text-white/40'}>
                {summary.packageCompleteness}% complete
              </span>
            </div>
          )}

          {/* Listen-link permissions mini-panel (relocated from Dashboard rows) */}
          {showListenPanel && (
            <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3 space-y-2">
              <label className="flex items-center justify-between text-xs text-white/60">
                Allow download
                <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} />
              </label>
              <label className="flex items-center justify-between text-xs text-white/60">
                Expires
                <select value={expiry} onChange={(e) => setExpiry(e.target.value as any)}
                  className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs text-white/70">
                  <option value="never">Never</option>
                  <option value="24h">In 24 hours</option>
                  <option value="7d">In 7 days</option>
                  <option value="30d">In 30 days</option>
                </select>
              </label>
              <div className="flex justify-end">
                <button onClick={handleCreateListenLink} disabled={listenBusy}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 rounded-lg disabled:opacity-40">
                  {listenBusy && <Loader2 className="w-3 h-3 animate-spin" />} Create & Copy
                </button>
              </div>
            </div>
          )}

          {statusMsg && (
            <p className={`text-[11px] ${statusMsg.startsWith('Error') ? 'text-red-400' : 'text-cyan-400'}`}>{statusMsg}</p>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/8">
          {(['files', 'versions', 'links', 'activity', 'overview'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-xs font-medium transition-colors capitalize ${tab === t ? 'text-cyan-400 border-b border-cyan-400' : 'text-white/40 hover:text-white/70'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
          ) : tab === 'files' ? (
            <div className="py-2">
              {groups.length === 0 ? (
                <div className="text-center py-12 text-white/25 text-sm">No associated files found.</div>
              ) : groups.map(({ role, files: roleFiles }) => {
                const Icon = ROLE_ICONS[role] ?? File;
                const expanded = expandedGroups.has(role);
                return (
                  <div key={role}>
                    <button onClick={() => setExpandedGroups((p) => { const n = new Set(p); n.has(role) ? n.delete(role) : n.add(role); return n; })}
                      className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-white/[0.02] transition-colors">
                      {expanded ? <ChevronDown className="w-3 h-3 text-white/30" /> : <ChevronRight className="w-3 h-3 text-white/30" />}
                      <Icon className="w-3.5 h-3.5 text-white/30" />
                      <span className="text-xs font-medium text-white/40 uppercase tracking-wider">{ROLE_LABELS[role] ?? role}</span>
                      <span className="text-[10px] text-white/20 ml-auto">{roleFiles.length}</span>
                    </button>
                    {expanded && roleFiles.map((fl) => <FileRow key={fl.id} file={fl} projectRoot={projectRoot} />)}
                  </div>
                );
              })}
            </div>
          ) : tab === 'versions' ? (
            <div className="py-3 px-4 space-y-2">
              {versions.length === 0 ? (
                <p className="text-white/25 text-sm text-center py-8">No versions yet. Publish Version creates an immutable snapshot you can share and restore.</p>
              ) : versions.map((v: any) => (
                <div key={v.id} className="flex items-center gap-3 py-2.5 border-b border-white/5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400/50 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white/70">{v.label ?? 'Version'} <span className="text-[10px] text-white/25 ml-1">{v.created_at ? new Date(v.created_at).toLocaleString() : ''}</span></p>
                    {v.file_size ? <p className="text-[10px] text-white/30">{formatBytes(v.file_size)}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : tab === 'links' ? (
            <div className="py-3 px-4 space-y-2">
              {links.length === 0 ? (
                <p className="text-white/25 text-sm text-center py-8">No links for this project yet. Use Project Link or Listen Link above.</p>
              ) : links.map((l) => {
                const status = deriveLinkStatus(l);
                return (
                  <div key={l.tracking_id} className={`flex items-center gap-3 py-2.5 border-b border-white/5 ${status !== 'active' ? 'opacity-50' : ''}`}>
                    {status === 'revoked' ? <Ban className="w-3.5 h-3.5 text-white/25 flex-shrink-0" /> : <Link2 className="w-3.5 h-3.5 text-cyan-400/50 flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white/70 truncate">{linkDisplayName(l)}</p>
                      <p className="text-[10px] text-white/25 truncate font-mono">{l.url}</p>
                    </div>
                    <button onClick={() => navigator.clipboard.writeText(l.url)} disabled={status !== 'active'} title="Copy"
                      className="p-1 rounded hover:bg-white/10 disabled:opacity-30"><Copy className="w-3 h-3 text-white/40" /></button>
                  </div>
                );
              })}
              <button onClick={() => onNavigate?.('links')}
                className="w-full text-center text-[11px] text-cyan-400/80 hover:text-cyan-300 py-2">
                Manage all links →
              </button>
            </div>
          ) : tab === 'activity' ? (
            <div className="py-3 px-4 space-y-1">
              {activity.length === 0 ? (
                <p className="text-white/25 text-sm text-center py-8">No activity recorded for this project yet.</p>
              ) : activity.map((a: any) => (
                <div key={a.id} className="flex items-start gap-2 py-1.5 border-b border-white/5 last:border-0">
                  <span className="text-[10px] text-white/20 w-32 flex-shrink-0">{a.created_at ? new Date(a.created_at).toLocaleString() : ''}</span>
                  <span className="text-[11px] text-white/50 min-w-0 truncate" title={a.message}>{a.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-4 px-5 space-y-4 text-sm text-white/60">
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['Name', project.project_name],
                  ['DAW', project.daw_type ?? '—'],
                  ['Status', project.sync_status ?? '—'],
                  ['Files', String(files.length)],
                  ['Total size', formatBytes(totalSize)],
                  ['Active links', String(links.filter((l) => deriveLinkStatus(l) === 'active').length)],
                ].map(([label, value]) => (
                  <div key={label} className="bg-white/[0.03] rounded-lg p-3">
                    <p className="text-[10px] text-white/30 mb-1">{label}</p>
                    <p className="text-sm text-white/70 truncate">{value}</p>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-white/20">
                Collaborator management arrives with shared cloud projects. Advanced identifiers stay in Diagnostics.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
