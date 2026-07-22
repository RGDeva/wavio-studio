/**
 * Project Link desktop client (P3-2a).
 *
 * One boundary for Project Link network + cache behavior. Wraps the existing
 * IPC (which is already server-authoritative for create/revoke) and returns
 * typed results — never a bare boolean and never success before the server
 * confirms. Tracks server-confirmed ids for THIS session and invalidates them on
 * account switch, so a cached record can never be presented as freshly
 * server-confirmed for a different account. Does NOT duplicate restore,
 * packaging, or adapter responsibilities.
 */
import {
  type LinkRecord, type LinkState, type LinkGroup, type LinkResult,
  deriveLinkState, linkGroupForState, normalizeLinkResult,
} from './projectLinks';
import {
  type AccountContextResolver, type AuthenticatedAccountContext, SessionEpoch,
  isAcceptableCanonicalAccountId,
} from './accountContext';

export interface CreateProjectLinkOpts {
  projectId: string;
  cloudProjectId?: string;
  projectVersionId?: string;
  allowDownload?: boolean;
  expiresAt?: string;
  collaboratorMode?: 'view' | 'comment' | 'edit';
}

export interface LinkClientDeps {
  createProjectLink: (opts: CreateProjectLinkOpts) => Promise<unknown>;
  revokeLink: (opts: { trackingId: string }) => Promise<unknown>;
  listLinks: () => Promise<LinkRecord[]>;
  isOnline: () => boolean;
}

export interface LinkView {
  record: LinkRecord;
  state: LinkState;
  group: LinkGroup;
}

/**
 * Result of a cache-sensitive, account-scoped operation (P3-2b prep).
 * Fails closed: without an available account context the operation reports
 * `missing-account-context` instead of guessing ownership; a response that
 * resolves after logout/switch reports `stale-epoch` and must be discarded.
 */
export type ScopedListResult =
  | { kind: 'ok'; views: LinkView[]; accountId: string; epoch: number }
  | { kind: 'missing-account-context'; reason: string }
  | { kind: 'stale-epoch' };

export type ScopedRevokeResult =
  | { kind: 'missing-account-context'; reason: string }
  | { kind: 'stale-epoch' }
  | { kind: 'account-mismatch' }   // record not attributable to the active account
  | LinkResult;

export class ProjectLinkClient {
  private confirmed = new Set<string>();
  private reconcileRequested = new Set<string>();
  private accountKey: string | null = null;

  constructor(private deps: LinkClientDeps) {}

  /** Tracking ids the server confirmed in THIS session (read-only view). */
  confirmedIds(): ReadonlySet<string> {
    return this.confirmed;
  }

  /** Set the current account; a change clears session-confirmed + reconcile state. */
  setAccount(key: string | null): void {
    if (key !== this.accountKey) {
      this.confirmed.clear();
      this.reconcileRequested.clear();
      this.accountKey = key;
    }
  }

  async create(opts: CreateProjectLinkOpts): Promise<LinkResult> {
    let res: LinkResult;
    try {
      res = normalizeLinkResult(await this.deps.createProjectLink(opts), this.deps.isOnline());
    } catch (e) {
      res = normalizeLinkResult(e, this.deps.isOnline());
    }
    if (res.kind === 'confirmed' && res.trackingId) this.confirmed.add(res.trackingId);
    return res;
  }

  async revoke(trackingId: string): Promise<LinkResult> {
    let res: LinkResult;
    try {
      res = normalizeLinkResult(await this.deps.revokeLink({ trackingId }), this.deps.isOnline());
    } catch (e) {
      res = normalizeLinkResult(e, this.deps.isOnline());
    }
    return res;
  }

  /**
   * List cached links for a project (and optionally a specific version), each
   * with an honest derived state. Filtering here means a stale caller cannot
   * receive another project's links.
   */
  async list(filter?: { projectId?: string; versionId?: string }): Promise<LinkView[]> {
    const raw = await this.deps.listLinks().catch(() => [] as LinkRecord[]);
    const now = new Date();
    const online = this.deps.isOnline();
    return (Array.isArray(raw) ? raw : [])
      .filter((r) => (!filter?.projectId || r.project_id === filter.projectId)
                  && (!filter?.versionId || r.version_id === filter.versionId))
      .map((record) => {
        const state = deriveLinkState(record, {
          now, online,
          confirmedThisSession: this.confirmed,
          reconcileRequested: this.reconcileRequested,
        });
        return { record, state, group: linkGroupForState(state) };
      });
  }

