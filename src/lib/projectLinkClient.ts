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
}
