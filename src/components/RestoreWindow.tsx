import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle, CheckCircle2, Download, FolderOpen, Loader2,
  Music, Package, RefreshCw, X, ExternalLink, ChevronDown, ChevronRight,
} from 'lucide-react';
import { api } from '../lib/api';

interface FileEntry {
  file_name: string;
  relative_path?: string;
  sha256?: string;
  file_size?: number;
  role?: string;
}

interface CompatibilityMeta {
  daw?: string | null;
  dawVersion?: string | null;
  os?: string | null;
  sampleRate?: number | null;
  bpm?: number | null;
  timeSignature?: string | null;
  plugins?: Array<{ name: string; vendor?: string; version?: string }>;
}

interface ResolvedLink {
  shareId: string;
  token: string;
  projectId: string;
  versionId: string;
  ownerUserId?: string;
  collaboratorMode?: string;
  parentVersionId?: string;
  project?: { name?: string; description?: string } | null;
  version?: { version_number?: number; daw?: string; bpm?: number } | null;
  compatibility?: CompatibilityMeta | null;
  fileCount?: number;
  totalSize?: number;
  files: FileEntry[];
}

type Phase =
  | 'resolving'
  | 'check_existing'
  | 'existing_found'
  | 'confirm'
  | 'picking_dest'
  | 'downloading'
  | 'extracting'
  | 'verifying'
  | 'done'
  | 'error';

interface Progress {
  downloadedBytes?: number;
  totalSize?: number;
  verified?: number;
  total?: number;
  destDir?: string;
}

