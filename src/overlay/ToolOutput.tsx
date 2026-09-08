import { useState } from 'react';
import { FileMusic, FolderOpen, CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import type { ToolOutput as ToolOutputType } from './types';

interface ToolOutputProps {
  output: ToolOutputType;
}

const TOOL_ICONS: Record<string, React.FC<{ className?: string }>> = {
  generate_midi_melody: FileMusic,
  generate_chord_progression: FileMusic,
  generate_drum_pattern: FileMusic,
  reveal_project_folder: FolderOpen,
  explain_import_to_fl_studio: FileMusic,
  summarize_project_context: FileMusic,
};

const TOOL_LABELS: Record<string, string> = {
  generate_midi_melody: 'MIDI Melody',
  generate_chord_progression: 'Chord Progression',
  generate_drum_pattern: 'Drum Pattern',
  reveal_project_folder: 'Open Folder',
  explain_import_to_fl_studio: 'FL Studio Guide',
  summarize_project_context: 'Project Summary',
};

export function ToolOutput({ output }: ToolOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = TOOL_ICONS[output.toolName] ?? FileMusic;
  const label = TOOL_LABELS[output.toolName] ?? output.toolName;
  const hasGuide = !!output.importGuide;
  const fileName = output.filePath?.split('/').pop();

  return (
    <div className="bg-[#0d1117] border border-hairline-strong rounded-lg overflow-hidden text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="w-3.5 h-3.5 text-primary flex-shrink-0" />
        <span className="text-fg-tertiary flex-1">{label}</span>
        {output.status === 'running' && (
          <Loader2 className="w-3 h-3 text-fg-quaternary animate-spin" />
        )}
        {output.status === 'done' && (
          <CheckCircle className="w-3 h-3 text-success" />
        )}
        {output.status === 'error' && (
          <XCircle className="w-3 h-3 text-destructive" />
        )}
        {(hasGuide || output.filePath) && output.status === 'done' && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-fg-quaternary hover:text-fg-tertiary transition-colors"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        )}
      </div>

      {output.status === 'error' && (
        <div className="px-3 pb-2 text-destructive/80">{output.error}</div>
      )}

      {output.status === 'done' && output.filePath && (
        <div className="px-3 pb-1.5 flex items-center gap-1.5">
          <span className="text-fg-quaternary">→</span>
          <span className="font-mono text-meta text-primary/70 truncate">{fileName}</span>
        </div>
      )}

      {expanded && output.description && (
        <div className="px-3 pb-2 text-fg-tertiary border-t border-hairline pt-2">
          {output.description}
        </div>
      )}

      {expanded && output.importGuide && (
        <div className="px-3 pb-2 border-t border-hairline pt-2 space-y-1">
          <p className="text-fg-quaternary text-meta uppercase tracking-wider">FL Studio Import</p>
          <p className="text-fg-tertiary leading-relaxed whitespace-pre-wrap">{output.importGuide}</p>
        </div>
      )}
    </div>
  );
}
