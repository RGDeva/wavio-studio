import { useState } from 'react';
import { File, Cloud, HardDrive, Copy, Check, ExternalLink, FolderOpen } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * FileRow — one file in a project's contents (P3-1c).
 *
 * Decoupled from IPC: it takes display fields + callbacks, so it never holds or
 * renders a raw absolute path. The caller passes a project-relative path and
 * wires open/reveal. Includes local/cloud/missing status and package inclusion.
 */
export interface FileRowProps {
  fileName: string;
  relPath: string;
  size: string;
  missing?: boolean;
  synced?: boolean;
  included?: boolean;
  checksum?: string | null;
  onOpen?: () => void;
  onReveal?: () => void;
}

export function FileRow({ fileName, relPath, size, missing, synced, included, checksum, onOpen, onReveal }: FileRowProps) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group flex items-start gap-2 px-3 py-2.5 hover:bg-layer-1 transition-colors border-b border-border-subtle last:border-0">
      <File className="w-3.5 h-3.5 text-fg-quaternary mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm text-foreground/85 truncate">{fileName}</span>
          {missing && <span className="text-meta text-destructive bg-destructive/10 rounded px-1">missing</span>}
          {included && <span className="text-meta text-success/80 bg-success/10 rounded px-1">in package</span>}
        </div>
        <div className="flex items-center gap-3 text-meta text-muted-fg">
          <span className="font-mono truncate max-w-[200px]" title={relPath}>{relPath}</span>
          <span className="font-mono tabular-nums">{size}</span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          {synced
            ? <span className="flex items-center gap-0.5 text-meta text-primary/70"><Cloud className="w-2.5 h-2.5" /> synced</span>
            : <span className="flex items-center gap-0.5 text-meta text-fg-quaternary"><HardDrive className="w-2.5 h-2.5" /> local only</span>}
          {checksum && (
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(checksum).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
              title="Copy checksum"
              className={cn('flex items-center gap-0.5 text-meta text-fg-quaternary hover:text-fg-tertiary',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded')}
            >
              {copied ? <Check className="w-2.5 h-2.5 text-success" /> : <Copy className="w-2.5 h-2.5" />}
            </button>
          )}
        </div>
      </div>
      {!missing && (onOpen || onReveal) && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
          {onOpen && (
            <button type="button" onClick={onOpen} title="Open" className="p-1 rounded hover:bg-layer-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <ExternalLink className="w-3 h-3 text-fg-quaternary" />
            </button>
          )}
          {onReveal && (
            <button type="button" onClick={onReveal} title="Reveal in Finder" className="p-1 rounded hover:bg-layer-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <FolderOpen className="w-3 h-3 text-fg-quaternary" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
