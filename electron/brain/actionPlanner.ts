/**
 * The action pipeline, composed: request → plan.
 *
 * Every gate lives in its own module; this is the single place that runs them
 * in order, so there is one path to read and one path to test. A caller cannot
 * reach execution by assembling the pieces differently, because what comes out
 * of here is a PLAN — inert data — and only a confirmed, bound plan can be
 * executed by main.
 *
 * Two properties worth stating plainly:
 *
 *   - A canonical id in the plan was produced HERE, by lookup against Wavi's
 *     own records. Any id the model offered has already been discarded. The
 *     model's contribution is the verb and the adjectives.
 *   - Ambiguity never resolves to a mutation. "Which Sunshine?" is a better
 *     outcome than sharing the wrong song.
 *
 * Pure: no I/O, no Electron.
 */
import type { AssistantContext } from './assistantContext';
import { validateProposedAction, ACTION_ALLOWLIST, type ValidatedAction } from './agentActions';
import { detectUnsupportedIntent, type UnsupportedIntent } from './actionIntent';
import {
  resolveProjectTarget, resolveLatestVersion, describeProjectCandidates,
  type ProjectCandidate, type VersionCandidate, type ClarificationOption,
} from './actionResolution';
import { authorizeAction, type ProjectAuthorization } from './actionAuthorization';

export interface PlanInput {
  /** What the user actually asked. */
  question: string;
  /** The bounded context the model was shown. */
  context: AssistantContext;
  /** The model's raw proposal, if it made one. Untrusted. */
  modelProposal?: unknown;
  /** Projects Wavi has indexed — the only source of a project id. */
  projects?: ProjectCandidate[];
  /** Versions of the resolved project, for "the newest one". */
  versions?: VersionCandidate[];
  /** This user's recorded access to the resolved project. */
  authorization?: ProjectAuthorization | null;
}

export type ActionPlan =
  /** Will not act, and says so plainly. */
  | { kind: 'refused'; category: UnsupportedIntent['category']; message: string }
  /** Needs the user to pick a target before anything is proposed. */
  | { kind: 'clarify'; message: string; options: ClarificationOption[] }
  /** The model proposed something that did not survive a gate. */
  | { kind: 'rejected'; tool: string; reason: string }
  /** Nothing to propose — a perfectly normal outcome for a question. */
  | { kind: 'none' }
  /** A validated, resolved, authorized plan awaiting confirmation. */
  | {
      kind: 'proposal';
      action: ValidatedAction;
      /** Canonical project id, resolved here. */
      projectId: string;
      projectName: string;
      /** Canonical version id when one was resolved. */
      versionId: string | null;
      versionLabel: string | null;
      /** The sentence the user is asked to approve. */
      summary: string;
      requiresConfirmation: boolean;
    };

/** Tools whose target version matters, so it is resolved before proposing. */
const VERSION_SENSITIVE = new Set(['create_project_link']);

function describeLinkSummary(
  projectName: string, versionLabel: string | null, params: Record<string, unknown>,
): string {
  const mode = typeof params.collaboratorMode === 'string' && params.collaboratorMode.trim()
    ? params.collaboratorMode.trim() : 'view';
  const dl = params.allowDownload === false ? 'downloads off' : 'downloads on';
  const exp = typeof params.expiresAt === 'string' && params.expiresAt
    ? `, expires ${params.expiresAt}` : '';
  return `Create a Project Link for ${projectName}${versionLabel ? ` ${versionLabel}` : ''} — ${mode} access, ${dl}${exp}. Anyone with the link can open it.`;
}

function summarise(
  action: ValidatedAction, projectName: string, versionLabel: string | null,
): string {
  if (action.tool === 'create_project_link') {
    return describeLinkSummary(projectName, versionLabel, action.params);
  }
  if (action.tool === 'publish_child_version') {
    const note = typeof action.params.note === 'string' && action.params.note.trim()
      ? ` Note: “${action.params.note.trim()}”.` : '';
    return `Send your changes to ${projectName} back to the owner as a new version.${note}`;
  }
  return `${ACTION_ALLOWLIST[action.tool]?.summary ?? action.tool} — ${projectName}`;
}

/**
 * Run the pipeline.
 *
 * Order is deliberate: refuse before proposing, validate before resolving,
 * resolve before authorizing, authorize before summarising. Each step can only
 * narrow what the previous one allowed.
 */
