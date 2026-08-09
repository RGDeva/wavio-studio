/**
 * Deterministic, server-independent Copilot inspection tools (P3-3).
 *
 * Pure derivations + tool specs for the read-only inspection surface. Every
 * function here is synchronous and total — no network, no fabricated server
 * state. The electron entry (main.ts) injects the real db/shell/adapter deps;
 * vitest exercises the specs with fakes.
 *
 * Two invariants enforced across every tool:
 *   1. EXPLICIT project context. A tool resolves the project it acts on from
 *      the injected context AND an optional caller-supplied `projectId`. If the
 *      two disagree (the user switched projects between the model deciding and
 *      the tool running), the result is `stale_project_switch` and is discarded
 *      — a tool never silently acts on the last unrelated project.
 *   2. NO raw local absolute paths in model-visible messages/data. Paths are
 *      reduced to their basename via `redactPath`; the real filesystem action
 *      (reveal/open) runs in the main process with the full path it already
 *      holds.
 */
import type { ProjectContext, ProjectFile } from '../copilotTypes';
import type { CopilotToolSpec, CopilotToolResult, EnvelopeDeps } from './envelope';
import type { AssistantSafeLink } from '../assistantLinkRefs';

// ── Project-context resolution (explicit + stale-switch safe) ────────────────

export type ProjectContextResolution =
  | { ok: true; projectId: string; projectName: string; dawType: string | null; files: ProjectFile[]; versionCount: number }
  | { ok: false; reason: 'no_project_selected' | 'stale_project_switch' };

/**
 * Resolve the project a tool must act on. `requestedProjectId` is what the
 * caller (model/renderer) targeted; `ctx.projectId` is what the main process
 * resolved as active *now*. A mismatch means a switch happened mid-flight.
 */
export function resolveToolProjectContext(
  ctx: ProjectContext | null,
  requestedProjectId?: unknown,
): ProjectContextResolution {
  const activeId = ctx?.projectId ?? null;
  if (!activeId) return { ok: false, reason: 'no_project_selected' };
  if (typeof requestedProjectId === 'string' && requestedProjectId && requestedProjectId !== activeId) {
    return { ok: false, reason: 'stale_project_switch' };
  }
  return {
    ok: true,
    projectId: activeId,
    projectName: ctx?.projectName ?? 'this project',
    dawType: ctx?.dawType ?? null,
    files: ctx?.files ?? [],
    versionCount: ctx?.versionCount ?? 0,
  };
}

/** Basename only — never a raw absolute path in a model-visible string. */
export function redactPath(p: string | null | undefined): string {
  if (!p || typeof p !== 'string') return '(unknown)';
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || '(unknown)';
}

// ── Deterministic derivations ────────────────────────────────────────────────

export interface ProjectInspection {
  projectId: string;
  projectName: string;
  dawType: string | null;
  fileCount: number;
  byRole: Record<string, number>;
  syncedCount: number;
  unsyncedCount: number;
  missingCount: number;
  versionCount: number;
}

export function deriveInspectProject(r: Extract<ProjectContextResolution, { ok: true }>): ProjectInspection {
  const byRole: Record<string, number> = {};
  let synced = 0, unsynced = 0, missing = 0;
  for (const f of r.files) {
    byRole[f.role] = (byRole[f.role] ?? 0) + 1;
    if (f.syncStatus === 'missing') missing++;
    else if (f.syncStatus === 'synced') synced++;
    else unsynced++;
  }
  return {
    projectId: r.projectId, projectName: r.projectName, dawType: r.dawType,
    fileCount: r.files.length, byRole, syncedCount: synced, unsyncedCount: unsynced,
    missingCount: missing, versionCount: r.versionCount,
  };
}

export interface PackageCompleteness {
  complete: boolean;
  hasProjectFile: boolean;
  hasAudio: boolean;
  unsyncedCount: number;
  missingFiles: string[]; // basenames only
}

/** A package is "complete enough to share" when it has the DAW project file, at
 *  least one audio/bounce, nothing missing on disk, and nothing still unsynced. */
export function derivePackageCompleteness(files: ProjectFile[]): PackageCompleteness {
  const hasProjectFile = files.some((f) => f.role === 'project');
  const hasAudio = files.some((f) => ['audio', 'master', 'stem', 'bounce'].includes(f.role));
  const missingFiles = files.filter((f) => f.syncStatus === 'missing').map((f) => redactPath(f.fileName));
  const unsyncedCount = files.filter((f) => f.syncStatus !== 'synced' && f.syncStatus !== 'missing').length;
  const complete = hasProjectFile && hasAudio && missingFiles.length === 0 && unsyncedCount === 0;
  return { complete, hasProjectFile, hasAudio, unsyncedCount, missingFiles };
}

