/**
 * Executing a confirmed proposal — through the canonical tool, and nowhere else.
 *
 * There is no second Project Link client here, no HTTP, no SQL, no filesystem
 * call. This module looks up an existing registered tool and invokes it. That
 * is the whole of it, and it is the point: the agent's reach is exactly the
 * set of tools a human can already invoke, with the same envelope performing
 * the same validation, authentication, confirmation and result sanitisation.
 *
 * The other rule enforced here: the authoritative outcome is the tool's. The
 * model's prediction of what would happen is discarded — it was never
 * consulted — and what the user is told comes from the result. A tool that
 * fails is reported as failing, in its own words, however confident the
 * suggestion was.
 *
 * Pure of Electron; the registry lookup, the clock and the recorder are
 * injected so this is directly testable against the real tools.
 */
import type { BoundProposal } from './proposalStore';
import type { ActionOutcomeRecord } from './agentActions';

/** The shape the existing copilot registry already exposes. */
export interface RegisteredTool {
  name: string;
  handler: (
    params: Record<string, unknown>,
    context: unknown,
    opts?: { confirmedOutOfBand?: boolean },
  ) => Promise<{ status?: string; message?: string; error?: string; data?: unknown }>;
}

export interface ExecutionDeps {
  getTool: (name: string) => RegisteredTool | null | undefined;
  /** Project context handed to the tool, carrying the RESOLVED version. */
  buildToolContext: (proposal: BoundProposal) => unknown | Promise<unknown>;
  record: (rec: ActionOutcomeRecord) => void;
  /** The envelope's result sanitiser, injected to avoid an Electron import. */
  sanitize?: (result: any) => any;
}

export type ExecutionOutcome =
  | { ok: true; status: string; message?: string; data?: unknown }
  | { ok: false; error: string };

/**
 * Execute a proposal that has already been consumed from the store.
 *
 * Consumption happens in the caller, before this runs, so a throw cannot leave
 * a mutation re-runnable.
 */
export async function executeConfirmedProposal(
  proposal: BoundProposal,
  deps: ExecutionDeps,
): Promise<ExecutionOutcome> {
  const { action } = proposal;
  const tool = deps.getTool(action.tool);
  if (!tool) {
    deps.record({ tool: action.tool, mutating: action.mutating, outcome: 'failed', detail: 'tool not registered' });
    return { ok: false, error: 'That action is not available right now.' };
  }

  try {
    const raw = await tool.handler(
      action.params,
      await deps.buildToolContext(proposal),
      // Confirmation reached us as a click on a bound proposal id. Mutations
      // only get here having been consumed from the store.
      { confirmedOutOfBand: action.requiresConfirmation === true },
    );
    const result = deps.sanitize ? deps.sanitize(raw) : raw;

    // The tool's verdict is final. A `needs_confirmation` arriving here would
    // mean the envelope disagreed with us about gating, which is a bug worth
    // surfacing rather than papering over with a retry.
    if (result?.status === 'error' || result?.error) {
      deps.record({ tool: action.tool, mutating: action.mutating, outcome: 'failed', detail: result?.error });
      return { ok: false, error: String(result?.error ?? 'That action could not be completed.') };
    }
    deps.record({ tool: action.tool, mutating: action.mutating, outcome: 'executed' });
    return { ok: true, status: String(result?.status ?? 'done'), message: result?.message, data: result?.data };
  } catch (e: any) {
    deps.record({ tool: action.tool, mutating: action.mutating, outcome: 'failed', detail: e?.message });
    return { ok: false, error: 'That action could not be completed.' };
  }
}
