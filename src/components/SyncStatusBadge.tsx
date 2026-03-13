import { cn } from '../lib/utils';

interface SyncStatusBadgeProps {
  status: string;
  className?: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  synced: { label: 'Synced', color: 'text-emerald-400', dot: 'bg-emerald-400' },
  pending: { label: 'Pending', color: 'text-amber-400', dot: 'bg-amber-400' },
  uploading: { label: 'Uploading', color: 'text-cyan-400', dot: 'bg-cyan-400 animate-pulse' },
  retrying: { label: 'Retrying', color: 'text-amber-400', dot: 'bg-amber-400 animate-pulse' },
  failed: { label: 'Failed', color: 'text-red-400', dot: 'bg-red-400' },
  missing: { label: 'Missing', color: 'text-white/30', dot: 'bg-white/30' },
};

export function SyncStatusBadge({ status, className }: SyncStatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', config.color, className)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', config.dot)} />
      {config.label}
    </span>
  );
}