function formatBytes(n?: number) {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

const ERROR_LABELS: Record<string, string> = {
  network: 'Network error',
  expired_link: 'Link expired',
  permission_denied: 'Permission denied',
  missing_asset: 'Missing asset',
  hash_mismatch: 'Hash mismatch',
  extraction_failure: 'Extraction failed',
  missing_required_file: 'Missing required file',
  unsupported_daw: 'Unsupported DAW',
};

export default function RestoreWindow({ token, onClose }: { token: string; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('resolving');
  const [link, setLink] = useState<ResolvedLink | null>(null);
  const [existing, setExisting] = useState<Record<string, unknown> | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>({});
  const [error, setError] = useState<{ code: string; detail?: string } | null>(null);
  const [result, setResult] = useState<{ restoreId: string; dawProjectPath: string; projectDir: string; dawType?: string } | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const progressRef = useRef(progress);
  progressRef.current = progress;

  // Step 1: resolve the share token
  useEffect(() => {
    api.restore.resolve(token).then((data) => {
      if (data.error) {
        const code = String(data.error).includes('expired') ? 'expired_link'
          : String(data.error).includes('ermission') ? 'permission_denied'
          : 'network';
        setError({ code, detail: data.error as string });
        setPhase('error');
        return;
      }
      const resolved = data as unknown as ResolvedLink;
      setLink(resolved);

      // Step 2: check if already restored
      api.restore.checkExisting(resolved.shareId).then((ex) => {
        if (ex) {
          setExisting(ex);
          setPhase('existing_found');
        } else {
          setPhase('confirm');
        }
      });
    });
  }, [token]);

  // Listen for restore progress events
  useEffect(() => {
    api.restore.onProgress((data) => {
      const evt = data.evt as string;
      if (evt === 'download_start') setPhase('downloading');
      if (evt === 'download_complete') setProgress(p => ({ ...p, downloadedBytes: data.downloadedBytes as number }));
      if (evt === 'extract_start') setPhase('extracting');
      if (evt === 'verify_start') setPhase('verifying');
      if (evt === 'verify_progress') setProgress(p => ({ ...p, verified: data.verified as number, total: data.total as number }));
      if (evt === 'restore_complete') setProgress(p => ({ ...p, destDir: data.dawProjectPath as string }));
    });
  }, []);

  async function handlePickDestination() {
    const projectName = link?.project?.name ?? 'Wavi Project';
    const dest = await api.restore.pickDestination(projectName);
    if (!dest) return;
    setDestination(dest);
    setPhase('downloading');
    startRestore(dest);
  }

  async function startRestore(dest: string) {
    if (!link) return;
    const res = await api.restore.start({
      token: link.token,
      shareId: link.shareId,
      projectId: link.projectId,
      versionId: link.versionId,
      ownerUserId: link.ownerUserId,
      collaboratorMode: link.collaboratorMode,
      parentVersionId: link.parentVersionId,
      projectName: link.project?.name ?? 'Wavi Project',
      dawType: link.version?.daw ?? link.compatibility?.daw,
      fileCount: link.fileCount ?? 0,
      totalSize: link.totalSize ?? 0,
      files: link.files,
      destinationFolder: dest,
    });

    if (res.error) {
      setError({ code: res.error as string, detail: res.detail as string | undefined });
      setPhase('error');
      return;
    }

    setResult({
      restoreId: res.restoreId as string,
      dawProjectPath: res.dawProjectPath as string,
      projectDir: res.projectDir as string,
      dawType: res.dawType as string | undefined,
    });
    setPhase('done');
  }

  async function handleOpenInAbleton() {
    if (!result?.dawProjectPath) return;
    await api.shell.openPath(result.dawProjectPath);
  }

  async function handleRevealInFinder() {
    if (!result?.projectDir) return;
    await api.shell.revealInFinder(result.projectDir);
  }

  async function handleOpenExisting() {
    if (!existing) return;
    await api.restore.openExisting(existing.id as string);
    await api.shell.revealInFinder(existing.local_project_path as string);
    onClose();
  }

  const projectName = link?.project?.name ?? 'Project';
  const dawLabel = link?.version?.daw ?? link?.compatibility?.daw ?? 'Unknown DAW';
  const versionNum = link?.version?.version_number;
  const compat = link?.compatibility;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-[#0f0f0f] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
          <div className="flex items-center gap-2.5">
            <Package className="w-4 h-4 text-cyan-500" />
            <span className="text-sm font-semibold text-white">Open Project Link</span>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          {/* Project identity */}
          {link && (
            <div>
              <h2 className="text-lg font-bold text-white leading-tight">{projectName}</h2>
              <div className="flex flex-wrap gap-2 mt-1.5 text-xs text-white/40">
                {versionNum && <span>v{versionNum}</span>}
                <span>{dawLabel}</span>
                {link.fileCount != null && <span>{link.fileCount} files</span>}
                {link.totalSize != null && <span>{formatBytes(link.totalSize)}</span>}
                {compat?.bpm && <span>{compat.bpm} BPM</span>}
              </div>
              {compat?.plugins?.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {compat.plugins.slice(0, 5).map((p, i) => (
                    <span key={i} className="px-1.5 py-0.5 bg-white/8 rounded text-[10px] text-white/50">{p.name}</span>
                  ))}
                  {compat.plugins.length > 5 && (
                    <span className="px-1.5 py-0.5 bg-white/8 rounded text-[10px] text-white/40">+{compat.plugins.length - 5}</span>
                  )}
                </div>
              ) : null}

              {/* File list toggle */}
              {link.files?.length > 0 && (
                <button
                  onClick={() => setShowFiles(v => !v)}
                  className="flex items-center gap-1 mt-2 text-[11px] text-white/30 hover:text-white/50 transition-colors"
                >
                  {showFiles ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  {showFiles ? 'Hide' : 'Show'} {link.files.length} file{link.files.length !== 1 ? 's' : ''}
                </button>
              )}
              {showFiles && (
                <div className="mt-2 max-h-40 overflow-y-auto border border-white/8 rounded-lg divide-y divide-white/5">
                  {link.files.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 bg-white/[0.02]">
                      <Music className="w-3 h-3 text-white/20 flex-shrink-0" />
                      <span className="text-[11px] text-white/60 truncate">{f.relative_path ?? f.file_name}</span>
                      <span className="text-[10px] text-white/25 ml-auto flex-shrink-0">{formatBytes(f.file_size)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Phase: resolving */}
          {phase === 'resolving' && (
            <div className="flex items-center gap-2 text-sm text-white/50">
              <Loader2 className="w-4 h-4 animate-spin text-cyan-500" />
              Resolving project link…
            </div>
          )}

          {/* Phase: existing found */}
          {phase === 'existing_found' && existing && (
            <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
              <div className="flex items-start gap-2.5">
                <FolderOpen className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-white">Already Restored</p>
                  <p className="text-xs text-white/40 mt-0.5">
                    This project was previously restored to:<br />
                    <span className="font-mono break-all">{existing.local_project_path as string}</span>
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleOpenExisting}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Open Existing Copy
                </button>
                <button
                  onClick={() => setPhase('confirm')}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-white/8 hover:bg-white/12 text-white/70 text-xs font-medium rounded-lg transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Restore New Copy
                </button>
              </div>
            </div>
          )}

          {/* Phase: confirm (destination picker trigger) */}
          {phase === 'confirm' && (
            <div className="space-y-3">
              <div className="text-xs text-white/40 bg-white/5 border border-white/8 rounded-lg px-3 py-2.5 space-y-1">
                <div className="flex justify-between">
                  <span>DAW</span><span className="text-white/60">{dawLabel}</span>
                </div>
                {compat?.os && (
                  <div className="flex justify-between">
                    <span>OS</span><span className="text-white/60">{compat.os}</span>
                  </div>
                )}
                {compat?.sampleRate && (
                  <div className="flex justify-between">
                    <span>Sample Rate</span><span className="text-white/60">{compat.sampleRate} Hz</span>
                  </div>
                )}
                {link?.fileCount != null && (
                  <div className="flex justify-between">
                    <span>Files</span><span className="text-white/60">{link.fileCount}</span>
                  </div>
                )}
                {link?.totalSize != null && (
                  <div className="flex justify-between">
                    <span>Download size</span><span className="text-white/60">{formatBytes(link.totalSize)}</span>
                  </div>
                )}
              </div>
              {compat?.plugins?.length ? (
                <p className="text-xs text-amber-400/80 flex items-start gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  {compat.plugins.length} plugin{compat.plugins.length !== 1 ? 's' : ''} required. Verify you have them before opening.
                </p>
              ) : null}
              <button
                onClick={handlePickDestination}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium rounded-xl transition-colors"
              >
                <Download className="w-4 h-4" />
                Choose Destination &amp; Restore
              </button>
            </div>
          )}

          {/* Phase: downloading */}
          {phase === 'downloading' && (
            <ProgressRow
              icon={<Download className="w-4 h-4 text-cyan-400" />}
              label="Downloading Project Pack…"
              sub={progress.downloadedBytes ? `${formatBytes(progress.downloadedBytes)} received` : undefined}
            />
          )}

          {/* Phase: extracting */}
          {phase === 'extracting' && (
            <ProgressRow
              icon={<Package className="w-4 h-4 text-purple-400" />}
              label="Extracting files…"
            />
          )}

          {/* Phase: verifying */}
          {phase === 'verifying' && (
            <ProgressRow
              icon={<CheckCircle2 className="w-4 h-4 text-green-400" />}
              label="Verifying hashes…"
              sub={progress.verified != null ? `${progress.verified} / ${progress.total ?? '?'} files verified` : undefined}
            />
          )}

          {/* Phase: done */}
          {phase === 'done' && result && (
            <div className="space-y-3">
              <div className="flex items-start gap-2.5 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3">
                <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-white">Project Restored</p>
                  <p className="text-xs text-white/40 mt-0.5 font-mono break-all">{result.projectDir}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleOpenInAbleton}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium rounded-xl transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open in {result.dawType ?? 'DAW'}
                </button>
                <button
                  onClick={handleRevealInFinder}
                  className="px-3 flex items-center justify-center py-2.5 bg-white/8 hover:bg-white/12 text-white/70 rounded-xl transition-colors"
                >
                  <FolderOpen className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Phase: error */}
          {phase === 'error' && error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 space-y-2">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-white">
                    {ERROR_LABELS[error.code] ?? 'Restore failed'}
                  </p>
                  {error.detail && (
                    <p className="text-xs text-white/40 mt-0.5">{error.detail}</p>
                  )}
                </div>
              </div>
              {error.code !== 'expired_link' && error.code !== 'permission_denied' && (
                <button
                  onClick={() => { setError(null); setPhase('confirm'); }}
                  className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> Try again
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProgressRow({ icon, label, sub }: { icon: React.ReactNode; label: string; sub?: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex-shrink-0">{icon}</div>
      <div>
        <div className="flex items-center gap-2 text-sm text-white/80">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-white/30" />
          {label}
        </div>
        {sub && <p className="text-xs text-white/30 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}
