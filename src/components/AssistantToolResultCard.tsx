import { CheckCircle2, AlertTriangle, Clock, Ban, RefreshCw, FolderGit2 } from 'lucide-react';
import { Surface } from './ui/Surface';
import { StatusBadge, type StatusTone } from './ui/StatusBadge';
import { Button } from './ui/Button';
import { toToolCardModel, type RawToolResult, type CardTone } from '../lib/assistantToolCard';

/**
 * Deterministic result card for a local assistant tool (P3-3). Token-driven,
 * consistent with the desktop primitives — no gradients, glass, or oversized
 * chatbot styling. Shows action · project context · result · failure · retry.
 */
const TONE_META: Record<CardTone, { badge: StatusTone; label: string; Icon: typeof CheckCircle2 }> = {
  success: { badge: 'success', label: 'Done', Icon: CheckCircle2 },
  error:   { badge: 'error', label: 'Failed', Icon: AlertTriangle },
  pending: { badge: 'warning', label: 'Awaiting confirmation', Icon: Clock },
  blocked: { badge: 'planned', label: 'Unavailable', Icon: Ban },
};

export function AssistantToolResultCard({
  toolName, result, activeProjectName, onRetry,
}: {
  toolName: string;
  result: RawToolResult;
  activeProjectName?: string | null;
  onRetry?: () => void;
}) {
  const model = toToolCardModel(toolName, result, activeProjectName);
  const meta = TONE_META[model.tone];
  const Icon = meta.Icon;

  return (
    <Surface variant="inset" className="border border-hairline p-3 max-w-md">
      <div className="flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 text-fg-quaternary flex-shrink-0" />
        <span className="text-xs font-medium text-fg-secondary">{model.action}</span>
        <StatusBadge tone={meta.badge} label={meta.label} className="ml-auto" />
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-meta text-fg-quaternary">
        <FolderGit2 className="w-3 h-3" />
        <span className="truncate">{model.projectLabel}</span>
      </div>
      <p className="mt-1.5 text-meta text-fg-secondary leading-relaxed whitespace-pre-line">{model.body}</p>
      {model.blockedReason && (
        <p className="mt-1 text-meta text-fg-quaternary font-mono">{model.blockedReason}</p>
      )}
      {model.retryable && onRetry && (
        <div className="mt-2">
          <Button variant="ghost" size="compact" onClick={onRetry} aria-label="Retry">
            <RefreshCw className="w-3 h-3" /> Retry
          </Button>
        </div>
      )}
    </Surface>
  );
}
