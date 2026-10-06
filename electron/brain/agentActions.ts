/**
 * Agent Actions v1 — the model may PROPOSE, never perform.
 *
 * A proposal is a suggestion that must survive deterministic validation before
 * a human ever sees it, and human confirmation before anything happens. The
 * model contributes an intent; everything that decides whether that intent is
 * legitimate, and what it actually refers to, lives in code that can be read
 * and tested.
 *
 * The gates, in order, each in its own module so none can be accidentally
 * skipped by a caller that forgets a step:
 *
 *   1. Schema          actionSchema.ts        — is this even a proposal?
 *   2. Allowlist       here                   — may this be done at all?
 *   3. Arguments       here                   — does the canonical tool accept these?
 *   4. Grounding       here                   — was the model shown these entities?
 *   5. Resolution      actionResolution.ts    — what is the canonical target?
 *   6. Authorization   actionAuthorization.ts — may THIS user do it?
 *   7. Confirmation    proposalStore.ts       — did the user approve THIS proposal?
 *
 * Nothing here executes anything. Execution stays in the existing tool
 * registry, whose envelope already enforces confirmation, sanitises results
 * and audit-logs every invocation.
 *
 * Pure: no I/O, no Electron.
 */
import type { AssistantContext } from './assistantContext';
import { parseActionProposal } from './actionSchema';

export interface AllowedAction {
  /** Name of an EXISTING tool in the copilot registry. */
  tool: string;
  /** Does it change anything the user would care about? */
  mutating: boolean;
  /**
   * Arguments that must be present, named EXACTLY as the canonical tool
   * declares them. A name that disagrees with the real tool produces a
   * proposal that validates here and then fails there, which is the most
   * confusing possible failure — so `agentActionsContract.test.ts` checks
   * every name in this file against the tool's own source.
   */
  required: string[];
  /** Every argument the canonical tool accepts. Anything else is refused. */
  allowed: string[];
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
 * Destructive operations are absent on purpose: nothing here can delete, move,
 * rename, revoke access, invite anyone, run a shell command or touch a DAW,
 * and that is a property of the list, not of the prompt. `invite_collaborator`
 * and `revoke_project_link` both exist in the registry and are deliberately
 * withheld — an agent that can hand out or withdraw access to someone's unreleased
 * music is not a v1.
 */
export const ACTION_ALLOWLIST: Readonly<Record<string, AllowedAction>> = {
  inspect_project: {
    tool: 'inspect_project', mutating: false,
    required: [], allowed: ['projectId'],
    summary: 'Summarise this project',
  },
  list_local_versions: {
    tool: 'list_local_versions', mutating: false,
    required: [], allowed: ['projectId'],
    summary: 'List published versions of this project',
  },
  inspect_daw_compatibility: {
    tool: 'inspect_daw_compatibility', mutating: false,
    required: [], allowed: ['projectId'],
    summary: 'Check DAW compatibility for this project',
  },
  list_project_links: {
    tool: 'list_project_links', mutating: false,
    required: [], allowed: ['projectId', 'versionId'],
    summary: 'List this project’s share links',
  },
  explain_project_errors: {
    tool: 'explain_project_errors', mutating: false,
    required: [], allowed: ['projectId'],
    summary: 'Explain sync errors for this project',
  },
  reveal_file: {
    // The canonical tool takes `fileName`, not an id. Naming it anything else
    // here would mean a proposal that passes every gate and then fails the
    // tool's own input validation.
    tool: 'reveal_file', mutating: false,
    required: ['fileName'], allowed: ['fileName', 'projectId'],
    summary: 'Show a file in Finder',
  },
  // Mutating. Permitted to be PROPOSED, never performed without the existing
  // confirmation flow, which the model has no way to satisfy.
  create_project_link: {
    tool: 'create_project_link', mutating: true,
    required: [], allowed: ['collaboratorMode', 'allowDownload', 'expiresAt', 'projectId'],
    summary: 'Create a share link for this project',
  },
  publish_child_version: {
    tool: 'publish_child_version', mutating: true,
    required: [], allowed: ['note', 'projectId'],
    summary: 'Publish your changes back as a new version',
  },
};

export interface ValidatedAction {
  tool: string;
  params: Record<string, unknown>;
  mutating: boolean;
  /** Always true for mutating actions. Set here, never by the model. */
  requiresConfirmation: boolean;
  summary: string;
  /** The model's stated reason, carried for display only. */
  reason?: string;
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
  const parsed = parseActionProposal(proposal);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const { tool, arguments: params, reason } = parsed.value;

  const entry = ACTION_ALLOWLIST[tool];
  if (!entry) {
    // Not "unknown tool" — not permitted. The distinction matters: the tool
    // may well exist in the registry and still be off-limits to the agent.
    return { ok: false, reason: `"${tool}" is not an action the agent may propose` };
  }

  // An argument the canonical tool does not accept is refused rather than
  // dropped. Dropping would turn "share with downloads off" into "share",
  // executing something the user never asked for.
  const allowed = new Set(entry.allowed);
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `"${tool}" does not accept an argument called "${key}"` };
    }
  }

  for (const req of entry.required) {
    if (params[req] === undefined || norm(params[req]) === '') {
      return { ok: false, reason: `missing required argument "${req}"` };
    }
  }

  // ── Entity grounding ──────────────────────────────────────────────────────
  // Every id the model supplies must be something it was actually shown. This
  // is a check on the MODEL; canonical targets are resolved separately, in
  // actionResolution.ts, from Wavi's own records.
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
      ...(reason ? { reason } : {}),
    },
  };
}

/** Allowlist rendered for the prompt, so the model knows what it may suggest. */
export function describeAllowlistForPrompt(): string {
  const lines = ['Actions you may SUGGEST (you cannot perform them; the user decides):'];
  for (const a of Object.values(ACTION_ALLOWLIST)) {
    const args = a.allowed.filter((x) => x !== 'projectId');
    lines.push(`- ${a.tool}: ${a.summary}${args.length ? ` [arguments: ${args.join(', ')}]` : ''}${a.mutating ? ' (needs the user’s confirmation)' : ''}`);
  }
  lines.push('Name the project by its NAME, never by an id — Wavi resolves the target itself.');
  lines.push('Only name arguments that appear in the context above. Omit "proposedAction" if none applies.');
  return lines.join('\n');
}

/** What gets written to the activity log when a proposal is handled. */
export interface ActionOutcomeRecord {
  tool: string;
  mutating: boolean;
  outcome: 'proposed' | 'rejected' | 'confirmed' | 'cancelled' | 'executed' | 'failed';
  detail?: string;
}

export function describeOutcome(rec: ActionOutcomeRecord): string {
  switch (rec.outcome) {
    case 'proposed': return `Agent suggested: ${rec.tool}`;
    case 'rejected': return `Agent suggestion rejected: ${rec.tool}${rec.detail ? ` — ${rec.detail}` : ''}`;
    case 'confirmed': return `You confirmed: ${rec.tool}`;
    case 'cancelled': return `You cancelled: ${rec.tool}`;
    case 'executed': return `Ran: ${rec.tool}`;
    case 'failed': return `Failed: ${rec.tool}${rec.detail ? ` — ${rec.detail}` : ''}`;
  }
}
