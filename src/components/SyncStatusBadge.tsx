import { StatusBadge, type StatusTone } from './ui/StatusBadge';

interface SyncStatusBadgeProps {
  status: string;
  className?: string;
}

/**
 * Sync-specific badge. Behavior-preserving migration onto the shared
 * StatusBadge primitive (P3-1a): same status strings, labels, and hover
 * explanations; colors now come from the design tokens via StatusBadge tones.
 */
const STATUS_CONFIG: Record<string, { tone: StatusTone; label: string; pulse?: boolean; explanation: string }> = {
  synced:    { tone: 'synced',  label: 'Synced',    explanation: 'Uploaded and up to date in the cloud.' },
  pending:   { tone: 'warning', label: 'Pending',   explanation: 'Queued for upload — waiting for a free upload slot.' },
  uploading: { tone: 'syncing', label: 'Uploading', pulse: true, explanation: 'Uploading right now.' },
  retrying:  { tone: 'warning', label: 'Retrying',  pulse: true, explanation: 'A previous attempt failed — will retry automatically.' },
  failed:    { tone: 'error',   label: 'Failed',    explanation: 'Upload failed after all retries. Use Retry to try again.' },
  paused:    { tone: 'paused',  label: 'Paused',    explanation: 'Sync is paused — nothing will upload until you resume.' },
  missing:   { tone: 'offline', label: 'Missing',   explanation: 'The local file could not be found on disk.' },
  cancelled: { tone: 'offline', label: 'Cancelled', explanation: 'Upload was cancelled and will not retry automatically.' },
};

export function SyncStatusBadge({ status, className }: SyncStatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
  return (
    <StatusBadge tone={config.tone} label={config.label} title={config.explanation} pulse={config.pulse} className={className} />
  );
}
