import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import {
  X, FolderOpen, Music, FileText, Image, Archive, File,
  Package, AlertTriangle, CheckCircle2, Cloud, HardDrive,
  ExternalLink, Download, RefreshCw, ChevronDown, ChevronRight, Clock,
  Copy, Check, Loader2,
} from 'lucide-react';
import type { Project, SyncProgress } from '../types';
import { formatBytes } from '../lib/utils';

interface LocalFile {
  id: string;
  file_name: string;
  file_path: string;
  file_type: string;
  file_size: number;
  sync_status: string;
  cloud_asset_id?: string;
  checksum?: string;
  classifier_role?: string;
  role?: string;
  modified_at?: string;
  local_status?: string;
}

const ROLE_ORDER = ['project', 'audio', 'stem', 'sample', 'midi', 'artwork', 'document', 'archive', 'missing', 'other'];

const ROLE_LABELS: Record<string, string> = {
  project: 'DAW Project Files',
  audio: 'Audio',
  stem: 'Stems',
  sample: 'Samples',
  midi: 'MIDI',
  artwork: 'Artwork',
  document: 'Documents',
  archive: 'Archives',
  missing: 'Missing Files',
  other: 'Other Files',
};

const ROLE_ICONS: Record<string, React.FC<any>> = {
  project: FolderOpen,
  audio: Music,
  stem: Music,
  sample: Music,
  midi: FileText,
  artwork: Image,
  document: FileText,
  archive: Archive,
  missing: AlertTriangle,
  other: File,
};

function deriveRole(file: LocalFile): string {
  const ext = '.' + file.file_name.split('.').pop()?.toLowerCase();
  if (file.local_status === 'missing') return 'missing';
  if (['.als', '.ptx', '.flp', '.logic', '.logicx', '.nproject', '.cpr', '.rpp'].includes(ext)) return 'project';
  const cr = file.classifier_role ?? file.role ?? 'misc';
  if (cr === 'stem') return 'stem';
  if (cr === 'sample') return 'sample';
  if (['.wav', '.mp3', '.aiff', '.aif', '.flac', '.m4a', '.ogg', '.aac'].includes(ext)) return 'audio';
  if (ext === '.mid' || ext === '.midi') return 'midi';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'artwork';
  if (['.pdf', '.txt', '.md', '.docx', '.rtf'].includes(ext)) return 'document';
  if (['.zip', '.rar', '.tar', '.gz'].includes(ext)) return 'archive';
  return 'other';
}

function groupFiles(files: LocalFile[]) {
  const groups: Record<string, LocalFile[]> = {};
  for (const f of files) {
    const role = deriveRole(f);
    if (!groups[role]) groups[role] = [];
    groups[role].push(f);
  }
  return ROLE_ORDER.filter(r => groups[r]?.length).map(r => ({ role: r, files: groups[r] }));
}