export function planAgentAction(input: PlanInput): ActionPlan {
  // 1. Requests the agent will not act on. A plain refusal is more useful than
  //    an unrelated suggestion, and it is recorded as a refusal.
  const unsupported = detectUnsupportedIntent(input.question);
  if (unsupported) {
    return { kind: 'refused', category: unsupported.category, message: unsupported.message };
  }

  if (input.modelProposal === undefined || input.modelProposal === null) return { kind: 'none' };

  // 2–4. Schema, allowlist, argument names, entity grounding.
  const v = validateProposedAction(input.modelProposal, input.context);
  if (!v.ok) {
    const tool = (input.modelProposal as { tool?: unknown })?.tool;
    return { kind: 'rejected', tool: typeof tool === 'string' ? tool : '(unnamed)', reason: v.reason };
  }
  const action = v.action;

  // 5. Deterministic target resolution. The context's project is already a
  //    resolved canonical target — the user selected it — so it wins. Only
  //    when there is none do we read a name out of the request.
  let projectId: string;
  let projectName: string;
  if (input.context.project?.id) {
    projectId = input.context.project.id;
    projectName = input.context.project.name ?? 'this project';
  } else {
    const candidates = input.projects ?? [];
    const resolved = resolveProjectTarget(input.question, candidates);
    if (resolved.kind === 'ambiguous') {
      return {
        kind: 'clarify',
        message: 'More than one project matches that. Which one did you mean?',
        options: describeProjectCandidates(resolved.candidates),
      };
    }
    if (resolved.kind === 'none') {
      return {
        kind: 'rejected', tool: action.tool,
        reason: 'Wavi could not work out which project you meant, so it did not act.',
      };
    }
    projectId = resolved.project.id;
    projectName = resolved.project.name;
  }

  let versionId: string | null = null;
  let versionLabel: string | null = null;
  if (VERSION_SENSITIVE.has(action.tool)) {
    const versions = input.versions ?? [];
    if (versions.length) {
      const latest = resolveLatestVersion(versions);
      if (latest.kind === 'ambiguous') {
        return {
          kind: 'clarify',
          message: `Wavi’s records show more than one version of ${projectName} as the newest, so it will not guess which to share.`,
          options: latest.candidates.map((c, i) => ({ ref: `cand_${i + 1}`, label: `v${c.versionNumber}` })),
        };
      }
      if (latest.kind === 'resolved') {
        versionId = latest.version.id;
        versionLabel = `v${latest.version.versionNumber}`;
      }
    }
    // No published version at all is not an error here: the canonical tool
    // describes that case itself, and duplicating its judgement would mean two
    // places deciding what "shareable" means.
  }

  // 6. Authorization, from Wavi's records — a model cannot create permission.
  const authz = authorizeAction(action.tool, input.authorization ?? null, action.mutating);
  if (!authz.ok) return { kind: 'rejected', tool: action.tool, reason: authz.reason };

  // The resolved id REPLACES whatever the model supplied.
  const resolvedAction: ValidatedAction = {
    ...action,
    params: { ...action.params, projectId },
  };

  return {
    kind: 'proposal',
    action: resolvedAction,
    projectId,
    projectName,
    versionId,
    versionLabel,
    summary: summarise(resolvedAction, projectName, versionLabel),
    requiresConfirmation: resolvedAction.requiresConfirmation,
  };
}

/**
 * Recognise a share request without a model.
 *
 * Not an attempt at understanding language: a narrow pattern for the one
 * request common enough to be worth handling when no local model is
 * configured, so the action path is not a privilege of users who installed
 * one. Everything downstream — resolution, authorization, confirmation — is
 * identical, because this only produces a proposal, exactly like a model does.
 *
 * Returns null whenever it is not confident, which is most of the time.
 */
export function inferProposalFromRequest(question: string): { tool: string; arguments: Record<string, unknown> } | null {
  const q = String(question ?? '').toLowerCase();
  const wantsLink = /\b(share|send)\b/.test(q) || /\b(make|create|generate|get)\b[^.]{0,30}\b(link|share link|project link)\b/.test(q);
  if (!wantsLink) return null;
  // "What links exist" is a question, not a request to create one.
  if (/\b(list|show|what|which|existing|already)\b/.test(q)) return null;

  const args: Record<string, unknown> = {};
  if (/\b(no|without|don'?t allow|disable|off)\b[^.]{0,20}\bdownload/.test(q)
      || /\bdownloads?\s+(off|disabled)\b/.test(q)) {
    args.allowDownload = false;
  } else if (/\b(allow|with|enable)\b[^.]{0,20}\bdownload/.test(q) || /\bdownloads?\s+(on|enabled)\b/.test(q)) {
    args.allowDownload = true;
  }
  if (/\bcomment\b/.test(q)) args.collaboratorMode = 'comment';
  return { tool: 'create_project_link', arguments: args };
}
