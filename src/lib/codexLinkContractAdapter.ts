/**
 * Adapter: Codex Project Link wire shape → desktop AuthoritativeLinkRecord.
 *
 * Source of truth: the LOCKED, committed server contract in the sibling `wavio`
 * repo, branch `test/project-links-authoritative-staging` @
 * `d34d5218eb0b992920a43939eb5c892f69aed030` (`api/desktop/index.ts`; spec in
 * `docs/WAVI_PROJECT_LINKS_SERVER_AUDIT.md`).
 *
 * Contract (endpoint `POST {API_BASE}/desktop`, Bearer auth,
 * `X-Desktop-Action: list-project-links | create-project-link | revoke-project-link`):
 *  - every 200 response carries top-level `accountId` = Privy DID (`did:privy:…`);
 *  - list → `{ accountId, items[], pageInfo{ limit, hasMore, nextCursor, order:'updatedAtDesc,idDesc', scope:'owner' } }`
 *    (cursor-paged, DEFAULT_LIMIT 50, MAX_LIMIT 100);
 *  - create → `{ accountId, created:true, item }`; revoke → `{ accountId, revoked:true, item }`
 *    or `{ accountId, alreadyRevoked:true, item }`;
 *  - item: `{ id, trackingId, publicIdentifier, projectId, versionId, ownerAccountId,
 *      createdAt, updatedAt, revision, expiresAt, state{active,revoked,expired},
 *      permissions{allowDownload, collaboratorMode, previewEnabled, requiresPassword} }`;
 *  - status is BOOLEANS under `state`, not an enum; collaboratorMode supports
 *    only `view | comment` (400 on anything else); create errors: 400 (validation),
 *    404 (project not owned), 409 (no publishable version), 500; revoke errors:
 *    400, 404 (not found/not owned), 500;
 *  - reconciliation rule: a cached link may be marked reconciliation-needed only
 *    after ALL pages for the same scope are exhausted.
 */
import type { AuthoritativeLinkRecord } from './linkReconciliation';

/** Locked endpoint + actions. Path is relative to API_BASE (e.g. `${API_BASE}/desktop`). */
export const DESKTOP_ENDPOINT_PATH = '/desktop';
export const DESKTOP_ACTIONS = {
  list: 'list-project-links',
  create: 'create-project-link',
  revoke: 'revoke-project-link',
} as const;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

/** Raw wire item as implemented on the Codex staging branch. */
export interface CodexWireLinkItem {
  id?: unknown;
  trackingId?: unknown;
  publicIdentifier?: unknown;
  projectId?: unknown;
  versionId?: unknown;
  ownerAccountId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  revision?: unknown;
  expiresAt?: unknown;
  state?: { active?: unknown; revoked?: unknown; expired?: unknown };
  permissions?: Record<string, unknown>;
}

export type WireParseResult =
  | { kind: 'ok'; record: AuthoritativeLinkRecord }
  | { kind: 'malformed'; reason: string };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Map one wire item to the desktop's authoritative record. Fail-closed: any
 * missing required field or contradictory state is `malformed`, never guessed.
 */
export function parseAuthoritativeItem(raw: unknown): WireParseResult {
  const w = (raw ?? {}) as CodexWireLinkItem;
  const linkId = str(w.id);
  const trackingId = str(w.trackingId);
  const projectId = str(w.projectId);
  const versionId = str(w.versionId);
  const owner = str(w.ownerAccountId);
  const createdAt = str(w.createdAt);
  if (!linkId || !trackingId || !projectId || !versionId || !owner || !createdAt) {
    return { kind: 'malformed', reason: 'missing required field(s)' };
  }
  const s = w.state ?? {};
  const revoked = s.revoked === true;
  const expired = s.expired === true;
  const active = s.active === true;
  // Server derives active = !revoked && !expired; a contradictory combination
  // means the shape changed — fail closed rather than pick a state.
  if (active === (revoked || expired)) {
    return { kind: 'malformed', reason: 'contradictory state booleans' };
  }
  const status: AuthoritativeLinkRecord['status'] = revoked ? 'revoked' : expired ? 'expired' : 'active';
  return {
    kind: 'ok',
    record: {
      accountId: owner,
      linkId,
      trackingId,
      projectId,
      projectVersionId: versionId,
      status,
      permissions: (w.permissions ?? {}) as Record<string, unknown>,
      createdAt,
      expiresAt: str(w.expiresAt),
      revokedAt: null, // wire carries no revokedAt timestamp; revocation is state.revoked + updatedAt
      updatedAt: str(w.updatedAt) ?? undefined,
    },
  };
}

