/**
 * Pure view-model for the deterministic assistant tool-result card (P3-3).
 *
 * Kept free of React so it is unit-testable under the Node vitest env. The
 * card renderer (AssistantToolResultCard.tsx) is a thin presentational shell
 * over this model. Never surfaces raw local paths — the electron tools already
 * redact to basenames; this layer only formats.
 */

export interface RawToolResult {
  status: 'done' | 'error' | 'needs_confirmation' | string;
  message?: string;
  error?: string;
  projectId?: string;
  blockedReason?: string;
  data?: unknown;
}

export type CardTone = 'success' | 'error' | 'pending' | 'blocked';

export interface ToolCardModel {
  /** Human action label, e.g. "Inspect project". */
  action: string;
  /** Active project context shown on the card. */
  projectLabel: string;
  tone: CardTone;
  /** Primary body line. */
  body: string;
  /** Present only on failure. */
  failureReason?: string;
  /** Whether a retry affordance should be offered. */
  retryable: boolean;
  /** Honest blocked reason, when the capability is server/impl-blocked. */
  blockedReason?: string;
}

const ACTION_LABELS: Record<string, string> = {
  inspect_project: 'Inspect project',
  search_files: 'Search files',
  reveal_file: 'Reveal file',
  inspect_sync_status: 'Sync status',
  sync_project: 'Retry sync',
  inspect_package_completeness: 'Package completeness',
  inspect_daw_compatibility: 'DAW compatibility',
  list_local_versions: 'Local versions',
  explain_project_errors: 'Explain errors',
  open_in_daw: 'Open in DAW',
  publish_version: 'Publish version',
  list_project_links: 'Project Links',
  create_project_link: 'Create Project Link',
  revoke_project_link: 'Revoke Project Link',
  invite_collaborator: 'Invite collaborator',
  inspect_collaborator_activity: 'Collaborator activity',
  publish_child_version: 'Publish child version',
};

/** Whether the tool's failure is worth offering a retry for (transient/local). */
const NON_RETRYABLE_BLOCKED = new Set(['server_contract_pending', 'unsupported', 'not_implemented']);

export function toToolCardModel(
  toolName: string,
  result: RawToolResult,
  activeProjectName?: string | null,
): ToolCardModel {
  const action = ACTION_LABELS[toolName] ?? toolName;
  const projectLabel = activeProjectName?.trim() || 'No project selected';

  if (result.blockedReason) {
    return {
      action, projectLabel, tone: 'blocked',
      body: result.error ?? 'This action is not available yet.',
      blockedReason: result.blockedReason,
      // A blocked capability that needs a server contract / isn't implemented is
      // not retryable; an auth-required block is (sign in, then retry).
      retryable: !NON_RETRYABLE_BLOCKED.has(result.blockedReason),
    };
  }

  if (result.status === 'needs_confirmation') {
    return { action, projectLabel, tone: 'pending', body: result.message ?? 'Awaiting your confirmation.', retryable: false };
  }

  if (result.status === 'error') {
    return {
      action, projectLabel, tone: 'error',
      body: result.error ?? 'Something went wrong.',
      failureReason: result.error ?? 'Unknown error',
      retryable: true,
    };
  }

  return { action, projectLabel, tone: 'success', body: result.message ?? 'Done.', retryable: false };
}

/**
 * Guard for the renderer: a result whose `projectId` no longer matches the
 * active project must be discarded rather than shown (stale project switch).
 * Results without a projectId (project-agnostic tools like search) are kept.
 */
export function isStaleForProject(result: RawToolResult, activeProjectId: string | null): boolean {
  if (!result.projectId) return false;
  if (!activeProjectId) return true;
  return result.projectId !== activeProjectId;
}
