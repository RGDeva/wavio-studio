import type { ProjectContext } from '../copilotTypes';
import {
  CopilotToolSpec, CopilotToolResult, EnvelopeDeps, wrapTool,
} from './envelope';

/**
 * The first five Copilot project tools (Phase H). Implementations are
 * injected (ProjectToolDeps) so this module stays importable under vitest —
 * main.ts wires the real db/sync/shell/publish functions at startup.
 *
 * Offline behavior (documented per the architecture doc):
 *   search_files          local  — works offline
 *   open_in_daw           local  — works offline
 *   inspect_sync_status   local  — works offline (reports queued work waiting)
 *   sync_project          local  — works offline (queues; uploads resume online)
 *   publish_version       cloud  — requires sign-in + network; gated by
 *                                  explicit renderer-side confirmation
 */

export interface ProjectToolDeps extends EnvelopeDeps {
  searchFiles: (query: string, limit: number) => any[];
  openPath: (filePath: string) => void;
  fileExists: (filePath: string) => boolean;
  getSyncStatus: () => string;
  getQueueCounts: () => Record<string, number>;
  prioritizeProject: (projectId: string, force?: boolean) =>
    | { needsConfirmation: true; retryCount: number }
    | { needsConfirmation: false; bumped: number; requeued: number; blockedPermanent: number; skippedMissing: number };
  publishVersion: (localProjectId: string) => Promise<{ versionId?: string; versionNumber?: number; fileCount?: number; skipped?: boolean; error?: string }>;
}

function requireProject(ctx: unknown): { id: string; name: string } | null {
  const c = ctx as ProjectContext | null;
  if (!c?.projectId) return null;
  return { id: c.projectId, name: c.projectName ?? 'this project' };
}

