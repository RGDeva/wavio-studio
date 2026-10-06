/**
 * Agent Actions v1 — the model may PROPOSE, never perform.
 *
 * A proposal is a suggestion that must survive deterministic validation before
 * a human ever sees it, and human confirmation before anything happens. The
 * model contributes a name and some arguments; everything that decides whether
 * those are legitimate lives here, in code that can be read and tested.
 *
 * Three gates, in order:
 *
 *  1. **Allowlist.** Only existing Studio tools, named explicitly. A tool that
 *     is not on this list cannot be proposed at all — so the agent can never
 *     reach a capability simply because one was added elsewhere in the app.
 *  2. **Entity grounding.** Every id and filename in the arguments must appear
 *     in the context the model was shown. This is what stops it acting on a
 *     project it inferred, half-remembered, or invented.
 *  3. **Confirmation.** Mutating actions are marked, and execution runs through
 *     the existing out-of-band confirmation path — the model cannot set that
 *     flag, because it never reaches the model's output at all.
 *
 * Nothing here executes anything. Execution stays in the existing tool
 * registry, which already audit-logs every invocation.
 *
 * Pure: no I/O, no Electron.
 */
import type { AssistantContext } from './assistantContext';

export interface AllowedAction {
  /** Name of an EXISTING tool in the copilot registry. */
  tool: string;
  /** Does it change anything the user would care about? */
  mutating: boolean;
  /** Arguments that must be present. */
  required: string[];
  /** Plain description used on the confirmation card. */
  summary: string;
}

/**
 * The allowlist.
 *
 * Deliberately small. Every entry is a tool that already exists and already
 * has its own safety behaviour; this adds no capability, it only lets the
 * agent point at one. Read-only entries are the useful default — a suggestion
 * to *look* at something costs the user nothing if it is wrong.
 *
 * Destructive operations are absent on purpose: nothing here can delete, move
 * or rename a file, and that is a property of the list, not of the prompt.
 */
export const ACTION_ALLOWLIST: Readonly<Record<string, AllowedAction>> = {
  inspect_project: {
    tool: 'inspect_project', mutating: false, required: [],
    summary: 'Summarise this project',
  },
  list_local_versions: {
    tool: 'list_local_versions', mutating: false, required: [],
    summary: 'List published versions of this project',
  },
  inspect_daw_compatibility: {
    tool: 'inspect_daw_compatibility', mutating: false, required: [],
    summary: 'Check DAW compatibility for this project',
  },
  list_project_links: {
    tool: 'list_project_links', mutating: false, required: [],
    summary: 'List this project’s share links',
  },
  explain_project_errors: {
    tool: 'explain_project_errors', mutating: false, required: [],
    summary: 'Explain sync errors for this project',
  },
  reveal_file: {
    tool: 'reveal_file', mutating: false, required: ['fileId'],
    summary: 'Show a file in Finder',
  },
  // Mutating. Permitted to be PROPOSED, never performed without the existing
  // confirmation flow, which the model has no way to satisfy.
  create_project_link: {
    tool: 'create_project_link', mutating: true, required: [],
    summary: 'Create a share link for this project',
  },
  publish_child_version: {
    tool: 'publish_child_version', mutating: true, required: [],
    summary: 'Publish your changes back as a new version',
  },
};

export interface ProposedAction {
  tool: string;
  params: Record<string, unknown>;
}

export interface ValidatedAction {
  tool: string;
  params: Record<string, unknown>;
  mutating: boolean;
  /** Always true for mutating actions. Set here, never by the model. */
  requiresConfirmation: boolean;
  summary: string;
}

export type ActionValidation =
  | { ok: true; action: ValidatedAction }
  | { ok: false; reason: string };

/** Params that name a project, which must match the context's project. */
const PROJECT_PARAMS = new Set(['projectid', 'project_id']);
/** Params that name a file, which must match a file in the context. */
const FILE_PARAMS = new Set(['fileid', 'file_id', 'filename', 'file_name']);

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * Validate a proposal against the allowlist and the context it came from.
 *
 * Rejects rather than repairs. A proposal that is almost right is still a
 * proposal the model got wrong, and silently fixing its arguments would hide
 * exactly the failure mode this is here to catch.
 */