/** Top-level list response (observed shape). */
export interface CodexWireListResponse {
  accountId?: unknown;
  items?: unknown;
  pageInfo?: { limit?: unknown; hasMore?: unknown; nextCursor?: unknown; order?: unknown; scope?: unknown };
}

export type WireListParseResult =
  | {
      kind: 'ok';
      accountId: string;
      records: AuthoritativeLinkRecord[];
      hasMore: boolean;
      nextCursor: string | null;
      /** True only when hasMore=false — the ONLY condition under which a cached
       *  link absent from the accumulated records may become reconciliation-needed. */
      pageComplete: boolean;
    }
  | { kind: 'malformed'; reason: string };

export function parseListResponse(raw: unknown): WireListParseResult {
  const w = (raw ?? {}) as CodexWireListResponse;
  const accountId = str(w.accountId);
  if (!accountId) return { kind: 'malformed', reason: 'missing accountId' };
  if (!Array.isArray(w.items)) return { kind: 'malformed', reason: 'items is not an array' };
  const records: AuthoritativeLinkRecord[] = [];
  for (const item of w.items) {
    const parsed = parseAuthoritativeItem(item);
    if (parsed.kind !== 'ok') return { kind: 'malformed', reason: `item: ${parsed.reason}` };
    records.push(parsed.record);
  }
  const hasMore = w.pageInfo?.hasMore === true;
  return {
    kind: 'ok',
    accountId,
    records,
    hasMore,
    nextCursor: str(w.pageInfo?.nextCursor),
    pageComplete: !hasMore,
  };
}

/** Top-level create/revoke response (observed shape). */
export interface CodexWireMutationResponse {
  accountId?: unknown;
  created?: unknown;
  revoked?: unknown;
  alreadyRevoked?: unknown;
  item?: unknown;
  error?: unknown;
}

export type MutationParseResult =
  | { kind: 'confirmed'; accountId: string; record: AuthoritativeLinkRecord; alreadyRevoked: boolean }
  | { kind: 'malformed'; reason: string };

/**
 * Parse a create/revoke 200 body. Fail-closed: a confirmation requires BOTH a
 * top-level `accountId` and a parseable `item`; a missing/garbled item is
 * `malformed`, never a fabricated success. `alreadyRevoked` is surfaced honestly.
 */
export function parseMutationResponse(raw: unknown): MutationParseResult {
  const w = (raw ?? {}) as CodexWireMutationResponse;
  const accountId = str(w.accountId);
  if (!accountId) return { kind: 'malformed', reason: 'missing accountId' };
  const confirmed = w.created === true || w.revoked === true || w.alreadyRevoked === true;
  if (!confirmed) return { kind: 'malformed', reason: 'no created/revoked/alreadyRevoked flag' };
  const item = parseAuthoritativeItem(w.item);
  if (item.kind !== 'ok') return { kind: 'malformed', reason: `item: ${item.reason}` };
  return { kind: 'confirmed', accountId, record: item.record, alreadyRevoked: w.alreadyRevoked === true };
}

/**
 * Classify a non-2xx desktop response into a typed failure reason. Mirrors the
 * locked contract's status codes. `online:false` (thrown fetch) overrides to
 * `offline`. Never yields a success.
 */
export type DesktopFailureReason =
  | 'offline' | 'unauthorized' | 'rejected' | 'not-found' | 'conflict' | 'retryable' | 'malformed';

export function classifyHttpFailure(status: number, online: boolean): DesktopFailureReason {
  if (!online) return 'offline';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 400) return 'rejected';
  if (status >= 500) return 'retryable';
  return 'malformed';
}

/**
 * Collaborator modes the SERVER actually supports (create rejects others with
 * a 400). The desktop UI must not offer `edit` until the server adds it.
 */
export const SERVER_SUPPORTED_COLLABORATOR_MODES = ['view', 'comment'] as const;
export function isServerSupportedCollaboratorMode(mode: string): boolean {
  return (SERVER_SUPPORTED_COLLABORATOR_MODES as readonly string[]).includes(mode);
}
