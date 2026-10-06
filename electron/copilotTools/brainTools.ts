/**
 * Assistant tools that READ from Project Brain.
 *
 * The point of this file is the direction of the arrow: the assistant asks the
 * brain, and the brain answers from deterministic local state. The model never
 * scans the filesystem, never computes a time window, and never decides what
 * is true — so an answer about the user's library is reproducible and can be
 * checked without re-running a model.
 *
 * Every tool here is read-only and offline. Nothing mutates a file, a project,
 * a version or a link; those paths keep their existing explicit approval
 * flows.
 *
 * No Electron imports — the specs are built from injected deps so vitest can
 * exercise them directly.
 */
import type { CopilotToolSpec, CopilotToolResult } from './envelope';

/** The read surface of the brain service this module needs. */
export interface BrainReadDeps {
  search: (query: string, limit?: number) => {
    empty: boolean;
    hits: Array<{ record: { id: string; kind: string; name: string; projectId: string; projectName: string; role: string | null; modifiedAt: string | null }; score: number; matchedOn: string[] }>;
    byProject: Array<{ projectId: string; projectName: string; hits: unknown[] }>;
    query: { uninterpreted: string[] };
  };
  findFiles: (query: string, limit?: number) => ReturnType<BrainReadDeps['search']>;
  recentActivity: (range: string, limit?: number) => {
    range: { from: string; to: string; label: string } | null;
    events: Array<{ type: string; message: string; projectId: string | null; projectName: string | null; at: string }>;
  };
  recentProjects: (range: string, limit?: number) => {
    range: { from: string; to: string; label: string } | null;
    projects: Array<{ id: string; name: string; dawType: string | null; syncStatus: string | null; modifiedAt: string | null }>;
  };
  projectMemory: (projectId: string) => {
    facts: Array<{ key: string; value: string }>;
    inferences: Array<{ key: string; value: string; evidence: string; strength: string }>;
  } | null;
  recallMemory: (opts: { projectId?: string | null; scope?: 'global' | 'project' | 'both' }) => {
    global: Array<{ key: string; value: string; category: string; scope: string; attribution: string; observedAt: string }>;
    project: Array<{ key: string; value: string; category: string; scope: string; attribution: string; observedAt: string }>;
    projectId: string | null;
  };
  changedSince: (projectId: string, versionId: string) => {
    sinceIso: string;
    files: Array<{ id: string; name: string; role: string | null; modifiedAt: string | null; syncStatus: string | null }>;
  } | null;
}

/** Resolve the project a tool should act on, preferring an explicit id. */
export interface BrainToolContext { projectId?: string | null }

function ok(message: string, data: unknown): CopilotToolResult {
  return { status: 'done', message, data } as CopilotToolResult;
}
function err(message: string): CopilotToolResult {
  return { status: 'error', error: message } as CopilotToolResult;
}

