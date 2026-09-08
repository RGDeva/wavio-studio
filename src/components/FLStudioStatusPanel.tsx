import { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2, Circle, FolderOpen, Music2, Tag, UploadCloud,
  Globe, ChevronDown, ChevronRight, RefreshCw, AlertCircle, Clock,
} from 'lucide-react';
import { api } from '../lib/api';
import { formatBytes, formatRelativeTime } from '../lib/utils';

interface DemoStatus {
  project: {
    id: string;
    name: string;
    file_path: string;
    daw_type: string;
    sync_status: string;
    cloud_id: string | null;
    version_count: number;
  };
  checks: {
    folderLinked: boolean;
    flpDetected: boolean;
    exportFolderDetected: boolean;
    exportFolderPath: string | null;
    latestBounce: {
      file_name: string;
      role: string;
      status: string;
      detected_at: string;
      file_size: number;
    } | null;
    latestVersion: {
      label: string;
      version_type: string;
      created_at: string;
      file_path: string;
      checksum: string | null;
    } | null;
    uploadStatus: string;
    webSynced: boolean;
    syncedFiles: number;
    totalFiles: number;
  };
}

const UPLOAD_STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  completed:  { color: 'text-success', label: 'Complete' },
  uploading:  { color: 'text-primary',    label: 'Uploading…' },
  retrying:   { color: 'text-warning',   label: 'Retrying…' },
  failed:     { color: 'text-destructive',     label: 'Failed' },
  pending:    { color: 'text-fg-quaternary',    label: 'Pending' },
  none:       { color: 'text-fg-quaternary',    label: '—' },
};