  /**
   * Request reconciliation for a cached record. No server list endpoint exists
   * yet, so this only marks the record as reconciliation-needed (the UI shows an
   * honest "server reconciliation not yet available" affordance) — it never
   * fabricates a server-confirmed state.
   */
  requestReconcile(trackingId: string): void {
    this.reconcileRequested.add(trackingId);
  }

  /** Whether authoritative server reconciliation is available (contract gap). */
  reconciliationAvailable(): boolean {
    return false; // no `list-project-links` server contract consumed yet
  }

  // ── Account-scoped boundary (P3-2b prep) ─────────────────────────────────
  // These methods are the seam the Codex identity/list contracts wire into.
  // They fail closed today (missing-account-context) and add epoch-based
  // stale-response protection. They perform NO database ownership writes.

  private resolver: AccountContextResolver | null = null;
  private epoch: SessionEpoch = new SessionEpoch();

  /** Attach the account-context resolver + session epoch (one per app session). */
  attachAccountContext(resolver: AccountContextResolver, epoch?: SessionEpoch): void {
    this.resolver = resolver;
    if (epoch) this.epoch = epoch;
  }

  /** Logout hook: bump the epoch (discarding in-flight results) + clear session trust. */
  onLogout(): void {
    this.epoch.bump();
    this.confirmed.clear();
    this.reconcileRequested.clear();
  }

  /** Account-switch hook: identical invalidation; the new account starts clean. */
  onAccountSwitch(): void {
    this.onLogout();
  }

  private resolveContext(): { ok: true; ctx: AuthenticatedAccountContext } | { ok: false; reason: string } {
    const res = this.resolver?.current();
    if (!res || res.kind !== 'available') {
      return { ok: false, reason: res?.reason ?? 'no-resolver-attached' };
    }
    // Defense-in-depth: never accept a token-like value as an account key even
    // if a future resolver misbehaves.
    if (!isAcceptableCanonicalAccountId(res.context.accountId)) {
      return { ok: false, reason: 'rejected-unacceptable-id' };
    }
    return { ok: true, ctx: res.context };
  }

  /**
   * Account-scoped list. Requires an available account context; returns only
   * records attributed to that account (`record.account_id`), which is NONE
   * today — unattributed rows are ownership-unknown and never leak into an
   * account's scoped view. A result resolving under an older epoch (logout or
   * switch happened mid-flight) is reported as stale and must be discarded.
   */
  async listScoped(filter?: { projectId?: string; versionId?: string }): Promise<ScopedListResult> {
    const c = this.resolveContext();
    if (!c.ok) return { kind: 'missing-account-context', reason: c.reason };
    const startEpoch = this.epoch.current();
    const views = await this.list(filter);
    if (!this.epoch.isCurrent(startEpoch)) return { kind: 'stale-epoch' };
    return {
      kind: 'ok',
      views: views.filter((v) => v.record.account_id != null && v.record.account_id === c.ctx.accountId),
      accountId: c.ctx.accountId,
      epoch: startEpoch,
    };
  }

  /**
   * Account-scoped revoke. Verifies LOCAL account attribution before any server
   * call: without context, or for a record not attributed to the active account
   * (including all of today's unattributed/legacy rows), it fails closed and
   * never mutates. The server additionally enforces ownership on its side.
   */
  async revokeScoped(trackingId: string): Promise<ScopedRevokeResult> {
    const c = this.resolveContext();
    if (!c.ok) return { kind: 'missing-account-context', reason: c.reason };
    const startEpoch = this.epoch.current();
    const rows = await this.deps.listLinks().catch(() => [] as LinkRecord[]);
    if (!this.epoch.isCurrent(startEpoch)) return { kind: 'stale-epoch' };
    const record = (Array.isArray(rows) ? rows : []).find((r) => r.tracking_id === trackingId);
    if (!record || record.account_id == null || record.account_id !== c.ctx.accountId) {
      return { kind: 'account-mismatch' };
    }
    const result = await this.revoke(trackingId);
    if (!this.epoch.isCurrent(startEpoch)) return { kind: 'stale-epoch' };
    return result;
  }
}