export function buildBrainToolSpecs(deps: BrainReadDeps): CopilotToolSpec[] {
  return [
    {
      name: 'search_music_library',
      description:
        'Search every indexed project and file by name, DAW, role, tempo or date. '
        + 'Supports filters: daw:ableton role:stem type:wav bpm:128 project:sunshine after:june before:june. '
        + 'Deterministic and offline — results come from the local index, never from memory of past conversations.',
      parameters: {
        query: { type: 'string', description: 'Search terms and optional filters.', required: true },
        limit: { type: 'number', description: 'Maximum results (default 25).', required: false },
      },
      execution: 'local',
      run: async (params) => {
        const query = String(params?.query ?? '').trim();
        if (!query) return err('Give me something to search for.');
        const r = deps.search(query, Math.min(Number(params?.limit ?? 25) || 25, 100));
        if (r.empty) return err('That query had nothing to match on — try a name, a DAW, or a date range.');
        return ok(`${r.hits.length} match${r.hits.length === 1 ? '' : 'es'} across ${r.byProject.length} project${r.byProject.length === 1 ? '' : 's'}.`, {
          matches: r.hits.map((h) => ({
            id: h.record.id, kind: h.record.kind, name: h.record.name,
            project: h.record.projectName, role: h.record.role,
            modifiedAt: h.record.modifiedAt, why: h.matchedOn,
          })),
          projectsMatched: r.byProject.length,
          // Surfaced rather than dropped: the user should know if part of what
          // they typed could not be interpreted.
          notInterpreted: r.query.uninterpreted,
        });
      },
    },
    {
      name: 'find_files',
      description: 'Find FILES only (not projects) across the library, with the same filters as search_music_library. Read-only, offline.',
      parameters: {
        query: { type: 'string', description: 'Search terms and optional filters.', required: true },
        limit: { type: 'number', description: 'Maximum results (default 25).', required: false },
      },
      execution: 'local',
      run: async (params) => {
        const query = String(params?.query ?? '').trim();
        if (!query) return err('Give me something to search for.');
        const r = deps.findFiles(query, Math.min(Number(params?.limit ?? 25) || 25, 100));
        if (r.empty) return err('That query had nothing to match on.');
        return ok(`${r.hits.length} file${r.hits.length === 1 ? '' : 's'}.`, {
          files: r.hits.map((h) => ({
            id: h.record.id, name: h.record.name, project: h.record.projectName,
            role: h.record.role, modifiedAt: h.record.modifiedAt, why: h.matchedOn,
          })),
        });
      },
    },
    {
      name: 'recent_activity',
      description:
        'What happened in the library over a time range: today, yesterday, this-week, last-week, this-month, last-month, or "last 7 days". '
        + 'Read-only, offline.',
      parameters: {
        range: { type: 'string', description: 'A range such as "yesterday" or "this-week".', required: true },
        limit: { type: 'number', description: 'Maximum events (default 100).', required: false },
      },
      execution: 'local',
      run: async (params) => {
        const range = String(params?.range ?? '').trim();
        const r = deps.recentActivity(range, Math.min(Number(params?.limit ?? 100) || 100, 500));
        if (!r.range) return err(`I don't know the range "${range}". Try today, yesterday, this-week, last-month, or "last 7 days".`);
        // An empty list plus the resolved window lets the model say "nothing
        // changed yesterday" instead of leaving it ambiguous.
        return ok(`${r.events.length} event${r.events.length === 1 ? '' : 's'} ${r.range.label}.`, { range: r.range.label, from: r.range.from, to: r.range.to, events: r.events, count: r.events.length });
      },
    },
    {
      name: 'recent_projects',
      description: 'Projects touched within a time range, most recently modified first. Read-only, offline.',
      parameters: {
        range: { type: 'string', description: 'A range such as "this-week".', required: true },
        limit: { type: 'number', description: 'Maximum projects (default 25).', required: false },
      },
      execution: 'local',
      run: async (params) => {
        const range = String(params?.range ?? '').trim();
        const r = deps.recentProjects(range, Math.min(Number(params?.limit ?? 25) || 25, 100));
        if (!r.range) return err(`I don't know the range "${range}".`);
        return ok(`${r.projects.length} project${r.projects.length === 1 ? '' : 's'} touched ${r.range.label}.`, { range: r.range.label, projects: r.projects, count: r.projects.length });
      },
    },
    {
      name: 'project_memory',
      description:
        'What Wavi knows about a project: counts, latest version, whether it changed since publishing, plus separately-labelled inferences '
        + 'such as the likely master file. Read-only, offline.',
      parameters: {
        projectId: { type: 'string', description: 'Project id (defaults to the active project).', required: false },
      },
      execution: 'local',
      run: async (params, ctx) => {
        const projectId = String(params?.projectId ?? (ctx as BrainToolContext)?.projectId ?? '');
        if (!projectId) return err('No project selected — open a project first.');
        const m = deps.projectMemory(projectId);
        if (!m) return err('I have nothing indexed for that project.');
        return ok(`${m.facts.length} facts, ${m.inferences.length} inference${m.inferences.length === 1 ? '' : 's'}.`, {
          // Kept in separate buckets so a guess can never be read as a fact.
          facts: Object.fromEntries(m.facts.map((f) => [f.key, f.value])),
          inferences: m.inferences.map((i) => ({ what: i.key, value: i.value, why: i.evidence, confidence: i.strength })),
        });
      },
    },
    {
      name: 'recall_memory',
      description:
        'What the user has explicitly told Wavi to remember — both their standing, app-wide notes and notes attached to a specific project. '
        + 'Each item says where it came from. Read-only, offline. '
        + 'Note: absolute file paths are reduced to the final folder or file name before leaving the app, so quote them as a name, not a full path.',
      parameters: {
        scope: { type: 'string', description: "'global', 'project', or 'both' (default).", required: false },
        projectId: { type: 'string', description: 'Project id for project-scoped memory (defaults to the active project).', required: false },
      },
      execution: 'local',
      run: async (params, ctx) => {
        const rawScope = String(params?.scope ?? 'both').toLowerCase();
        const scope = (rawScope === 'global' || rawScope === 'project' || rawScope === 'both') ? rawScope : 'both';
        const projectId = String(params?.projectId ?? (ctx as BrainToolContext)?.projectId ?? '') || null;

        if (scope === 'project' && !projectId) {
          return err('No project selected — open a project first, or ask for global memory.');
        }
        const out = deps.recallMemory({ projectId, scope });
        const total = out.global.length + out.project.length;
        if (total === 0) {
          // An explicit empty answer, so the model says "nothing is remembered"
          // rather than filling the silence from its own context.
          return ok('Nothing has been explicitly remembered yet.', { global: [], project: [], total: 0 });
        }
        return ok(
          `${total} remembered item${total === 1 ? '' : 's'}` +
          `${out.project.length ? ` (${out.project.length} for this project)` : ''}.`,
          {
            // Kept in separate buckets: a note about one song must not read as
            // a standing preference.
            global: out.global,
            project: out.project,
            total,
          },
        );
      },
    },
    {
      name: 'changed_since_version',
      description: 'Files in a project modified since a published version was created — "what have I changed since I last shared this?". Read-only, offline.',
      parameters: {
        versionId: { type: 'string', description: 'The published version to compare against.', required: true },
        projectId: { type: 'string', description: 'Project id (defaults to the active project).', required: false },
      },
      execution: 'local',
      run: async (params, ctx) => {
        const projectId = String(params?.projectId ?? (ctx as BrainToolContext)?.projectId ?? '');
        const versionId = String(params?.versionId ?? '');
        if (!projectId) return err('No project selected — open a project first.');
        if (!versionId) return err('Tell me which version to compare against.');
        const r = deps.changedSince(projectId, versionId);
        if (!r) return err('I could not find that version for this project.');
        return ok(`${r.files.length} file${r.files.length === 1 ? '' : 's'} changed since that version.`, { since: r.sinceIso, changed: r.files, count: r.files.length });
      },
    },
  ];
}