export interface ErrorExplanation {
  retryable: number;
  permanent: number;
  missing: number;
  headline: string;
}

export function deriveErrorExplanation(c: { retryable: string[]; permanent: string[]; missing: string[] }): ErrorExplanation {
  const retryable = c.retryable.length, permanent = c.permanent.length, missing = c.missing.length;
  let headline: string;
  if (retryable + permanent + missing === 0) headline = 'No sync errors for this project.';
  else {
    const parts: string[] = [];
    if (retryable) parts.push(`${retryable} transient (retryable)`);
    if (permanent) parts.push(`${permanent} blocked by permission/not-found (permanent)`);
    if (missing) parts.push(`${missing} for files missing on disk`);
    headline = `${retryable + permanent + missing} sync error(s): ${parts.join(', ')}.`;
  }
  return { retryable, permanent, missing, headline };
}

// ── Typed honest states for server-blocked / unimplemented capabilities ──────

export type BlockedReason =
  | 'server_contract_pending'
  | 'authentication_required'
  | 'unsupported'
  | 'not_implemented';

export const BLOCKED_TOOL_MESSAGE: Record<BlockedReason, string> = {
  server_contract_pending: 'This needs the authoritative Project Link server contract, which is not committed/verified yet. Nothing was changed.',
  authentication_required: 'Sign in to Wavi to use this action.',
  unsupported: 'This action is not supported on the desktop.',
  not_implemented: 'This action is not implemented yet.',
};

/**
 * Capabilities the assistant must STILL decline honestly (never fabricate
 * success). The Project Link trio (list/create/revoke) was unblocked in P3-3b
 * and is implemented below against the authoritative main-process service;
 * multiplayer + contribution capabilities remain contract-blocked.
 */
/**
 * Capabilities that still have no server contract.
 *
 * EMPTY as of P3-4: the three multiplayer tools were unblocked once the
 * Multiplayer v1 contract (wavio@6a4a9e8) and the P3-4-ID identity-resolution
 * contract (wavio@d95683f) shipped. Kept as the mechanism for the next
 * genuinely-blocked capability rather than deleted.
 */
export const BLOCKED_CAPABILITIES: { name: string; description: string; reason: BlockedReason }[] = [];

// ── Assistant Project Link surface (P3-3b) ───────────────────────────────────
// The tools below call the SAME authoritative main-process functions the IPC
// handlers use — there is no second HTTP implementation and no second canonical
// link identity. Deps return already-sanitized, assistant-safe shapes.

/** Normalized, assistant-safe failure reasons. Never a raw server error. */
export type AssistantLinkFailure =
  | 'authentication_required' | 'account_unverified' | 'offline' | 'not_owned'
  | 'rejected' | 'not_found' | 'conflict' | 'retryable' | 'malformed_response'
  | 'stale_project' | 'stale_session' | 'reconciliation_pending'
  | 'create_outcome_unknown' | 'malformed_reference'
  // Multiplayer-specific (P3-4)
  | 'rate_limited' | 'invite_target_expired' | 'contribution_outcome_unknown';

export const ASSISTANT_LINK_FAILURE_MESSAGE: Record<AssistantLinkFailure, string> = {
  authentication_required: 'Sign in to Wavi to do that.',
  account_unverified: 'Your account could not be verified yet — refresh Links once, then try again.',
  offline: "You appear to be offline. Nothing was changed on the server.",
  not_owned: 'That link is not owned by the signed-in account.',
  rejected: 'The server rejected the request.',
  not_found: 'That Project Link no longer exists on the server.',
  conflict: 'This project has no publishable version yet — publish a version first.',
  retryable: 'The server had a temporary problem. Try again shortly.',
  malformed_response: 'The server response could not be confirmed, so nothing is reported as done.',
  stale_project: 'The active project changed before this ran — nothing was done.',
  stale_session: 'The session changed before this finished — the result was discarded.',
  reconciliation_pending: 'The authoritative listing is incomplete, so this view may be out of date.',
  create_outcome_unknown: 'The link may or may not have been created. Refresh Links to check — it was NOT retried automatically.',
  malformed_reference: "That reference isn't valid for the active project and account.",
  rate_limited: 'Too many collaborator lookups recently. Tell the user to wait a few minutes — do not retry automatically.',
  invite_target_expired: 'That collaborator lookup expired. Run find_collaborator again before inviting.',
  contribution_outcome_unknown:
    'The contribution may or may not have been submitted. Do NOT submit again — tell the user to refresh the project and check.',
};