function Check({ done, label, sub, warn }: { done: boolean; label: string; sub?: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      {done
        ? <CheckCircle2 className="w-3.5 h-3.5 text-success mt-0.5 flex-shrink-0" />
        : warn
          ? <AlertCircle className="w-3.5 h-3.5 text-warning mt-0.5 flex-shrink-0" />
          : <Circle className="w-3.5 h-3.5 text-fg-quaternary mt-0.5 flex-shrink-0" />
      }
      <div className="flex-1 min-w-0">
        <p className={`text-xs ${done ? 'text-fg-secondary' : warn ? 'text-warning/70' : 'text-fg-quaternary'}`}>{label}</p>
        {sub && <p className="text-meta text-fg-quaternary font-mono truncate mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

interface Props {
  projectId: string;
}

export function FLStudioStatusPanel({ projectId }: Props) {
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.projects.getDemoStatus(projectId);
      setStatus(data);
    } catch { /* IPC unavailable */ }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
    const handler = () => setTimeout(refresh, 800);
    api.on('watcher:event', handler);
    api.on('sync:progress', handler);
    return () => {
      api.off('watcher:event', handler);
      api.off('sync:progress', handler);
    };
  }, [refresh]);

  if (!status) return null;

  const { checks, project } = status;
  const uploadCfg = UPLOAD_STATUS_CONFIG[checks.uploadStatus] ?? UPLOAD_STATUS_CONFIG.pending;

  const doneCount = [
    checks.folderLinked,
    checks.flpDetected,
    checks.exportFolderDetected,
    !!checks.latestBounce,
    !!checks.latestVersion,
    checks.uploadStatus === 'completed',
    checks.webSynced,
  ].filter(Boolean).length;
  const totalSteps = 7;

  return (
    <div className="bg-[#0d0d0d] border border-[#1e1e1e] rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-layer-1 transition-colors"
      >
        <div className="w-7 h-7 rounded-lg bg-[#FF5A26]/10 flex items-center justify-center flex-shrink-0">
          <Music2 className="w-3.5 h-3.5 text-[#FF5A26]" />
        </div>
        <div className="flex-1 text-left min-w-0">
          <p className="text-xs font-semibold text-fg-secondary truncate">{project.name}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <div className="flex gap-0.5">
              {Array.from({ length: totalSteps }).map((_, i) => (
                <div
                  key={i}
                  className={`w-3 h-0.5 rounded-full ${i < doneCount ? 'bg-success' : 'bg-layer-3'}`}
                />
              ))}
            </div>
            <span className="text-meta text-fg-quaternary">{doneCount}/{totalSteps} steps</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {loading && <RefreshCw className="w-3 h-3 text-fg-quaternary animate-spin" />}
          {expanded
            ? <ChevronDown className="w-3.5 h-3.5 text-fg-quaternary" />
            : <ChevronRight className="w-3.5 h-3.5 text-fg-quaternary" />
          }
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[#1a1a1a] px-4 py-3 space-y-0.5">
          <Check
            done={checks.folderLinked}
            label="Folder linked"
            sub={project.file_path.split('/').slice(-3, -1).join('/')}
          />
          <Check
            done={checks.flpDetected}
            label="FL Studio project detected (.flp)"
            sub={checks.flpDetected ? project.file_path.split('/').pop() : undefined}
            warn={!checks.flpDetected}
          />
          <Check
            done={checks.exportFolderDetected}
            label="Export folder detected"
            sub={checks.exportFolderPath
              ? checks.exportFolderPath.split('/').slice(-2).join('/')
              : 'Save to: /exports, /bounces, /mixes, /masters, /stems'}
          />
          <Check
            done={!!checks.latestBounce}
            label={checks.latestBounce
              ? `Latest bounce: ${checks.latestBounce.file_name} (${checks.latestBounce.role})`
              : 'No bounce detected yet'}
            sub={checks.latestBounce
              ? `${formatBytes(checks.latestBounce.file_size)} · ${formatRelativeTime(checks.latestBounce.detected_at)} · ${checks.latestBounce.status}`
              : undefined}
          />
          <Check
            done={!!checks.latestVersion}
            label={checks.latestVersion
              ? `Version created: ${checks.latestVersion.label}`
              : 'No version confirmed yet — accept the bounce toast'}
            sub={checks.latestVersion
              ? formatRelativeTime(checks.latestVersion.created_at)
              : undefined}
          />

          {/* Upload status */}
          <div className="flex items-start gap-2.5 py-1.5">
            {checks.uploadStatus === 'completed'
              ? <CheckCircle2 className="w-3.5 h-3.5 text-success mt-0.5 flex-shrink-0" />
              : checks.uploadStatus === 'failed'
                ? <AlertCircle className="w-3.5 h-3.5 text-destructive mt-0.5 flex-shrink-0" />
                : checks.uploadStatus === 'uploading' || checks.uploadStatus === 'retrying'
                  ? <UploadCloud className="w-3.5 h-3.5 text-primary mt-0.5 flex-shrink-0 animate-pulse" />
                  : <Clock className="w-3.5 h-3.5 text-fg-quaternary mt-0.5 flex-shrink-0" />
            }
            <div className="flex-1 min-w-0">
              <p className={`text-xs ${uploadCfg.color}`}>
                Upload: {uploadCfg.label}
                {checks.totalFiles > 0 && (
                  <span className="text-fg-quaternary ml-1">({checks.syncedFiles}/{checks.totalFiles} files)</span>
                )}
              </p>
              {checks.uploadStatus === 'failed' && (
                <button
                  onClick={() => api.sync.retryAll()}
                  className="text-meta text-destructive/70 hover:text-destructive underline mt-0.5"
                >
                  Retry
                </button>
              )}
            </div>
          </div>

          {/* Web sync */}
          <div className="flex items-start gap-2.5 py-1.5">
            {checks.webSynced
              ? <CheckCircle2 className="w-3.5 h-3.5 text-success mt-0.5 flex-shrink-0" />
              : <Circle className="w-3.5 h-3.5 text-fg-quaternary mt-0.5 flex-shrink-0" />
            }
            <div className="flex-1 min-w-0">
              <p className={`text-xs ${checks.webSynced ? 'text-fg-secondary' : 'text-fg-quaternary'}`}>
                {checks.webSynced ? 'Web vault synced' : 'Not yet visible in web vault'}
              </p>
            </div>
            {checks.webSynced && project.cloud_id && (
              <button
                onClick={() => api.shell.openExternal(`https://wavi.stream/vault?project=${project.cloud_id}`)}
                title="Open in vault"
                className="text-fg-quaternary hover:text-primary transition-colors flex-shrink-0"
              >
                <Globe className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Version count footer */}
          {project.version_count > 0 && (
            <div className="flex items-center gap-1.5 pt-1.5 mt-1 border-t border-hairline">
              <Tag className="w-3 h-3 text-fg-quaternary" />
              <span className="text-meta text-fg-quaternary">
                {project.version_count} version{project.version_count !== 1 ? 's' : ''} recorded locally
              </span>
              {checks.webSynced && (
                <button
                  onClick={() => api.shell.openExternal(`https://wavi.stream/vault?project=${project.cloud_id}`)}
                  className="ml-auto text-meta text-primary/50 hover:text-primary transition-colors flex items-center gap-0.5"
                >
                  <FolderOpen className="w-2.5 h-2.5" />
                  View in vault
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