function FileRow({ file, projectRoot }: { file: LocalFile; projectRoot: string }) {
  const [copied, setCopied] = useState(false);
  const ext = file.file_name.split('.').pop()?.toLowerCase();
  const synced = file.sync_status === 'synced' && file.cloud_asset_id;
  const localPresent = file.local_status !== 'missing';

  const relPath = file.file_path.startsWith(projectRoot)
    ? file.file_path.slice(projectRoot.length).replace(/^[/\\]/, '')
    : file.file_name;

  const openLocal = () => api.shell.openPath(file.file_path);
  const revealInFinder = () => api.shell.revealInFinder(file.file_path);
  const copyHash = () => {
    if (!file.checksum) return;
    navigator.clipboard.writeText(file.checksum).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  return (
    <div className="group flex items-start gap-2 px-3 py-2.5 hover:bg-white/[0.03] transition-colors border-b border-white/5 last:border-0">
      <File className="w-3.5 h-3.5 text-white/25 mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm text-white/80 truncate">{file.file_name}</span>
          <span className="text-[10px] text-white/20 font-mono uppercase">{ext}</span>
          {!localPresent && (
            <span className="text-[9px] text-red-400/80 bg-red-900/20 rounded px-1">missing</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-white/30">
          <span className="font-mono truncate max-w-[160px]" title={relPath}>{relPath}</span>
          <span>{formatBytes(file.file_size)}</span>
          {file.modified_at && <span>{new Date(file.modified_at).toLocaleDateString()}</span>}
        </div>
        <div className="flex items-center gap-2 mt-1">
          {synced
            ? <span className="flex items-center gap-0.5 text-[9px] text-cyan-400/70"><Cloud className="w-2.5 h-2.5" /> synced</span>
            : <span className="flex items-center gap-0.5 text-[9px] text-white/30"><HardDrive className="w-2.5 h-2.5" /> local only</span>
          }
          {file.checksum && (
            <button onClick={copyHash} className="flex items-center gap-0.5 text-[9px] text-white/20 hover:text-white/50">
              {copied ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Copy className="w-2.5 h-2.5" />}
              {copied ? 'Copied' : file.checksum.slice(0, 8) + '…'}
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        {localPresent && (
          <>
            <button onClick={openLocal} title="Open" className="p-1 rounded hover:bg-white/10 transition-colors">
              <ExternalLink className="w-3 h-3 text-white/40" />
            </button>
            <button onClick={revealInFinder} title="Reveal in Finder" className="p-1 rounded hover:bg-white/10 transition-colors">
              <FolderOpen className="w-3 h-3 text-white/40" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

interface ProjectDetailProps {
  project: Project;
  onClose: () => void;
}

type Tab = 'files' | 'versions' | 'overview';

export function ProjectDetail({ project, onClose }: ProjectDetailProps) {
  const [tab, setTab] = useState<Tab>('files');
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [versions, setVersions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(ROLE_ORDER));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const f = await api.files.getByProject(project.id);
      setFiles(f as unknown as LocalFile[]);

      if (project.cloud_id) {
        const r = await api.project.getCloudFiles({ cloudProjectId: project.cloud_id });
        if (!('error' in r) && r.versions) setVersions(r.versions as any[]);
      }
    } catch {}
    setLoading(false);
  }, [project.id, project.cloud_id]);

  useEffect(() => { load(); }, [load]);

  const projectRoot = project.file_path ? project.file_path.split(/[/\\]/).slice(0, -1).join('/') + '/' : '';
  const groups = groupFiles(files);
  const totalSize = files.reduce((s, f) => s + (f.file_size ?? 0), 0);
  const syncedCount = files.filter(f => f.sync_status === 'synced').length;

  const toggleGroup = (role: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role); else next.add(role);
      return next;
    });
  };

  const handlePublish = async () => {
    setPublishing(true);
    setStatusMsg(null);
    try {
      const r = await api.project.publishVersion({ localProjectId: project.id });
      if (r.error) {
        setStatusMsg(`Error: ${r.error}`);
      } else if (r.skipped) {
        setStatusMsg(`Already up to date (v${r.versionNumber})`);
      } else {
        setStatusMsg(`Published v${r.versionNumber} — ${r.fileCount} files`);
        await load();
      }
    } catch (e: any) {
      setStatusMsg(`Error: ${e?.message ?? 'unknown'}`);
    }
    setPublishing(false);
  };

  const handleShareProject = async () => {
    setSharing(true);
    setStatusMsg(null);
    try {
      const r = await api.project.createLink({ projectId: project.id, cloudProjectId: project.cloud_id ?? undefined, allowDownload: true });
      if (r.error) {
        setStatusMsg(`Error: ${r.error}`);
      } else if (r.linkUrl) {
        setLinkUrl(r.linkUrl);
        navigator.clipboard.writeText(r.linkUrl);
        setLinkCopied(true);
        setStatusMsg(`Project link created and copied!`);
        setTimeout(() => setLinkCopied(false), 3000);
      }
    } catch (e: any) {
      setStatusMsg(`Error: ${e?.message ?? 'unknown'}`);
    }
    setSharing(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end justify-end">
      <div className="w-[520px] h-full bg-[#0a0a0a] border-l border-white/8 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/8">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-white truncate">{project.project_name}</h2>
            <p className="text-xs text-white/30 truncate mt-0.5">{project.file_path}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/10 transition-colors">
            <X className="w-4 h-4 text-white/50" />
          </button>
        </div>

        {/* Stats strip */}
        <div className="flex items-center gap-4 px-5 py-3 text-xs text-white/40 border-b border-white/5 bg-white/[0.01]">
          <span>{files.length} files</span>
          <span>{formatBytes(totalSize)}</span>
          <span>{syncedCount}/{files.length} synced</span>
          {project.daw_type && <span>{project.daw_type.toUpperCase()}</span>}
          {project.sync_status && (
            <span className={project.sync_status === 'synced' ? 'text-cyan-400' : 'text-yellow-400'}>
              {project.sync_status}
            </span>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/8">
          {(['files', 'versions', 'overview'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-xs font-medium transition-colors capitalize ${tab === t ? 'text-cyan-400 border-b border-cyan-400' : 'text-white/40 hover:text-white/70'}`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-5 h-5 animate-spin text-white/30" />
            </div>
          ) : tab === 'files' ? (
            <div className="py-2">
              {groups.length === 0 ? (
                <div className="text-center py-12 text-white/25 text-sm">No associated files found.</div>
              ) : groups.map(({ role, files: roleFiles }) => {
                const Icon = ROLE_ICONS[role] ?? File;
                const expanded = expandedGroups.has(role);
                return (
                  <div key={role}>
                    <button
                      onClick={() => toggleGroup(role)}
                      className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-white/[0.02] transition-colors"
                    >
                      {expanded ? <ChevronDown className="w-3 h-3 text-white/30" /> : <ChevronRight className="w-3 h-3 text-white/30" />}
                      <Icon className="w-3.5 h-3.5 text-white/30" />
                      <span className="text-xs font-medium text-white/40 uppercase tracking-wider">
                        {ROLE_LABELS[role] ?? role}
                      </span>
                      <span className="text-[10px] text-white/20 ml-auto">{roleFiles.length}</span>
                    </button>
                    {expanded && roleFiles.map(f => (
                      <FileRow key={f.id} file={f} projectRoot={projectRoot} />
                    ))}
                  </div>
                );
              })}
            </div>
          ) : tab === 'versions' ? (
            <div className="py-3 px-4 space-y-2">
              {versions.length === 0 ? (
                <p className="text-white/25 text-sm text-center py-8">No cloud versions yet. Click Publish Version to create one.</p>
              ) : versions.map((v: any) => (
                <div key={v.id} className="flex items-center gap-3 py-2.5 border-b border-white/5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-white/70 font-medium">v{v.version_number}</span>
                      {v.daw && <span className="text-[10px] text-white/30">{v.daw}</span>}
                    </div>
                    <p className="text-[10px] text-white/30 mt-0.5">
                      {v.synced_at ? new Date(v.synced_at).toLocaleString() : ''}
                      {v.file_size ? ` · ${formatBytes(v.file_size)}` : ''}
                    </p>
                  </div>
                  {v.sha256 && (
                    <span className="text-[9px] font-mono text-white/20">{v.sha256.slice(0, 8)}</span>
                  )}
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
                  ['Cloud ID', project.cloud_id ? project.cloud_id.slice(0, 12) + '…' : 'Not synced'],
                ].map(([label, value]) => (
                  <div key={label} className="bg-white/[0.03] rounded-lg p-3">
                    <p className="text-[10px] text-white/30 mb-1">{label}</p>
                    <p className="text-sm text-white/70 truncate">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Action bar */}
        <div className="border-t border-white/8 px-4 py-3 space-y-2">
          {statusMsg && (
            <p className={`text-[11px] px-2 ${statusMsg.startsWith('Error') ? 'text-red-400' : 'text-cyan-400'}`}>{statusMsg}</p>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handlePublish}
              disabled={publishing || !project.cloud_id || project.sync_status !== 'synced'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white/8 hover:bg-white/12 text-white/60 rounded-lg transition-colors disabled:opacity-40"
            >
              {publishing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {publishing ? 'Publishing…' : 'Publish Version'}
            </button>

            <button
              onClick={handleShareProject}
              disabled={sharing || !project.cloud_id || project.sync_status !== 'synced'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-purple-600/80 hover:bg-purple-500/80 text-white rounded-lg transition-colors disabled:opacity-40"
            >
              {sharing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Package className="w-3 h-3" />}
              {sharing ? 'Preparing…' : linkUrl ? (linkCopied ? '✓ Copied!' : 'Copy Link') : 'Share Project'}
            </button>

            {linkUrl && (
              <button
                onClick={() => api.shell.openExternal(linkUrl)}
                className="p-1.5 rounded hover:bg-white/10 transition-colors"
                title="Open project link"
              >
                <ExternalLink className="w-3.5 h-3.5 text-white/40" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