export type AssistantListResult =
  | { kind: 'ok'; links: AssistantSafeLink[]; pageComplete: boolean; reconciliationNeeded: number }
  | { kind: 'failure'; reason: AssistantLinkFailure };

export type AssistantCreateResult =
  | { kind: 'created'; link: AssistantSafeLink }
  | { kind: 'failure'; reason: AssistantLinkFailure };

export type AssistantRevokeResult =
  | { kind: 'revoked'; ref: string; alreadyRevoked: boolean }
  | { kind: 'failure'; reason: AssistantLinkFailure };

export interface AssistantProjectLinkDeps {
  /** Authoritative reconcile + account-scoped read, projected to safe shapes. */
  listProjectLinksSafe: (opts: { projectId: string; versionId?: string }) => Promise<AssistantListResult>;
  /** Authoritative create (confirmation already enforced by the envelope). */
  createProjectLinkSafe: (opts: {
    projectId: string; collaboratorMode: 'view' | 'comment';
    allowDownload: boolean; expiresAt: string | null;
  }) => Promise<AssistantCreateResult>;
  /** Authoritative revoke by assistant-safe ref, scoped to project + account. */
  revokeProjectLinkSafe: (opts: { ref: string; projectId: string }) => Promise<AssistantRevokeResult>;
}

// ── Assistant Multiplayer surface (P3-4) ─────────────────────────────────────
// Same discipline as Project Links: these call the SAME authoritative
// main-process functions the IPC handlers use. The model never sees a canonical
// DID, a raw `invt_…` capability, a membership id, or a contribution id.

/** What the model is allowed to know about a resolved invite target. */
export interface AssistantInviteTarget {
  /** Opaque, project- and session-scoped. Safe to echo back to the model. */
  ref: string;
  displayName: string | null;
}

export type AssistantResolveResult =
  | { kind: 'resolved'; target: AssistantInviteTarget }
  /** Deliberately indistinguishable from "no such account". */
  | { kind: 'unresolved' }
  | { kind: 'failure'; reason: AssistantLinkFailure };

export type AssistantInviteResult =
  | { kind: 'ok'; displayName: string | null; role: 'view' | 'comment'; canContribute: boolean; alreadyInvited: boolean }
  | { kind: 'failure'; reason: AssistantLinkFailure };

/** One activity row as the model may see it — closed enum, display-only actor. */
export interface AssistantActivityRow {
  type: string;
  displayName: string | null;
  occurredAt: string | null;
}

export type AssistantActivityResult =
  | { kind: 'ok'; events: AssistantActivityRow[]; pageComplete: boolean; skippedUnknownEvents: number }
  | { kind: 'failure'; reason: AssistantLinkFailure };

export type AssistantContributionResult =
  | { kind: 'ok'; state: string; alreadySubmitted: boolean }
  | { kind: 'failure'; reason: AssistantLinkFailure };

export interface AssistantMultiplayerDeps {
  /**
   * Resolve a user-typed email/@handle. Rate-limited server-side, so this must
   * run only from an explicit user request — never speculatively.
   */
  resolveInviteTargetSafe: (opts: { projectId: string; identifier: string }) => Promise<AssistantResolveResult>;
  /** Invite using a ref from resolveInviteTargetSafe. Never a DID. */
  inviteCollaboratorSafe: (opts: {
    projectId: string; targetRef: string; role: 'view' | 'comment'; canContribute: boolean;
  }) => Promise<AssistantInviteResult>;
  listActivitySafe: (opts: { projectId: string; limit?: number }) => Promise<AssistantActivityResult>;
  publishChildVersionSafe: (opts: {
    projectId: string; contributorNote: string | null;
  }) => Promise<AssistantContributionResult>;
}

// ── Tool specs (deterministic, envelope-wrapped by the caller) ───────────────

export interface LocalInspectionDeps extends EnvelopeDeps {
  /**
   * Reveal a file by its opaque DB id within a project. The full filesystem
   * path is resolved and used ENTIRELY in the main process — it is never
   * returned to the tool (and therefore never reaches the model). Returns an
   * outcome the tool can describe with basenames only.
   */
  revealFileById: (projectId: string, fileId: string) => { revealed: boolean; missingOnDisk?: boolean; notFound?: boolean };
  /** Open a file by opaque id within a project. Path resolved only in main. */
  openFileById: (projectId: string, fileId: string) => { opened: boolean; missingOnDisk?: boolean; notFound?: boolean };
  /** Local immutable versions for a project. */
  getVersions: (projectId: string) => Array<{ version_number?: number; created_at?: string; file_count?: number }>;
  /** DAW capability report (adapter-derived) for the active project. */
  getCapabilities: (dawType: string | null, filePath: string | null) => { dawType: string; canRestore: boolean; canOpen: boolean; notes?: string[] } | null;
  /** Classify failed sync rows for a project. */
  classifyErrors: (projectId: string) => { retryable: string[]; permanent: string[]; missing: string[] };
  /** P3-3b: authoritative Project Link operations (assistant-safe projections). */
  projectLinks: AssistantProjectLinkDeps;
  multiplayer: AssistantMultiplayerDeps;
}

