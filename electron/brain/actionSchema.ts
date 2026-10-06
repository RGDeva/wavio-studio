/**
 * The strict wire schema for an action a model proposes.
 *
 * Why a schema at all, when the allowlist already rejects unknown tools: the
 * allowlist answers "may this be done?", and this answers "is this even a
 * proposal?". Keeping them apart means a garbled envelope is rejected before
 * any allowlist, resolution or permission logic ever sees it, and the reasons
 * reported to the log stay specific enough to debug.
 *
 * There is no `[TOOL:…]` prose parsing anywhere in this path, and prose is
 * never scanned for instructions. A proposal is structured data or it is
 * nothing.
 *
 * Fail closed on anything unrecognised — with ONE narrow exception, below.
 *
 * Pure: no I/O.
 */

export interface ActionProposalV1 {
  tool: string;
  version: 1;
  arguments: Record<string, unknown>;
  /** The model's stated reason. Displayed, never acted upon. */
  reason?: string;
  /** Context ids the model says support this. Displayed, never acted upon. */
  evidence?: string[];
}

export type SchemaRejection =
  | 'not-an-object' | 'no-tool' | 'bad-version'
  | 'bad-arguments' | 'unknown-field' | 'bad-reason' | 'bad-evidence';

export type SchemaResult =
  | { ok: true; value: ActionProposalV1 }
  | { ok: false; code: SchemaRejection; reason: string };

/** Envelope fields this schema understands. */
const KNOWN = new Set(['tool', 'version', 'arguments', 'params', 'reason', 'evidence']);

/**
 * Fields a model may emit that are deliberately IGNORED rather than rejected.
 *
 * This follows the convention the tool envelope already established for
 * `confirmed`: a model asserting its own action is safe is not a malformed
 * proposal, it is an attempt that must simply have no effect. Stripping is
 * both the established behaviour and the more robust one — rejecting would let
 * a model deny itself service by adding a field, while stripping means the
 * assertion is read by nobody. Authority for all three lives in the allowlist.
 */
const IGNORED = new Set(['requiresConfirmation', 'mutating', 'confirmed']);

/**
 * Parse a proposal envelope.
 *
 * `arguments` is canonical; `params` is accepted as the alias already present
 * in the structured response contract. Supplying both is a contradiction and
 * is refused rather than silently resolved in one direction.
 */
export function parseActionProposal(input: unknown): SchemaResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'not-an-object', reason: 'proposed action is not an object' };
  }
  const o = input as Record<string, unknown>;

  for (const key of Object.keys(o)) {
    if (KNOWN.has(key) || IGNORED.has(key)) continue;
    // An unrecognised field may carry an argument we would otherwise drop
    // silently — including a destructive one. Refuse the whole proposal.
    return { ok: false, code: 'unknown-field', reason: `proposed action has an unsupported field "${key}"` };
  }

  if (typeof o.tool !== 'string' || !o.tool.trim()) {
    return { ok: false, code: 'no-tool', reason: 'proposed action has no tool name' };
  }

  // Version is optional on the wire (small models omit it constantly) but may
  // not be WRONG: a proposal claiming v2 was written against a contract this
  // code does not implement.
  if (o.version !== undefined && o.version !== 1) {
    return { ok: false, code: 'bad-version', reason: `unsupported proposal version ${String(o.version)}` };
  }

  if (o.arguments !== undefined && o.params !== undefined) {
    return { ok: false, code: 'bad-arguments', reason: 'proposed action sets both "arguments" and "params"' };
  }
  const rawArgs = o.arguments !== undefined ? o.arguments : o.params;
  let args: Record<string, unknown> = {};
  if (rawArgs !== undefined) {
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return { ok: false, code: 'bad-arguments', reason: 'proposed action arguments must be an object' };
    }
    args = { ...(rawArgs as Record<string, unknown>) };
    // Same strip rule one level down: a model that moves its self-granted
    // confirmation into the arguments has achieved nothing.
    for (const k of IGNORED) delete args[k];
  }

  if (o.reason !== undefined && typeof o.reason !== 'string') {
    return { ok: false, code: 'bad-reason', reason: 'proposed action reason must be a string' };
  }
  let evidence: string[] | undefined;
  if (o.evidence !== undefined) {
    if (!Array.isArray(o.evidence) || !o.evidence.every((e) => typeof e === 'string')) {
      return { ok: false, code: 'bad-evidence', reason: 'proposed action evidence must be strings' };
    }
    evidence = o.evidence.map((e) => e.trim()).filter(Boolean);
  }

  return {
    ok: true,
    value: {
      tool: o.tool.trim(),
      version: 1,
      arguments: args,
      ...(typeof o.reason === 'string' && o.reason.trim() ? { reason: o.reason.trim() } : {}),
      ...(evidence && evidence.length ? { evidence } : {}),
    },
  };
}
