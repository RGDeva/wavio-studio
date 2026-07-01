import { cn } from '../lib/utils';

interface SyncStatusBadgeProps {
  status: string;
  className?: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string; explanation: string }> = {
  synced: { label: 'Synced', color: 'text-emerald-400', dot: 'bg-emerald-400', explanation: 'Uploaded and up to date in the cloud.' },
  pending: { label: 'Pending', color: 'text-amber-400', dot: 'bg-amber-400', explanation: 'Queued for upload — waiting for a free upload slot.' },
  uploading: { label: 'Uploading', color: 'text-cyan-400', dot: 'bg-cyan-400 animate-pulse', explanation: 'Uploading right now.' },
  retrying: { label: 'Retrying', color: 'text-amber-400', dot: 'bg-amber-400 animate-pulse', explanation: 'A previous attempt failed — will retry automatically.' },
  failed: { label: 'Failed', color: 'text-red-400', dot: 'bg-red-400', explanation: 'Upload failed after all retries. Use Retry to try again.' },
  paused: { label: 'Paused', color: 'text-white/50', dot: 'bg-white/40', explanation: 'Sync is paused — nothing will upload until you resume.' },
  missing: { label: 'Missing', color: 'text-white/30', dot: 'bg-white/30', explanation: 'The local file could not be found on disk.' },
  cancelled: { label: 'Cancelled', color: 'text-white/30', dot: 'bg-white/30', explanation: 'Upload was cancelled and will not retry automatically.' },
};

export function SyncStatusBadge({ status, className }: SyncStatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', config.color, className)} title={config.explanation}>
      <span className={cn('w-1.5 h-1.5 rounded-full', config.dot)} />
      {config.label}
    </span>
  );
}
