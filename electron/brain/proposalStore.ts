/**
 * Proposal binding — confirmation applies to one exact proposal.
 *
 * The hazard this closes is specific. If confirming means "run this tool with
 * these arguments", then the arguments travel to the renderer and back, and a
 * user who approved "share with downloads OFF" can have "downloads ON"
 * executed in their name — by a bug, a re-render, or a tampered message. The
 * approval and the thing approved must be the same object.
 *
 * So the validated proposal never leaves the main process. The renderer gets
 * an opaque id and a sentence; confirming sends the id back and nothing else.
 * There is no argument channel to tamper with, because the arguments were
 * never handed out.
 *
 * Consuming is single-use, which is also the idempotency story: a double
 * click, a duplicated IPC message or a retried confirmation finds the proposal
 * already spent and does nothing. One approval, one execution, enforced by the
 * store rather than by the caller remembering to check. No new idempotency key
 * is minted for the server — the canonical tool's own semantics stay in
 * charge of what reaches it.
 *
 * Pure: no I/O, no Electron. The clock and the id generator are injected.
 */
import type { ValidatedAction } from './agentActions';

export interface BoundProposal {
  id: string;
  action: ValidatedAction;
  /** Canonical project this was resolved against. Never sent to a model. */
  projectId: string | null;
  /**
   * Canonical version this was resolved against, when the action depends on
   * one. Carried here so execution shares exactly the version the user
   * approved, instead of the tool re-deriving "latest" after the fact.
   */
  versionId?: string | null;
  /** The sentence shown on the confirmation card. */
  summary: string;
  createdAt: string;
  expiresAt: string;
}

export type ConsumeResult =
  | { ok: true; proposal: BoundProposal }
  | { ok: false; reason: 'unknown' | 'expired' | 'already-used' };

export interface ProposalStoreDeps {
  now: () => Date;
  newId: () => string;
  /**
   * How long a proposal stays confirmable. A stale card is a real risk: the
   * project may have changed under it, so it is better to expire and re-ask
   * than to act on an answer to a question the user no longer remembers.
   */
  ttlMs?: number;
  /** Bound on retained proposals, so an unused card cannot accumulate. */
  maxRetained?: number;
}

export const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface ProposalStore {
  mint: (action: ValidatedAction, opts: { projectId: string | null; summary: string; versionId?: string | null }) => BoundProposal;
  consume: (id: string) => ConsumeResult;
  /** Discard without executing — what Cancel does. */
  discard: (id: string) => boolean;
  pendingCount: () => number;
}

export function createProposalStore(deps: ProposalStoreDeps): ProposalStore {
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const max = deps.maxRetained ?? 32;
  const live = new Map<string, BoundProposal>();
  /** Ids already executed, kept so a retry is distinguishable from a typo. */
  const spent = new Set<string>();

  const prune = (nowMs: number) => {
    for (const [id, p] of live) {
      if (Date.parse(p.expiresAt) <= nowMs) live.delete(id);
    }
    while (live.size > max) {
      const oldest = live.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      live.delete(oldest);
    }
  };

  return {
    mint(action, opts) {
      const now = deps.now();
      prune(now.getTime());
      const proposal: BoundProposal = {
        id: deps.newId(),
        action,
        projectId: opts.projectId,
        versionId: opts.versionId ?? null,
        summary: opts.summary,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl).toISOString(),
      };
      live.set(proposal.id, proposal);
      return proposal;
    },

    consume(id) {
      const key = String(id ?? '');
      const found = live.get(key);
      if (!found) {
        // Distinguishing a spent id from an unknown one is what makes a double
        // confirmation safe AND explicable, rather than merely silent.
        return { ok: false, reason: spent.has(key) ? 'already-used' : 'unknown' };
      }
      if (Date.parse(found.expiresAt) <= deps.now().getTime()) {
        live.delete(key);
        return { ok: false, reason: 'expired' };
      }
      // Removed BEFORE the caller executes: if execution throws, the proposal
      // is still spent. Re-running a mutation whose outcome is unknown is the
      // worse failure.
      live.delete(key);
      spent.add(key);
      return { ok: true, proposal: found };
    },

    discard(id) {
      return live.delete(String(id ?? ''));
    },

    pendingCount() {
      prune(deps.now().getTime());
      return live.size;
    },
  };
}
