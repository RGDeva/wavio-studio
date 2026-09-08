import { cn } from '../../lib/utils';

/**
 * StatusBadge — second shared desktop primitive (P3-1a).
 *
 * Compact dot + label for a semantic state. Not a decorative pill. Token-driven
 * colors so status reads consistently across the app. Optional pulse for
 * in-progress states; optional title for the hover explanation.
 */
export type StatusTone =
  | 'synced' | 'syncing' | 'local' | 'paused' | 'offline'
  | 'warning' | 'error' | 'success' | 'beta' | 'planned';

export interface StatusBadgeProps {
  tone: StatusTone;
  label?: string;
  title?: string;
  pulse?: boolean;
  className?: string;
}

const TONES: Record<StatusTone, { text: string; dot: string; label: string }> = {
  synced:  { text: 'text-success', dot: 'bg-success', label: 'Synced' },
  syncing: { text: 'text-primary', dot: 'bg-primary', label: 'Syncing' },
  local:   { text: 'text-fg-tertiary', dot: 'bg-layer-20', label: 'Local' },
  paused:  { text: 'text-fg-tertiary', dot: 'bg-layer-20', label: 'Paused' },
  offline: { text: 'text-fg-quaternary', dot: 'bg-layer-10', label: 'Offline' },
  warning: { text: 'text-warning', dot: 'bg-warning', label: 'Warning' },
  error:   { text: 'text-destructive', dot: 'bg-destructive', label: 'Error' },
  success: { text: 'text-success', dot: 'bg-success', label: 'Success' },
  beta:    { text: 'text-info', dot: 'bg-info', label: 'Beta' },
  planned: { text: 'text-fg-quaternary', dot: 'bg-layer-10', label: 'Planned' },
};

export function StatusBadge({ tone, label, title, pulse = false, className }: StatusBadgeProps) {
  const t = TONES[tone];
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-xs font-medium', t.text, className)}
      title={title}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full', t.dot, pulse && 'animate-pulse')} />
      {label ?? t.label}
    </span>
  );
}
