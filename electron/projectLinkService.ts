/**
 * Authoritative Project Link networking + reconciliation (main process).
 *
 * Talks to the LOCKED Codex contract (`wavio` @ d34d5218,
 * `POST {API_BASE}/desktop`, `X-Desktop-Action:
 * list-project-links | create-project-link | revoke-project-link`; identity is
 * the server-returned Privy DID in `accountId`). Lives in the main process
 * because the auth token and SQLite are here and must never reach the renderer.
 *
 * Pure + injectable: `postDesktop`/`isOnline` and the db ops are passed in, so
 * the flows are fully unit-testable with fakes. Parse logic mirrors the
 * renderer-side `src/lib/codexLinkContractAdapter.ts` (the electron/renderer
 * rootDir boundary forbids a shared import); both are contract-pinned + tested.
 */

// ── Wire types (subset the desktop consumes) ─────────────────────────────────
export interface AuthoritativeItem {
  linkId: string;
  trackingId: string;
  projectId: string;
  projectVersionId: string;
  ownerAccountId: string;
  status: 'active' | 'revoked' | 'expired';
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  permissions: Record<string, unknown>;
}

export interface DesktopResponse {
  status: number;
  json: unknown;
  /** true when fetch threw (network down / abort) — treated as offline. */
  threw?: boolean;
}

export interface ProjectLinkServiceDeps {
  postDesktop: (action: string, body: Record<string, unknown>) => Promise<DesktopResponse>;
  isOnline: () => boolean;
}

export const DESKTOP_ACTIONS = {
  list: 'list-project-links',
  create: 'create-project-link',
  revoke: 'revoke-project-link',
} as const;
export const DEFAULT_LIST_LIMIT = 50;
const MAX_PAGES = 100; // hard safety cap on pagination

/**
 * THE authoritative desktop endpoint builder. The locked contract serves
 * exactly `POST /api/desktop` — never `/desktop`, `/api/api/desktop`, or the
 * obsolete `/api/desktop/index`. Every environment's base is normalized here:
 *  - production default  `https://wavi.stream/api`        → …/api/desktop
 *  - preview/QA          `https://<preview>.vercel.app/api`→ …/api/desktop
 *  - misconfigured bare origin (no `/api` suffix)          → `/api` is appended
 *  - trailing slashes are stripped; a double `/api/api` is collapsed.
 */
export function buildDesktopEndpoint(apiBase: string): string {
  let base = (apiBase ?? '').trim().replace(/\/+$/, '');
  base = base.replace(/\/api\/api$/, '/api');       // collapse accidental double
  if (!/\/api$/.test(base)) base = `${base}/api`;   // guarantee the /api prefix
  return `${base}/desktop`;
}

/**
 * Opaque renderer-facing account handle. The canonical Privy DID stays in the
 * main process; the renderer only needs a stable per-account scoping key for
 * its epoch/resolver — it must never see the DID itself. Deterministic,
 * non-reversible (sha256 prefix), and shape-compatible with the renderer's
 * canonical-id validation (`acct_` + hex).
 */
export function toRendererAccountHandle(did: string): string {
  // Lazy import keeps this module dependency-light for pure call sites.
  const { createHash } = require('crypto') as typeof import('crypto');
  return `acct_${createHash('sha256').update(did).digest('hex').slice(0, 20)}`;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

export type ItemParse = { ok: true; item: AuthoritativeItem } | { ok: false; reason: string };

/** Parse one wire item; fail-closed on missing/contradictory fields. */
export function parseItem(raw: unknown): ItemParse {
  const w = (raw ?? {}) as Record<string, any>;
  const linkId = str(w.id);
  const trackingId = str(w.trackingId);
  const projectId = str(w.projectId);
  const projectVersionId = str(w.versionId);
  const ownerAccountId = str(w.ownerAccountId);
  const createdAt = str(w.createdAt);
  if (!linkId || !trackingId || !projectId || !projectVersionId || !ownerAccountId || !createdAt) {
    return { ok: false, reason: 'missing required field(s)' };
  }
  const s = (w.state ?? {}) as Record<string, unknown>;
  const revoked = s.revoked === true;
  const expired = s.expired === true;
  const active = s.active === true;
  // Server derives active = !revoked && !expired; a contradiction means the
  // shape drifted — fail closed rather than guess a state.
  if (active === (revoked || expired)) return { ok: false, reason: 'contradictory state booleans' };
  return {
    ok: true,
    item: {
      linkId, trackingId, projectId, projectVersionId, ownerAccountId,
      status: revoked ? 'revoked' : expired ? 'expired' : 'active',
      expiresAt: str(w.expiresAt),
      createdAt,
      updatedAt: str(w.updatedAt),
      permissions: (w.permissions ?? {}) as Record<string, unknown>,
    },
  };
}

export type FailureReason =
  | 'offline' | 'unauthorized' | 'rejected' | 'not-found' | 'conflict' | 'retryable' | 'malformed'
  /** Create-only: the request may or may not have reached the server (thrown
   *  fetch / timeout mid-flight). Create is NOT idempotent, so this is never
   *  auto-retried — recovery is the authoritative listing (reconcile). */
  | 'create-outcome-unknown'
  /** The session (login/account) changed while the request was in flight; the
   *  response was discarded and nothing was persisted. */
  | 'stale-session';

/** Map an HTTP status (contract-pinned) to a typed failure. Offline wins. */
export function classifyHttpFailure(status: number, online: boolean): FailureReason {
  if (!online) return 'offline';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 400) return 'rejected';
  if (status >= 500) return 'retryable';
  return 'malformed';
}