export function buildProjectToolSpecs(deps: ProjectToolDeps): CopilotToolSpec[] {
  return [
    {
      name: 'search_files',
      description: 'Search the local music library by name, project, BPM or key. Works offline.',
      parameters: {
        query: { type: 'string', description: 'Search term — file name, project name, or keywords' },
        bpm: { type: 'number', description: 'Filter by BPM (±3)', required: false },
        key: { type: 'string', description: 'Filter by musical key, e.g. Am, F#', required: false },
      },
      execution: 'local',
      run: async (params): Promise<CopilotToolResult> => {
        const rows = deps.searchFiles(params.query as string, 20).filter((f: any) => {
          if (params.bpm !== undefined && Math.abs((f.bpm ?? 0) - (params.bpm as number)) > 3) return false;
          if (params.key !== undefined && !(f.key_note ?? '').toLowerCase().includes((params.key as string).toLowerCase())) return false;
          return true;
        });
        if (!rows.length) return { status: 'done', message: `No files matched "${params.query}".` };
        const list = rows.slice(0, 8).map((f: any) =>
          `• ${f.file_name}${f.project_name ? ` (${f.project_name})` : ''}${f.bpm ? ` · ${f.bpm} BPM` : ''}${f.key_note ? ` · ${f.key_note}` : ''}`).join('\n');
        return { status: 'done', message: `Found ${rows.length} file(s):\n${list}`, data: rows.slice(0, 8) };
      },
    },
    {
      name: 'open_in_daw',
      description: 'Open the current project (or a named project file) in its DAW. Works offline.',
      parameters: {
        query: { type: 'string', description: 'Project or file name — omit to open the selected project', required: false },
      },
      execution: 'local',
      run: async (params, ctx): Promise<CopilotToolResult> => {
        let filePath: string | null = null;
        let label: string | null = null;
        if (typeof params.query === 'string' && params.query.trim()) {
          const rows = deps.searchFiles(params.query, 3);
          if (!rows.length) return { status: 'error', error: `Couldn't find "${params.query}" in your library.` };
          filePath = rows[0].file_path; label = rows[0].file_name;
        } else {
          const c = ctx as ProjectContext | null;
          filePath = c?.filePath ?? null; label = c?.projectName ?? null;
          if (!filePath) return { status: 'error', error: 'No project selected. Open a project first or name the one you want.' };
        }
        if (!deps.fileExists(filePath!)) return { status: 'error', error: `"${label}" was moved or deleted on disk.` };
        deps.openPath(filePath!);
        return { status: 'done', message: `Opening "${label}" in your DAW.`, filePath: filePath! };
      },
    },
    {
      name: 'inspect_sync_status',
      description: 'Report the current sync state: queue counts, pauses, failures. Works offline.',
      parameters: {},
      execution: 'local',
      run: async (): Promise<CopilotToolResult> => {
        const status = deps.getSyncStatus();
        const counts = deps.getQueueCounts();
        const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`);
        const human = status === 'paused:user' ? 'Paused by you'
          : status === 'paused:auth' ? 'Paused — sign in again'
          : status === 'paused:limit' ? 'Paused — plan limit reached'
          : status.includes('uploading') ? 'Syncing now' : 'Idle';
        return { status: 'done', message: `Sync: ${human}. Queue: ${parts.length ? parts.join(', ') : 'empty'}.`, data: { status, counts } };
      },
    },
    {
      name: 'sync_project',
      description: 'Move the selected project to the front of the sync queue and retry transient failures. Works offline (queued work uploads when back online).',
      parameters: {},
      execution: 'local',
      run: async (_params, ctx, opts): Promise<CopilotToolResult> => {
        const project = requireProject(ctx);
        if (!project) return { status: 'error', error: 'No project selected — open a project first.' };
        const result = deps.prioritizeProject(project.id, opts?.confirmedOutOfBand === true);
        if (result.needsConfirmation) {
          return {
            status: 'needs_confirmation',
            confirmationSummary: `Retry ${result.retryCount} failed uploads for “${project.name}”? This may use significant bandwidth.`,
            message: 'Large retry — confirm in the Copilot panel to proceed.',
          };
        }
        if (result.bumped + result.requeued === 0) {
          if (result.skippedMissing > 0) return { status: 'done', message: 'Nothing to retry — some local files are missing on disk.' };
          if (result.blockedPermanent > 0) return { status: 'done', message: 'Uploads are blocked by permission or not-found errors — check Activity.' };
          return { status: 'done', message: `Nothing is queued for “${project.name}”.` };
        }
        return { status: 'done', message: `“${project.name}” moved to the front of the sync queue (${result.bumped + result.requeued} items).` };
      },
    },
    {
      name: 'publish_version',
      description: 'Publish an immutable version of the selected project to Wavi. Requires sign-in; asks for your confirmation first.',
      parameters: {},
      execution: 'cloud',
      requiresConfirmation: true,
      confirmationSummary: (_params, ctx) => {
        const project = requireProject(ctx);
        return `Publish a new immutable version of “${project?.name ?? 'the selected project'}”? This snapshot becomes shareable and cannot be edited afterwards.`;
      },
      run: async (_params, ctx): Promise<CopilotToolResult> => {
        const project = requireProject(ctx);
        if (!project) return { status: 'error', error: 'No project selected — open a project first.' };
        const r = await deps.publishVersion(project.id);
        if (r.error) return { status: 'error', error: r.error };
        if (r.skipped) return { status: 'done', message: `“${project.name}” is already up to date (v${r.versionNumber}).` };
        return { status: 'done', message: `Published v${r.versionNumber} of “${project.name}” — ${r.fileCount} files.`, data: { versionId: r.versionId } };
      },
    },
  ];
}

/** Registry-shaped entries with the envelope applied. */
export function buildProjectTools(deps: ProjectToolDeps) {
  return buildProjectToolSpecs(deps).map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    confirmationRequired: !!spec.requiresConfirmation,
    handler: wrapTool(spec, deps),
  }));
}

export type { CopilotToolResult };
