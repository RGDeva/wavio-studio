import type { LinkListItem } from './api';

/**
 * Pure presentation logic for the Links page, kept out of the component so it
 * is unit-testable under node vitest (no renderer test environment exists).
 * The server remains authoritative for actual access decisions — these
 * derivations are display-only.
 */

export type LinkStatus = 'active' | 'expired' | 'revoked';

/** Revoked wins over expired; expiry is compared against `now`. */
export function deriveLinkStatus(link: Pick<LinkListItem, 'revoked_at' | 'expires_at'>, now: Date = new Date()): LinkStatus {
  if (link.revoked_at) return 'revoked';
  if (link.expires_at && new Date(link.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** Canonical capability names (mirrors the canonical-link architecture doc). */
export function linkCapabilities(link: Pick<LinkListItem, 'kind' | 'allow_download' | 'collaborator_mode'>): string[] {
  const caps: string[] = ['stream_preview'];
  if (link.kind === 'listen') {
    if (link.allow_download) caps.push('download_audio');
  } else {
    if (link.allow_download) caps.push('download_project_pack');
    caps.push('open_in_studio');
    if (link.collaborator_mode === 'comment' || link.collaborator_mode === 'edit') caps.push('comment');
    if (link.collaborator_mode === 'edit') caps.push('collaborate');
  }
  return caps;
}

/** Short human label for a capability badge. */
export const CAPABILITY_LABELS: Record<string, string> = {
  stream_preview: 'Stream',
  download_audio: 'Download audio',
  download_project_pack: 'Project Pack',
  open_in_studio: 'Open in Studio',
  comment: 'Comment',
  collaborate: 'Collaborate',
};

export interface LinkFilters {
  query?: string;
  kind?: 'all' | 'listen' | 'project';
  status?: 'all' | LinkStatus;
  projectId?: string | null;
}

export function filterLinks(links: LinkListItem[], filters: LinkFilters, now: Date = new Date()): LinkListItem[] {
  const q = (filters.query ?? '').trim().toLowerCase();
  return links.filter((l) => {
    if (filters.kind && filters.kind !== 'all' && l.kind !== filters.kind) return false;
    if (filters.status && filters.status !== 'all' && deriveLinkStatus(l, now) !== filters.status) return false;
    if (filters.projectId && l.project_id !== filters.projectId) return false;
    if (q) {
      const haystack = `${l.label ?? ''} ${l.project_name ?? ''} ${l.url}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/** Whether we know enough to recreate this link with different permissions. */
export function canDuplicate(link: Pick<LinkListItem, 'kind' | 'asset_id' | 'project_id'>): boolean {
  return link.kind === 'listen' ? !!link.asset_id : !!link.project_id;
}

/** Display name shown as the row title. */
export function linkDisplayName(link: Pick<LinkListItem, 'label' | 'project_name' | 'kind'>): string {
  if (link.label) return link.label;
  if (link.project_name) return `${link.project_name} — ${link.kind === 'project' ? 'Project Link' : 'Listen Link'}`;
  return link.kind === 'project' ? 'Project Link' : 'Listen Link';
}
