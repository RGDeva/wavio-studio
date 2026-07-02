/**
 * Copilot tool envelope (Phase H — docs/WAVI_COPILOT_TOOL_ARCHITECTURE.md).
 *
 * Every project tool runs inside this envelope, which enforces — in the
 * handler itself, so no caller can bypass it:
 *   1. typed input validation (lightweight, no new deps)
 *   2. permission checks (auth for cloud tools)
 *   3. confirmation gating: a gated tool returns needs_confirmation until the
 *      RENDERER re-invokes with confirmed:true — the model cannot self-confirm
 *      because the confirmation card is native UI, not model output
 *   4. audit logging of every invocation (sanitized args, never file contents
 *      or tokens)
 *   5. failure containment: tools return { status:'error' }, never throw
 *
 * Pure module (no electron/db imports): implementations arrive via deps
 * injection so vitest exercises the real envelope with fakes.
 */

export interface CopilotToolResult {
  status: 'done' | 'error' | 'needs_confirmation';
  message?: string;
  error?: string;
  data?: unknown;
  filePath?: string;
  /** For needs_confirmation: what the renderer should show on the card. */
  confirmationSummary?: string;
}

export interface FieldSpec {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
}

export interface EnvelopeDeps {
  /** True when a signed-in session exists (cloud tools require it). */
  isAuthenticated: () => boolean;
  /** Writes the audit row (wired to activity_log in main; fake in tests). */
  logAudit: (entry: { tool: string; params: Record<string, unknown>; outcome: string }) => void;
}

export interface CopilotToolSpec {
  name: string;
  description: string;
  parameters: Record<string, FieldSpec>;
  /** 'local' tools work fully offline; 'cloud' tools need auth + network. */
  execution: 'local' | 'cloud';
  requiresConfirmation?: boolean;
  /** Builds the confirmation-card text when gated. */
  confirmationSummary?: (params: Record<string, unknown>, ctx: unknown) => string;
  run: (params: Record<string, unknown>, ctx: unknown) => Promise<CopilotToolResult>;
}

/** Only primitives, truncated — never file contents, paths kept short, no tokens. */
export function sanitizeArgs(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (/token|secret|password|auth/i.test(k)) continue;
    if (typeof v === 'string') out[k] = v.length > 120 ? v.slice(0, 120) + '…' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    // objects/arrays dropped — audit metadata stays small and safe
  }
  return out;
}

export function validateParams(
  spec: Record<string, FieldSpec>,
  params: Record<string, unknown>,
): string | null {
  for (const [name, field] of Object.entries(spec)) {
    const value = params[name];
    if (value === undefined || value === null) {
      if (field.required !== false) return `Missing required parameter "${name}".`;
      continue;
    }
    if (typeof value !== field.type) return `Parameter "${name}" must be a ${field.type}.`;
  }
  return null;
}

/**
 * Wraps a tool spec into a handler with the full envelope applied.
 * The returned handler NEVER throws.
 */
export function wrapTool(spec: CopilotToolSpec, deps: EnvelopeDeps) {
  return async (rawParams: Record<string, unknown>, ctx: unknown): Promise<CopilotToolResult> => {
    const params = rawParams ?? {};
    const audit = (outcome: string) =>
      deps.logAudit({ tool: spec.name, params: sanitizeArgs(params), outcome });

    try {
      // 1. Validation
      const validationError = validateParams(spec.parameters, params);
      if (validationError) {
        audit('invalid_input');
        return { status: 'error', error: `Invalid input: ${validationError}` };
      }

      // 2. Permission — cloud tools need a signed-in session
      if (spec.execution === 'cloud' && !deps.isAuthenticated()) {
        audit('denied_unauthenticated');
        return { status: 'error', error: 'Sign in to Wavi to use this action. Local search and sync inspection still work offline.' };
      }

      // 3. Confirmation gate — enforced HERE so no caller can skip it
      if (spec.requiresConfirmation && params.confirmed !== true) {
        audit('confirmation_requested');
        return {
          status: 'needs_confirmation',
          confirmationSummary: spec.confirmationSummary?.(params, ctx) ?? `Confirm: ${spec.name}`,
          message: 'This action needs your confirmation in the Copilot panel before it runs.',
        };
      }

      // 4. Execute with failure containment
      const result = await spec.run(params, ctx);
      audit(result.status);
      return result;
    } catch (e) {
      audit('threw');
      return { status: 'error', error: (e as Error)?.message ?? 'Unknown error' };
    }
  };
}