function failureFrom(res: DesktopResponse, online: boolean): { reason: FailureReason; message?: string } {
  if (res.threw || !online) return { reason: 'offline' };
  const body = (res.json ?? {}) as Record<string, unknown>;
  return { reason: classifyHttpFailure(res.status, online), message: str(body.error) ?? undefined };
}

// ── List (paginated, account-scoped) ─────────────────────────────────────────
export type ListResult =
  | { kind: 'ok'; accountId: string; records: AuthoritativeItem[]; pageComplete: boolean }
  | { kind: 'failure'; reason: FailureReason; message?: string };

export async function listProjectLinksAll(
  deps: ProjectLinkServiceDeps,
  filter: { projectId?: string; versionId?: string } = {},
): Promise<ListResult> {
  const records: AuthoritativeItem[] = [];
  let accountId: string | null = null;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let res: DesktopResponse;
    try {
      res = await deps.postDesktop(DESKTOP_ACTIONS.list, {
        ...filter, limit: DEFAULT_LIST_LIMIT, ...(cursor ? { cursor } : {}),
      });
    } catch { return { kind: 'failure', reason: 'offline' }; }
    const online = deps.isOnline();
    if (res.threw || res.status !== 200) {
      const f = failureFrom(res, online);
      return { kind: 'failure', reason: f.reason, message: f.message };
    }
    const body = (res.json ?? {}) as Record<string, any>;
    const acct = str(body.accountId);
    if (!acct) return { kind: 'failure', reason: 'malformed', message: 'missing accountId' };
    accountId = acct;
    if (!Array.isArray(body.items)) return { kind: 'failure', reason: 'malformed', message: 'items not an array' };
    for (const raw of body.items) {
      const p = parseItem(raw);
      if (!p.ok) return { kind: 'failure', reason: 'malformed', message: p.reason };
      records.push(p.item);
    }
    const hasMore = body.pageInfo?.hasMore === true;
    cursor = str(body.pageInfo?.nextCursor);
    if (!hasMore || !cursor) {
      // pageComplete ONLY when the server said there is no more — the sole
      // condition under which a cached row absent here may become
      // reconciliation-needed.
      return { kind: 'ok', accountId: accountId!, records, pageComplete: !hasMore };
    }
  }
  // Hit the safety cap without the server signalling completion.
  return { kind: 'ok', accountId: accountId!, records, pageComplete: false };
}

// ── Create / revoke (typed, never a fabricated success) ──────────────────────
export type MutationResult =
  | { kind: 'confirmed'; accountId: string; item: AuthoritativeItem; alreadyRevoked: boolean }
  | { kind: 'failure'; reason: FailureReason; message?: string };

function parseMutation(res: DesktopResponse, online: boolean): MutationResult {
  if (res.threw || res.status !== 200) {
    const f = failureFrom(res, online);
    return { kind: 'failure', reason: f.reason, message: f.message };
  }
  const body = (res.json ?? {}) as Record<string, any>;
  const accountId = str(body.accountId);
  if (!accountId) return { kind: 'failure', reason: 'malformed', message: 'missing accountId' };
  const confirmed = body.created === true || body.revoked === true || body.alreadyRevoked === true;
  if (!confirmed) return { kind: 'failure', reason: 'malformed', message: 'no confirmation flag' };
  const p = parseItem(body.item);
  if (!p.ok) return { kind: 'failure', reason: 'malformed', message: p.reason };
  return { kind: 'confirmed', accountId, item: p.item, alreadyRevoked: body.alreadyRevoked === true };
}

export interface CreateFlowOpts {
  projectId: string; projectVersionId?: string; allowDownload?: boolean;
  expiresAt?: string | null; collaboratorMode?: 'view' | 'comment';
}

/** Normalized key for one create configuration — the in-flight dedup unit. */
export function normalizeCreateKey(opts: CreateFlowOpts): string {
  return JSON.stringify({
    p: opts.projectId, v: opts.projectVersionId ?? null,
    d: opts.allowDownload !== false, e: opts.expiresAt ?? null,
    m: opts.collaboratorMode ?? 'view',
  });
}

