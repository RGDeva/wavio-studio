import { Folder, Clock, GitBranch, Users, Music } from 'lucide-react';
import type { ProjectContext as ProjectContextType } from './types';

interface ProjectContextProps {
  context: ProjectContextType | null;
  loading: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ProjectContext({ context, loading }: ProjectContextProps) {
  if (loading) {
    return (
      <div className="p-3 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-4 bg-white/5 rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (!context || !context.projectName) {
    return (
      <div className="p-3 text-center">
        <Folder className="w-6 h-6 text-white/15 mx-auto mb-2" />
        <p className="text-xs text-white/30">No project selected</p>
        <p className="text-[10px] text-white/20 mt-1">Open a DAW project or select a watched folder</p>
      </div>
    );
  }

  const audioFiles = context.files.filter((f) =>
    ['wav', 'mp3', 'aiff', 'flac', 'm4a'].includes(f.fileType)
  );
  const midiFiles = context.files.filter((f) => ['mid', 'midi'].includes(f.fileType));
  const latestExport = context.cloudProject?.latestExport;

  return (
    <div className="p-3 space-y-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span className="text-xs font-semibold text-white/80 truncate">{context.projectName}</span>
        </div>
        {context.dawType && (
          <span className="text-[10px] text-white/30 font-mono ml-3.5">{context.dawType.toUpperCase()}</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <StatPill icon={GitBranch} label="Versions" value={String(context.versionCount)} />
        <StatPill icon={Music} label="Audio files" value={String(audioFiles.length)} />
        <StatPill icon={Music} label="MIDI files" value={String(midiFiles.length)} />
        {context.lastSyncedAt && (
          <StatPill icon={Clock} label="Synced" value={formatRelative(context.lastSyncedAt)} />
        )}
        {context.cloudProject?.collaborators?.length ? (
          <StatPill icon={Users} label="Collabs" value={String(context.cloudProject.collaborators.length)} />
        ) : null}
      </div>

      {latestExport && (
        <div className="bg-white/4 border border-white/6 rounded-lg px-2.5 py-2">
          <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Latest Export</p>
          <p className="text-xs text-white/70 truncate">{latestExport.name}</p>
          <p className="text-[10px] text-white/30 font-mono mt-0.5">
            {latestExport.format.toUpperCase()} · {formatRelative(latestExport.createdAt)}
          </p>
        </div>
      )}

      {context.cloudProject?.versions?.length ? (
        <div>
          <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1.5">Recent Versions</p>
          <div className="space-y-1">
            {context.cloudProject.versions.slice(0, 3).map((v) => (
              <div key={v.id} className="flex items-center justify-between text-[10px]">
                <span className="text-white/50 font-mono">v{v.versionNumber}</span>
                <span className="text-white/30">{formatRelative(v.syncedAt)}</span>
                <span className="text-white/25">{formatSize(v.fileSize)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatPill({
  icon: Icon,
  label,
  value,
}: {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5 bg-white/4 rounded-md px-2 py-1">
      <Icon className="w-3 h-3 text-white/25 flex-shrink-0" />
      <span className="text-[10px] text-white/40 truncate">{label}</span>
      <span className="text-[10px] text-white/70 ml-auto font-mono">{value}</span>
    </div>
  );
}