export function validateProposedAction(
  proposal: unknown,
  ctx: AssistantContext,
): ActionValidation {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { ok: false, reason: 'proposed action is not an object' };
  }
  const p = proposal as Record<string, unknown>;

  if (typeof p.tool !== 'string' || !p.tool.trim()) {
    return { ok: false, reason: 'proposed action has no tool name' };
  }
  const entry = ACTION_ALLOWLIST[p.tool.trim()];
  if (!entry) {
    // Not "unknown tool" — not permitted. The distinction matters: the tool
    // may well exist in the registry and still be off-limits to the agent.
    return { ok: false, reason: `"${p.tool}" is not an action the agent may propose` };
  }

  let params: Record<string, unknown> = {};
  if (p.params !== undefined) {
    if (!p.params || typeof p.params !== 'object' || Array.isArray(p.params)) {
      return { ok: false, reason: 'proposed action params must be an object' };
    }
    params = p.params as Record<string, unknown>;
  }

  for (const req of entry.required) {
    if (params[req] === undefined || norm(params[req]) === '') {
      return { ok: false, reason: `missing required argument "${req}"` };
    }
  }

  // ── Entity grounding ──────────────────────────────────────────────────────
  // Every id the model supplies must be something it was actually shown.
  const contextProjectId = ctx.project?.id ? norm(ctx.project.id) : null;
  const fileIds = new Set(ctx.files.map((f) => norm(f.id)));
  const fileNames = new Set(ctx.files.map((f) => norm(f.name)));

  for (const [key, value] of Object.entries(params)) {
    const k = key.toLowerCase();
    if (PROJECT_PARAMS.has(k)) {
      if (!contextProjectId) {
        return { ok: false, reason: 'the action names a project, but no project is in context' };
      }
      if (norm(value) !== contextProjectId) {
        // The model pointed at a project it was not shown — the single most
        // dangerous shape a proposal can take.
        return { ok: false, reason: 'the action names a project that is not the one in context' };
      }
    }
    if (FILE_PARAMS.has(k)) {
      const v = norm(value);
      if (!fileIds.has(v) && !fileNames.has(v)) {
        return { ok: false, reason: `the action names a file that is not in context: "${String(value)}"` };
      }
    }
  }

  return {
    ok: true,
    action: {
      tool: entry.tool,
      params,
      mutating: entry.mutating,
      // Set from the allowlist, never from the proposal. A model that emitted
      // requiresConfirmation:false would have no effect whatsoever.
      requiresConfirmation: entry.mutating,
      summary: entry.summary,
    },
  };
}

/** Allowlist rendered for the prompt, so the model knows what it may suggest. */
export function describeAllowlistForPrompt(): string {
  const lines = ['Actions you may SUGGEST (you cannot perform them; the user decides):'];
  for (const a of Object.values(ACTION_ALLOWLIST)) {
    lines.push(`- ${a.tool}: ${a.summary}${a.mutating ? ' (needs the user’s confirmation)' : ''}`);
  }
  lines.push('Only name arguments that appear in the context above. Omit "proposedAction" if none applies.');
  return lines.join('\n');
}

/** What gets written to the activity log when a proposal is handled. */
export interface ActionOutcomeRecord {
  tool: string;
  mutating: boolean;
  outcome: 'proposed' | 'rejected' | 'confirmed' | 'executed' | 'failed';
  detail?: string;
}

export function describeOutcome(rec: ActionOutcomeRecord): string {
  switch (rec.outcome) {
    case 'proposed': return `Agent suggested: ${rec.tool}`;
    case 'rejected': return `Agent suggestion rejected: ${rec.tool}${rec.detail ? ` — ${rec.detail}` : ''}`;
    case 'confirmed': return `You confirmed: ${rec.tool}`;
    case 'executed': return `Ran: ${rec.tool}`;
    case 'failed': return `Failed: ${rec.tool}${rec.detail ? ` — ${rec.detail}` : ''}`;
  }
}