function staleResult(res: Extract<ProjectContextResolution, { ok: false }>): CopilotToolResult {
  if (res.reason === 'stale_project_switch') {
    return { status: 'error', error: 'The active project changed before this ran — nothing was done. Ask again for the current project.', blockedReason: undefined };
  }
  return { status: 'error', error: 'No project selected — open a project first.' };
}

export function buildLocalInspectionToolSpecs(deps: LocalInspectionDeps): CopilotToolSpec[] {
  const projectIdParam = { projectId: { type: 'string' as const, description: 'The id of the project this applies to (the active project).', required: false } };

  return [
    {
      name: 'inspect_project',
      description: 'Summarize the current project: files by role, sync counts, missing files, version count. Read-only, offline.',
      parameters: { ...projectIdParam },
      execution: 'local',
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const ins = deriveInspectProject(r);
        const roles = Object.entries(ins.byRole).map(([k, n]) => `${n} ${k}`).join(', ') || 'no files';
        const msg = `“${ins.projectName}” (${ins.dawType ?? 'DAW'}): ${ins.fileCount} file(s) — ${roles}. `
          + `${ins.syncedCount} synced, ${ins.unsyncedCount} pending, ${ins.missingCount} missing. ${ins.versionCount} version(s).`;
        return { status: 'done', message: msg, projectId: ins.projectId, data: ins };
      },
    },
    {
      name: 'reveal_file',
      description: 'Reveal a project file in Finder/Explorer. Launches the file manager, so it asks for confirmation first.',
      parameters: { fileName: { type: 'string', description: 'Name of the file to reveal.' }, ...projectIdParam },
      execution: 'local',
      // Reveal launches an external application (Finder/Explorer) — a
      // side-effecting action the model must not perform unattended. Gated;
      // only the renderer's confirmation card sets confirmedOutOfBand.
      requiresConfirmation: true,
      confirmationSummary: (params) => `Reveal “${redactPath(String(params.fileName ?? 'the file'))}” in Finder?`,
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const wanted = String(params.fileName ?? '').toLowerCase();
        const match = r.files.find((f) => f.fileName.toLowerCase() === wanted)
          ?? r.files.find((f) => f.fileName.toLowerCase().includes(wanted));
        if (!match) return { status: 'error', error: `No file named “${redactPath(String(params.fileName))}” in “${r.projectName}”.`, projectId: r.projectId };
        // Reveal by opaque id — the full path is resolved and used only in main;
        // the tool never sees it, so it can't reach the model.
        const outcome = deps.revealFileById(r.projectId, match.id);
        if (outcome.notFound) return { status: 'error', error: `“${redactPath(match.fileName)}” is no longer in this project.`, projectId: r.projectId };
        if (outcome.missingOnDisk) return { status: 'error', error: `“${redactPath(match.fileName)}” was moved or deleted on disk.`, projectId: r.projectId };
        if (!outcome.revealed) return { status: 'error', error: `Couldn't reveal “${redactPath(match.fileName)}”.`, projectId: r.projectId };
        return { status: 'done', message: `Revealing “${redactPath(match.fileName)}” in Finder.`, projectId: r.projectId };
      },
    },
    {
      name: 'open_file',
      description: 'Open a file from the current project in its default app / DAW. Launches an external app, so it asks for confirmation first.',
      parameters: { fileName: { type: 'string', description: 'Name of the file to open (must belong to the active project).' }, ...projectIdParam },
      execution: 'local',
      requiresConfirmation: true,
      confirmationSummary: (params) => `Open “${redactPath(String(params.fileName ?? 'the file'))}” in an external app?`,
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const wanted = String(params.fileName ?? '').toLowerCase();
        // File MUST belong to the active project — resolved from ctx.files only.
        const match = r.files.find((f) => f.fileName.toLowerCase() === wanted)
          ?? r.files.find((f) => f.fileName.toLowerCase().includes(wanted));
        if (!match) return { status: 'error', error: `No file named “${redactPath(String(params.fileName))}” in “${r.projectName}”.`, projectId: r.projectId };
        const outcome = deps.openFileById(r.projectId, match.id);
        if (outcome.notFound) return { status: 'error', error: `“${redactPath(match.fileName)}” is no longer in this project.`, projectId: r.projectId };
        if (outcome.missingOnDisk) return { status: 'error', error: `“${redactPath(match.fileName)}” was moved or deleted on disk.`, projectId: r.projectId };
        if (!outcome.opened) return { status: 'error', error: `Couldn't open “${redactPath(match.fileName)}”.`, projectId: r.projectId };
        return { status: 'done', message: `Opening “${redactPath(match.fileName)}”.`, projectId: r.projectId };
      },
    },
    {
      name: 'inspect_package_completeness',
      description: 'Check whether the current project is complete enough to share: DAW file, audio, nothing missing or unsynced. Read-only, offline.',
      parameters: { ...projectIdParam },
      execution: 'local',
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const pkg = derivePackageCompleteness(r.files);
        const issues: string[] = [];
        if (!pkg.hasProjectFile) issues.push('no DAW project file');
        if (!pkg.hasAudio) issues.push('no audio/bounce');
        if (pkg.unsyncedCount) issues.push(`${pkg.unsyncedCount} unsynced`);
        if (pkg.missingFiles.length) issues.push(`${pkg.missingFiles.length} missing on disk`);
        const msg = pkg.complete
          ? `“${r.projectName}” looks complete: DAW file + audio present, all files synced.`
          : `“${r.projectName}” is not fully shareable yet — ${issues.join(', ')}.`;
        return { status: 'done', message: msg, projectId: r.projectId, data: pkg };
      },
    },
    {
      name: 'inspect_daw_compatibility',
      description: 'Report DAW compatibility for the current project (restore/open capability). Read-only, offline.',
      parameters: { ...projectIdParam },
      execution: 'local',
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const c = (ctx as ProjectContext | null);
        const report = deps.getCapabilities(r.dawType, c?.filePath ?? null);
        if (!report) return { status: 'done', message: `No compatibility information for “${r.projectName}”.`, projectId: r.projectId };
        const bits = [`restore ${report.canRestore ? 'supported' : 'not supported'}`, `open ${report.canOpen ? 'supported' : 'not supported'}`];
        const msg = `“${r.projectName}” (${report.dawType}): ${bits.join(', ')}.${report.notes?.length ? ' ' + report.notes.join(' ') : ''}`;
        return { status: 'done', message: msg, projectId: r.projectId, data: report };
      },
    },
    {
      name: 'list_local_versions',
      description: 'List the immutable versions recorded locally for the current project. Read-only, offline.',
      parameters: { ...projectIdParam },
      execution: 'local',
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const versions = deps.getVersions(r.projectId) ?? [];
        if (!versions.length) return { status: 'done', message: `No versions recorded yet for “${r.projectName}”.`, projectId: r.projectId, data: [] };
        const list = versions.slice(0, 10).map((v) => `• v${v.version_number ?? '?'}${v.created_at ? ` · ${new Date(v.created_at).toLocaleDateString()}` : ''}${v.file_count ? ` · ${v.file_count} files` : ''}`).join('\n');
        return { status: 'done', message: `“${r.projectName}” has ${versions.length} version(s):\n${list}`, projectId: r.projectId, data: versions };
      },
    },
    {
      name: 'explain_project_errors',
      description: 'Explain the current project’s sync errors: transient vs permanent vs missing-on-disk. Read-only, offline.',
      parameters: { ...projectIdParam },
      execution: 'local',
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const ex = deriveErrorExplanation(deps.classifyErrors(r.projectId));
        return { status: 'done', message: ex.headline, projectId: r.projectId, data: ex };
      },
    },

    // ── Project Links (P3-3b) — authoritative service, one execution path ────
    {
      name: 'list_project_links',
      description: 'List the Project Links for the current project (authoritative, account-scoped). Read-only.',
      parameters: {
        versionId: { type: 'string', description: 'Optional: only links for this immutable version.', required: false },
        ...projectIdParam,
      },
      execution: 'local',
      // Read-only: no confirmation. (Auth/account failures are typed, not gated.)
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const res = await deps.projectLinks.listProjectLinksSafe({
          projectId: r.projectId,
          versionId: typeof params.versionId === 'string' ? params.versionId : undefined,
        });
        if (res.kind === 'failure') return linkFailure(res.reason, r.projectId);
        if (!res.links.length) {
          const caveat = res.pageComplete ? '' : ' (the authoritative listing was incomplete, so this may be partial)';
          return { status: 'done', message: `No Project Links for “${r.projectName}”${caveat}.`, projectId: r.projectId, data: { links: [], pageComplete: res.pageComplete } };
        }
        const lines = res.links.map((l) =>
          `• ${l.ref} — ${l.status}${l.versionId ? ` · version ${l.versionId}` : ''} · ${l.permissions.collaboratorMode}${l.permissions.allowDownload ? ' · download' : ''}${l.expiresAt ? ` · expires ${l.expiresAt}` : ''} · ${l.reconciliation}`).join('\n');
        const notes: string[] = [];
        if (!res.pageComplete) notes.push('the authoritative listing was incomplete — treat as partial');
        if (res.reconciliationNeeded > 0) notes.push(`${res.reconciliationNeeded} record(s) need reconciliation`);
        return {
          status: 'done',
          message: `“${r.projectName}” has ${res.links.length} Project Link(s):\n${lines}${notes.length ? `\n(${notes.join('; ')})` : ''}`,
          projectId: r.projectId,
          data: { links: res.links, pageComplete: res.pageComplete, reconciliationNeeded: res.reconciliationNeeded },
        };
      },
    },
    {
      name: 'create_project_link',
      description: 'Create a Project Link for the current project on the server. Shares the project — asks for your confirmation first.',
      parameters: {
        collaboratorMode: { type: 'string', description: 'Access level: view or comment (edit is not supported).', required: false },
        allowDownload: { type: 'boolean', description: 'Allow the recipient to download (default true).', required: false },
        expiresAt: { type: 'string', description: 'Optional ISO-8601 expiry.', required: false },
        ...projectIdParam,
      },
      execution: 'cloud',
      // Sharing a project publicly is a side-effecting server mutation: gated.
      requiresConfirmation: true,
      confirmationSummary: (params, ctx) => {
        const c = ctx as ProjectContext | null;
        const mode = normalizeMode(params.collaboratorMode).mode ?? 'view';
        const dl = params.allowDownload === false ? 'download OFF' : 'download ON';
        const exp = typeof params.expiresAt === 'string' && params.expiresAt ? ` · expires ${params.expiresAt}` : ' · no expiry';
        const version = c?.versionId ? ` · version ${c.versionId}` : ' · latest published version';
        return `Create a Project Link for “${c?.projectName ?? 'the selected project'}”${version}? Access: ${mode} · ${dl}${exp}. Anyone with the link can open it.`;
      },
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        // Reject unsupported modes BEFORE any network call (server 400s on `edit`).
        const m = normalizeMode(params.collaboratorMode);
        if (!m.ok) {
          return { status: 'error', projectId: r.projectId, error: `Access level “${m.given}” is not supported. Use view or comment.` };
        }
        const res = await deps.projectLinks.createProjectLinkSafe({
          projectId: r.projectId,
          collaboratorMode: m.mode,
          allowDownload: params.allowDownload !== false,
          expiresAt: typeof params.expiresAt === 'string' && params.expiresAt ? params.expiresAt : null,
        });
        if (res.kind === 'failure') return linkFailure(res.reason, r.projectId);
        const l = res.link;
        return {
          status: 'done',
          message: `Created a Project Link for “${r.projectName}” (${l.ref}) — ${l.permissions.collaboratorMode}${l.permissions.allowDownload ? ', download allowed' : ''}${l.expiresAt ? `, expires ${l.expiresAt}` : ''}. Copy it from the Links page.`,
          projectId: r.projectId,
          data: { link: l },
        };
      },
    },
    {
      name: 'revoke_project_link',
      description: 'Revoke a Project Link for the current project, using a reference from list_project_links. Asks for your confirmation first.',
      parameters: {
        ref: { type: 'string', description: 'The link reference from list_project_links (e.g. plink_00000001).' },
        ...projectIdParam,
      },
      execution: 'cloud',
      // Irreversible loss of access for every recipient: gated.
      requiresConfirmation: true,
      confirmationSummary: (params, ctx) => {
        const c = ctx as ProjectContext | null;
        return `Revoke Project Link ${String(params.ref ?? '')} for “${c?.projectName ?? 'the selected project'}”? Everyone holding it loses access immediately. This cannot be undone.`;
      },
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const res = await deps.projectLinks.revokeProjectLinkSafe({ ref: String(params.ref ?? ''), projectId: r.projectId });
        if (res.kind === 'failure') return linkFailure(res.reason, r.projectId);
        return {
          status: 'done',
          projectId: r.projectId,
          message: res.alreadyRevoked
            ? `${res.ref} was already revoked — access remains withdrawn.`
            : `Revoked ${res.ref}. Everyone holding that link has lost access.`,
          data: { ref: res.ref, alreadyRevoked: res.alreadyRevoked },
        };
      },
    },

    // ── Multiplayer v1 (P3-4) — previously blocked, now contract-backed ──────
    {
      name: 'find_collaborator',
      description:
        'Look up a person by email or @handle to see whether they can be invited to the current project. Read-only. Rate-limited — only run when the user explicitly asks to find or invite someone.',
      parameters: {
        identifier: { type: 'string', description: 'An email address or @handle, exactly as the user typed it.' },
        ...projectIdParam,
      },
      execution: 'cloud',
      // Read-only lookup: no confirmation. Rate limiting is enforced server-side.
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const identifier = typeof params.identifier === 'string' ? params.identifier.trim() : '';
        if (!identifier) {
          return { status: 'error', projectId: r.projectId, error: 'Ask the user for an email address or @handle first.' };
        }
        const res = await deps.multiplayer.resolveInviteTargetSafe({ projectId: r.projectId, identifier });
        if (res.kind === 'failure') return linkFailure(res.reason, r.projectId);
        if (res.kind === 'unresolved') {
          // One neutral answer. Never speculate about why, and never retry with
          // variations — that would probe for who has an account.
          return {
            status: 'done',
            projectId: r.projectId,
            message: 'No inviteable Wavi account found. Do not try other spellings — ask the user to check the address or handle with the person directly.',
            data: { resolved: false },
          };
        }
        return {
          status: 'done',
          projectId: r.projectId,
          message: `Found ${res.target.displayName ?? 'a Wavi account'} (${res.target.ref}). This lookup expires in about 10 minutes — invite now or search again.`,
          data: { resolved: true, target: res.target },
        };
      },
    },
    {
      name: 'invite_collaborator',
      description:
        'Invite someone to the current project using a reference from find_collaborator. Gives another person access — asks for your confirmation first.',
      parameters: {
        ref: { type: 'string', description: 'The target reference from find_collaborator (e.g. pinvite_00000001).' },
        role: { type: 'string', description: 'Access level: view or comment. There is no edit role.', required: false },
        canContribute: { type: 'boolean', description: 'Allow them to submit contribution versions. Only possible with the comment role.', required: false },
        ...projectIdParam,
      },
      execution: 'cloud',
      // Grants another human access to the user's project: always gated.
      requiresConfirmation: true,
      confirmationSummary: (params, ctx) => {
        const c = ctx as ProjectContext | null;
        const m = normalizeMode(params.role);
        const role = m.mode ?? 'view';
        const contribute = role === 'comment' && params.canContribute === true;
        return `Invite ${String(params.ref ?? 'this person')} to “${c?.projectName ?? 'the selected project'}” as ${role}${contribute ? ', allowed to submit contribution versions' : ', not allowed to contribute versions'}? They will be able to open this project.`;
      },
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const m = normalizeMode(params.role);
        if (!m.ok) {
          return { status: 'error', projectId: r.projectId, error: `Role “${m.given}” is not supported. Use view or comment.` };
        }
        // The server forces can_contribute false unless the role is comment.
        // Say so rather than letting the request be silently downgraded.
        if (params.canContribute === true && m.mode !== 'comment') {
          return {
            status: 'error',
            projectId: r.projectId,
            error: 'Only a “comment” collaborator can contribute versions. Re-run with role “comment”, or invite as view without contribution.',
          };
        }
        const res = await deps.multiplayer.inviteCollaboratorSafe({
          projectId: r.projectId,
          targetRef: String(params.ref ?? ''),
          role: m.mode,
          canContribute: params.canContribute === true,
        });
        if (res.kind === 'failure') return linkFailure(res.reason, r.projectId);
        const who = res.displayName ?? 'They';
        return {
          status: 'done',
          projectId: r.projectId,
          message: res.alreadyInvited
            ? `${who} already has a pending invitation to “${r.projectName}” — nothing changed.`
            : `Invited ${who} to “${r.projectName}” as ${res.role}${res.canContribute ? ', able to submit contribution versions' : ''}. They must accept before they get access.`,
          data: { role: res.role, canContribute: res.canContribute, alreadyInvited: res.alreadyInvited },
        };
      },
    },
    {
      name: 'inspect_collaborator_activity',
      description: 'Show recent collaborator activity on the current project. Read-only.',
      parameters: {
        limit: { type: 'number', description: 'How many recent events to show (default 20, max 100).', required: false },
        ...projectIdParam,
      },
      execution: 'cloud',
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
          ? Math.max(1, Math.min(100, Math.floor(params.limit)))
          : 20;
        const res = await deps.multiplayer.listActivitySafe({ projectId: r.projectId, limit });
        if (res.kind === 'failure') return linkFailure(res.reason, r.projectId);
        if (!res.events.length) {
          return { status: 'done', projectId: r.projectId, message: `No collaborator activity on “${r.projectName}” yet.`, data: { events: [] } };
        }
        const lines = res.events.map((e) =>
          `• ${ACTIVITY_PHRASE[e.type] ?? e.type}${e.displayName ? ` — ${e.displayName}` : ''}${e.occurredAt ? ` · ${e.occurredAt}` : ''}`).join('\n');
        const notes: string[] = [];
        if (!res.pageComplete) notes.push('there is more activity than shown');
        if (res.skippedUnknownEvents > 0) notes.push(`${res.skippedUnknownEvents} newer event type(s) could not be described and were skipped`);
        return {
          status: 'done',
          projectId: r.projectId,
          message: `Recent activity on “${r.projectName}”:\n${lines}${notes.length ? `\n(${notes.join('; ')})` : ''}`,
          data: { events: res.events, pageComplete: res.pageComplete, skippedUnknownEvents: res.skippedUnknownEvents },
        };
      },
    },
    {
      name: 'publish_child_version',
      description:
        'Submit your local changes to the current project as a NEW CHILD VERSION for the owner to review. Does not change the version you started from. Asks for your confirmation first.',
      parameters: {
        note: { type: 'string', description: 'A short note for the owner describing the changes.', required: false },
        ...projectIdParam,
      },
      execution: 'cloud',
      // Publishes the user's work to someone else's project: gated.
      requiresConfirmation: true,
      confirmationSummary: (params, ctx) => {
        const c = ctx as ProjectContext | null;
        const note = typeof params.note === 'string' && params.note.trim() ? ` Note: “${params.note.trim()}”.` : '';
        const parent = c?.versionId ? ` based on version ${c.versionId}` : ' based on the version you started from';
        return `Submit “${c?.projectName ?? 'the selected project'}” as a NEW CHILD VERSION${parent} for the owner to review?${note} This creates a new version — it does NOT overwrite or edit the original.`;
      },
      run: async (params, ctx): Promise<CopilotToolResult> => {
        const r = resolveToolProjectContext(ctx as ProjectContext | null, params.projectId);
        if (!r.ok) return staleResult(r);
        const note = typeof params.note === 'string' && params.note.trim() ? params.note.trim() : null;
        const res = await deps.multiplayer.publishChildVersionSafe({ projectId: r.projectId, contributorNote: note });
        if (res.kind === 'failure') return linkFailure(res.reason, r.projectId);
        return {
          status: 'done',
          projectId: r.projectId,
          message: res.alreadySubmitted
            ? `This contribution was already submitted for “${r.projectName}” — the original submission stands. No second version was created.`
            : `Submitted a new child version of “${r.projectName}” for review (${res.state}). The version you started from is unchanged.`,
          data: { state: res.state, alreadySubmitted: res.alreadySubmitted },
        };
      },
    },
  ];
}