export async function createProjectLinkFlow(
  deps: ProjectLinkServiceDeps,
  opts: CreateFlowOpts,
): Promise<MutationResult> {
  let res: DesktopResponse;
  try {
    res = await deps.postDesktop(DESKTOP_ACTIONS.create, {
      projectId: opts.projectId,
      ...(opts.projectVersionId ? { projectVersionId: opts.projectVersionId } : {}),
      allowDownload: opts.allowDownload !== false,
      expiresAt: opts.expiresAt ?? null,
      collaboratorMode: opts.collaboratorMode ?? 'view',
    });
  } catch {
    // Create is NOT idempotent: a thrown fetch/timeout is AMBIGUOUS (the insert
    // may have landed). Never report plain offline, never auto-retry — surface
    // outcome-unknown and point recovery at the authoritative listing.
    return { kind: 'failure', reason: 'create-outcome-unknown', message: 'The link may or may not have been created. Refresh Links (reconcile) to check — do not retry blindly.' };
  }
  if (res.threw) {
    return { kind: 'failure', reason: 'create-outcome-unknown', message: 'The link may or may not have been created. Refresh Links (reconcile) to check — do not retry blindly.' };
  }
  return parseMutation(res, deps.isOnline());
}

export async function revokeProjectLinkFlow(
  deps: ProjectLinkServiceDeps,
  trackingId: string,
): Promise<MutationResult> {
  let res: DesktopResponse;
  try {
    res = await deps.postDesktop(DESKTOP_ACTIONS.revoke, { trackingId });
  } catch { return { kind: 'failure', reason: 'offline' }; }
  return parseMutation(res, deps.isOnline());
}

// ── Reconciliation plan (pure) ───────────────────────────────────────────────
export interface CachedRow {
  tracking_id: string;
  account_id: string | null;
  revoked_at: string | null;
  project_id?: string | null;
  version_id?: string | null;
}
export type ReconcileOp =
  | { op: 'apply'; item: AuthoritativeItem }
  | { op: 'reconciliation-needed'; tracking_id: string };

/**
 * Given the authoritative records for an account and the local cached rows for
 * the SAME account, produce the db operations. Fail-closed rules:
 *  - only records whose owner matches `accountId` are applied (a foreign record
 *    can never rewrite this account's cache);
 *  - a cached row absent from the authoritative set is flagged
 *    `reconciliation-needed` ONLY when the listing was page-complete AND the
 *    row falls inside the listing's filter scope — a project/version-filtered
 *    listing can never mark another project's rows missing;
 *  - legacy rows (account_id NULL) are left untouched (ownership-unknown).
 */
export function planReconciliation(
  accountId: string,
  authoritative: AuthoritativeItem[],
  cached: CachedRow[],
  pageComplete: boolean,
  filter?: { projectId?: string; versionId?: string },
): ReconcileOp[] {
  const ops: ReconcileOp[] = [];
  const authById = new Map(authoritative.filter((a) => a.ownerAccountId === accountId).map((a) => [a.trackingId, a]));
  for (const item of authById.values()) ops.push({ op: 'apply', item });
  if (pageComplete) {
    for (const row of cached) {
      if (row.account_id !== accountId) continue; // only this account's rows
      if (row.revoked_at) continue;               // already terminal
      // A filtered listing only proves absence WITHIN its scope.
      if (filter?.projectId && row.project_id !== filter.projectId) continue;
      if (filter?.versionId && row.version_id !== filter.versionId) continue;
      if (!authById.has(row.tracking_id)) ops.push({ op: 'reconciliation-needed', tracking_id: row.tracking_id });
    }
  }
  return ops;
}

// ── In-flight coordination (dedup + session-generation invalidation) ─────────

export interface CoordinatedResult<T> {
  /** True when login/logout/account change happened mid-flight — the caller
   *  MUST discard the value and persist nothing. */
  stale: boolean;
  value: T;
}

/**
 * One coordinator per main-process session. Guarantees:
 *  - at most ONE in-flight reconcile per filter key and ONE in-flight create
 *    per normalized configuration (double-click dedup — callers share the same
 *    promise; no duplicate network requests);
 *  - a session-generation counter, bumped on logout/token change, marks any
 *    in-flight response `stale` so it is discarded, never persisted;
 *  - no automatic retry of anything, ever.
 */
export function createLinkOpsCoordinator() {
  let generation = 0;
  const inflight = new Map<string, Promise<CoordinatedResult<unknown>>>();

  async function run<T>(key: string, fn: () => Promise<T>): Promise<CoordinatedResult<T>> {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<CoordinatedResult<T>>;
    const startGen = generation;
    const p = (async () => {
      try {
        const value = await fn();
        return { stale: generation !== startGen, value };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p as Promise<CoordinatedResult<unknown>>);
    return p;
  }

  return {
    /** Logout / token replacement / account switch: invalidate everything in flight. */
    bumpGeneration(): void { generation++; inflight.clear(); },
    generation(): number { return generation; },
    inflightCount(): number { return inflight.size; },
    runReconcile<T>(filterKey: string, fn: () => Promise<T>) { return run(`reconcile:${filterKey}`, fn); },
    runCreate<T>(createKey: string, fn: () => Promise<T>) { return run(`create:${createKey}`, fn); },
  };
}
