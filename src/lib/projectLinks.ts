/**
 * Honest desktop Project Link model (P3-2a).
 *
 * The server is the source of truth. The desktop `links` table is a per-device
 * cache with NO server reconciliation (see WAVI_PROJECT_LINKS_DESKTOP_AUDIT.md).
 * These pure helpers derive an honest state for a cached record and normalize
 * the IPC result of a mutation into a typed outcome — so the UI can never show
 * "server-confirmed" for something the server did not confirm this session.
 */

export interface LinkRecord {
  tracking_id: string;
  kind: 'listen' | 'project';
  project_id: string | null;
  project_name?: string | null;
  version_id?: string | null;
  url: string;
  label?: string | null;
  allow_download?: number | boolean;
  collaborator_mode?: string | null;
  expires_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
  /**
   * Canonical owning account id (P3-2b prep). TYPE-ONLY today: no schema
   * migration exists and no code writes it — every current row is `undefined`
   * (ownership-unknown). Populated only once the Codex identity contract lands.
   */
  account_id?: string | null;
}

export type LinkState =
  | 'server-confirmed'   // created this session; server returned a trackingId
  | 'cached'             // present in the local device cache; unverified
  | 'reconciliation-needed'
  | 'offline'
  | 'failed'
  | 'revoked'
  | 'expired'
  | 'permission-denied'
  | 'legacy-local-only'  // listen/pre-registry record lacking project-link fields
  | 'unsupported-contract';

export interface LinkStateContext {
  now?: Date;
  online: boolean;
  /** Tracking ids confirmed by the server in THIS session (create returned them). */
  confirmedThisSession?: ReadonlySet<string>;
  /** Tracking ids the reconcile action was requested for (no server list yet). */
  reconcileRequested?: ReadonlySet<string>;
}

/** Derive an honest state for a cached link record. Never invents server truth. */
export function deriveLinkState(record: LinkRecord, ctx: LinkStateContext): LinkState {
  const now = ctx.now ?? new Date();
  if (record.revoked_at) return 'revoked';
  if (record.expires_at && new Date(record.expires_at).getTime() < now.getTime()) return 'expired';
  // A project link with no version id is a legacy/listen record, not a full Project Link.
  if (record.kind !== 'project' || !record.version_id) return 'legacy-local-only';
  if (ctx.confirmedThisSession?.has(record.tracking_id)) return 'server-confirmed';
  if (!ctx.online) return 'offline';
  if (ctx.reconcileRequested?.has(record.tracking_id)) return 'reconciliation-needed';
  return 'cached'; // present locally, not verified against the server this session
}

export type LinkGroup = 'active' | 'expired' | 'revoked' | 'needs-attention';

export function linkGroupForState(state: LinkState): LinkGroup {
  if (state === 'revoked') return 'revoked';
  if (state === 'expired') return 'expired';
  if (state === 'server-confirmed' || state === 'cached') return 'active';
  return 'needs-attention'; // offline / reconciliation-needed / failed / legacy / permission-denied / unsupported
}

/** Typed outcome of a link mutation — never an ambiguous boolean. */
export type LinkResult =
  | { kind: 'confirmed'; trackingId: string; url?: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'unauthorized' }
  | { kind: 'offline' }
  | { kind: 'unsupported'; message: string }
  | { kind: 'malformed'; message: string }
  | { kind: 'retryable'; message: string }
  | { kind: 'permanent'; message: string };

const NETWORK_RE = /fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EPIPE|aborted|Failed to fetch|TypeError/i;

/**
 * Normalize a raw IPC outcome into a typed LinkResult.
 * `raw` is either the resolved IPC object ({ error } | { trackingId, linkUrl }) or
 * a caught error (offline/timeout throw). `online` disambiguates network failures.
 */