/** Human phrasing for the locked activity enum. Unknown types never reach here. */
const ACTIVITY_PHRASE: Record<string, string> = {
  collaborator_invited: 'Collaborator invited',
  collaborator_joined: 'Collaborator joined',
  collaborator_removed: 'Collaborator removed',
  version_published: 'Version published',
  contribution_submitted: 'Contribution submitted',
  contribution_accepted: 'Contribution accepted',
  contribution_rejected: 'Contribution rejected',
  contribution_withdrawn: 'Contribution withdrawn',
};

/** Collaborator modes the server accepts; `edit` is rejected before any call. */
function normalizeMode(v: unknown): { ok: true; mode: 'view' | 'comment' } | { ok: false; given: string; mode?: undefined } {
  if (v == null || v === '') return { ok: true, mode: 'view' };
  const s = String(v).trim().toLowerCase();
  if (s === 'view' || s === 'comment') return { ok: true, mode: s };
  return { ok: false, given: String(v) };
}

/** Map a normalized failure to an honest, assistant-safe tool result. */
function linkFailure(reason: AssistantLinkFailure, projectId: string): CopilotToolResult {
  const blocked: Partial<Record<AssistantLinkFailure, BlockedReason>> = {
    authentication_required: 'authentication_required',
  };
  return {
    status: 'error',
    projectId,
    error: ASSISTANT_LINK_FAILURE_MESSAGE[reason],
    ...(blocked[reason] ? { blockedReason: blocked[reason] } : {}),
  };
}

/** Honest, typed declines for server-blocked / multiplayer capabilities. */
export function buildBlockedToolSpecs(): CopilotToolSpec[] {
  return BLOCKED_CAPABILITIES.map((cap) => ({
    name: cap.name,
    description: `${cap.description} (currently unavailable: ${cap.reason})`,
    parameters: {},
    execution: 'local' as const,
    run: async (): Promise<CopilotToolResult> => ({
      status: 'error',
      error: BLOCKED_TOOL_MESSAGE[cap.reason],
      blockedReason: cap.reason,
    }),
  }));
}
