/**
 * Authenticated account context boundary (P3-2b prep).
 *
 * The desktop has NO stable canonical account identifier today (see
 * WAVI_PROJECT_LINKS_DESKTOP_AUDIT.md, P3-2b section) — Codex is implementing
 * the identity + listing contracts in the web repo. This module is the seam
 * those contracts will plug into, so no second refactor is needed:
 *
 *  - `AuthenticatedAccountContext` — what a canonical identity looks like here.
 *  - `AccountContextResolver` — the single place the real ID will be supplied.
 *  - `missing-account-context` — the typed, fail-closed result every
 *    cache-sensitive operation returns until the contract lands.
 *  - session epoch — monotonic counter bumped on logout/account switch; any
 *    async result carrying an older epoch is discarded (stale-response guard).
 *
 * Nothing here writes ownership to the database, invents an ID, or fakes a
 * server response.
 */

export interface AuthenticatedAccountContext {
  /**
   * Canonical backend-owned principal id (user/account UUID). Never an email,
   * username, token substring/hash, device id, or filesystem value —
   * `isAcceptableCanonicalAccountId` enforces this at the boundary.
   */
  accountId: string;
  /** Session epoch the context was resolved under (see SessionEpoch). */
  epoch: number;
}

export type AccountContextResult =
  | { kind: 'available'; context: AuthenticatedAccountContext }
  | { kind: 'missing-account-context'; reason: 'no-identity-contract' | 'logged-out' | 'rejected-unacceptable-id' };

/** The one interface the Codex identity contract will be wired into. */
export interface AccountContextResolver {
  current(): AccountContextResult;
}

const EMAIL_RE = /@/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Shapes we must refuse as account keys: desktop tokens, JWTs, long opaque
// secrets, emails, filesystem paths. A canonical id is expected to be a UUID
// (or similar short backend id) — fail closed on anything token-like.
export function isAcceptableCanonicalAccountId(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  if (value.startsWith('wv_')) return false;            // desktop auth token
  if (value.split('.').length === 3 && value.length > 60) return false; // JWT shape
  if (EMAIL_RE.test(value)) return false;               // email
  if (value.includes('/') || value.includes('\\')) return false; // path
  if (value.length > 64) return false;                  // opaque secret / hash
  return UUID_RE.test(value) || /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

/**
 * Monotonic session epoch. Logout and account switch bump it; any in-flight
 * async result tagged with an older epoch must be discarded by the caller
 * (see ProjectLinkClient.listScoped). Pure and injectable for tests.
 */
export class SessionEpoch {
  private n = 0;
  current(): number { return this.n; }
  bump(): number { return ++this.n; }
  isCurrent(epoch: number): boolean { return epoch === this.n; }
}

/**
 * Default resolver for TODAY's reality: no identity contract exists, so it
 * always reports `missing-account-context` — cache-sensitive operations fail
 * closed instead of guessing. When Codex lands the contract, `supply()` is
 * called with the canonical id (validated), and the same resolver starts
 * returning `available` — no call-site changes needed.
 */
export class PendingContractAccountResolver implements AccountContextResolver {
  private accountId: string | null = null;
  private loggedOut = false;

  constructor(private epoch: SessionEpoch = new SessionEpoch()) {}

  /** Wire-up point for the future identity contract. Rejects unacceptable ids. */
  supply(accountId: string): AccountContextResult {
    if (!isAcceptableCanonicalAccountId(accountId)) {
      this.accountId = null;
      return { kind: 'missing-account-context', reason: 'rejected-unacceptable-id' };
    }
    this.accountId = accountId;
    this.loggedOut = false;
    return this.current();
  }

  /** Logout hook: drops identity and invalidates all in-flight epochs. */
  onLogout(): void {
    this.accountId = null;
    this.loggedOut = true;
    this.epoch.bump();
  }

  /** Account-switch hook: invalidates epochs; new identity must be re-supplied. */
  onAccountSwitch(): void {
    this.accountId = null;
    this.epoch.bump();
  }

  sessionEpoch(): SessionEpoch { return this.epoch; }

  current(): AccountContextResult {
    if (this.accountId === null) {
      return { kind: 'missing-account-context', reason: this.loggedOut ? 'logged-out' : 'no-identity-contract' };
    }
    return { kind: 'available', context: { accountId: this.accountId, epoch: this.epoch.current() } };
  }
}