export function normalizeLinkResult(raw: unknown, online: boolean): LinkResult {
  // Thrown / rejected (offline, timeout, abort).
  if (raw instanceof Error || (raw && typeof (raw as any).message === 'string' && !(raw as any).trackingId && !(raw as any).error)) {
    const msg = (raw as any).message ?? 'Request failed';
    if (!online || NETWORK_RE.test(msg)) return { kind: 'offline' };
    return { kind: 'retryable', message: msg };
  }
  const r = (raw ?? {}) as Record<string, any>;
  if (r.error) {
    const e = String(r.error);
    if (!online || NETWORK_RE.test(e)) return { kind: 'offline' };
    if (/not authenticated|unauthor|401/i.test(e)) return { kind: 'unauthorized' };
    if (/403|permission|forbidden/i.test(e)) return { kind: 'rejected', message: e };
    if (/\b5\d\d\b|timeout|temporarily/i.test(e)) return { kind: 'retryable', message: e };
    if (/unsupported|not implemented|404/i.test(e)) return { kind: 'unsupported', message: e };
    return { kind: 'rejected', message: e };
  }
  // create → { trackingId, linkUrl }; revoke → { success: true }.
  if (typeof r.trackingId === 'string') return { kind: 'confirmed', trackingId: r.trackingId, url: r.linkUrl };
  if (r.success === true) return { kind: 'confirmed', trackingId: r.trackingId ?? '', url: r.linkUrl };
  return { kind: 'malformed', message: 'Server response missing a confirmation.' };
}

/** Permissions the desktop can honestly offer today (verified server contract). */
export const SUPPORTED_LINK_PERMISSIONS = ['listen', 'download', 'collaborator_mode'] as const;
export const UNSUPPORTED_LINK_PERMISSIONS = [
  { id: 'download-project-pack', note: 'Server ZIP/Project Pack packaging not available yet.' },
  { id: 'open-in-wavi-studio', note: 'Import-token issuance contract pending.' },
  { id: 'contribute', note: 'Contribution-submission endpoint pending.' },
  { id: 'comment', note: 'Comment storage/enforcement pending.' },
] as const;

export function isPermissionSupported(id: string): boolean {
  return (SUPPORTED_LINK_PERMISSIONS as readonly string[]).includes(id);
}

/**
 * Presentation for each honest state. `tone` is a StatusBadge tone literal (kept
 * as a plain string so this module stays free of UI imports and testable under
 * the Node vitest env). `note` is the honest explanation the UI must show.
 */
export interface LinkStatePresentation {
  tone: 'success' | 'synced' | 'local' | 'offline' | 'warning' | 'error' | 'planned';
  label: string;
  note: string;
}

export const LINK_STATE_PRESENTATION: Record<LinkState, LinkStatePresentation> = {
  'server-confirmed':      { tone: 'success', label: 'Confirmed',        note: 'Created this session — the server confirmed this link.' },
  'cached':                { tone: 'synced',  label: 'Active (cached)',  note: 'Known from this device. Live status is authoritative on the server; not re-verified this session.' },
  'reconciliation-needed': { tone: 'warning', label: 'Needs check',      note: 'Reconciliation was requested, but no server link-listing endpoint exists yet.' },
  'offline':               { tone: 'offline', label: 'Offline',          note: "Can't reach the server — showing the last known local state." },
  'failed':                { tone: 'error',   label: 'Failed',           note: 'The last action for this link did not complete.' },
  'revoked':               { tone: 'local',   label: 'Revoked',          note: 'Access has been revoked. This is permanent.' },
  'expired':               { tone: 'warning', label: 'Expired',          note: 'Past its expiry date; recipients can no longer open it.' },
  'permission-denied':     { tone: 'error',   label: 'Permission denied', note: 'The server rejected access to this link for the current account.' },
  'legacy-local-only':     { tone: 'planned', label: 'Local-only',       note: 'A pre-registry record without full Project Link fields. Shown honestly, not as server-confirmed.' },
  'unsupported-contract':  { tone: 'planned', label: 'Unsupported',      note: 'Depends on a server contract the desktop does not consume yet.' },
};

/** Human-readable heading + helper for each link group. */
export const LINK_GROUP_META: Record<LinkGroup, { title: string; hint: string }> = {
  'active':          { title: 'Active',          hint: 'Live links known to this device.' },
  'needs-attention': { title: 'Needs attention', hint: 'Offline, local-only, or awaiting server reconciliation.' },
  'expired':         { title: 'Expired',         hint: 'Past expiry — recipients can no longer open these.' },
  'revoked':         { title: 'Revoked',         hint: 'Access permanently withdrawn.' },
};

export const LINK_GROUP_ORDER: LinkGroup[] = ['active', 'needs-attention', 'expired', 'revoked'];
