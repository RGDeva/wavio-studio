import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function getDawColor(dawType: string): string {
  const map: Record<string, string> = {
    'FL Studio': '#ff8c00',
    'Pro Tools': '#00b4d8',
    'Ableton Live': '#a8d8a8',
    'Logic Pro': '#7c3aed',
    'Reaper': '#ef4444',
    'Cubase': '#c0392b',
    'GarageBand': '#2ecc71',
    'Adobe Audition': '#00d4ff',
  };
  return map[dawType] ?? '#6b7280';
}

export function getSyncStatusColor(status: string): string {
  const map: Record<string, string> = {
    synced: '#10b981',
    pending: '#f59e0b',
    uploading: '#06b6d4',
    failed: '#ef4444',
    retrying: '#f59e0b',
    missing: '#6b7280',
  };
  return map[status] ?? '#6b7280';
}

export function truncatePath(filePath: string, maxLen = 48): string {
  if (filePath.length <= maxLen) return filePath;
  const parts = filePath.split('/');
  if (parts.length <= 3) return `...${filePath.slice(-maxLen)}`;
  return `${parts[0]}/${parts[1]}/.../${parts[parts.length - 1]}`;
}
