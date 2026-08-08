/**
 * P3-3 assistant safety-hardening tests. Covers the three audit gaps:
 *   1. no implicit projects[0] fallback / explicit project context
 *   2. no confirmation bypass (static registry + envelope)
 *   3. no model-visible raw absolute paths
 * Pure: deps injected as fakes; exercises the real envelope + registry.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeToolResult, redactPathsInText, basename, type CopilotToolResult,
} from './envelope';
import { buildProjectTools, type ProjectToolDeps } from './index';
import { TOOL_REGISTRY } from '../agentLoop';
import type { ProjectContext, ProjectFile } from '../copilotTypes';

function file(o: Partial<ProjectFile> = {}): ProjectFile {
  return { id: 'f1', fileName: 'Song.als', fileType: 'als', fileSize: 1, role: 'project', bpm: null, keyNote: null, syncStatus: 'synced', cloudUrl: null, ...o };
}
function ctx(o: Partial<ProjectContext> = {}): ProjectContext {
  return { projectId: 'p1', projectName: 'My Song', dawType: 'ableton', filePath: '/proj/My Song.als', versionCount: 1, lastSyncedAt: null, files: [file()], cloudProject: null, ...o };
}
function fakeDeps(over: Partial<ProjectToolDeps> = {}): ProjectToolDeps {
  return {
    isAuthenticated: () => true, logAudit: () => {},
    searchFiles: () => [], openPath: vi.fn(), fileExists: () => true,
    getSyncStatus: () => 'idle', getQueueCounts: () => ({}),
    prioritizeProject: () => ({ needsConfirmation: false, bumped: 0, requeued: 0, blockedPermanent: 0, skippedMissing: 0 }),
    publishVersion: async () => ({ versionId: 'v1', versionNumber: 1, fileCount: 1 }),
    revealFileById: vi.fn(() => ({ revealed: true })),
    openFileById: vi.fn(() => ({ opened: true })),
    getVersions: () => [], getCapabilities: () => ({ dawType: 'ableton', canRestore: true, canOpen: true, notes: [] }),
    classifyErrors: () => ({ retryable: [], permanent: [], missing: [] }),
    projectLinks: {
      listProjectLinksSafe: async () => ({ kind: 'ok', links: [], pageComplete: true, reconciliationNeeded: 0 }),
      createProjectLinkSafe: async () => ({ kind: 'failure', reason: 'offline' }),
      revokeProjectLinkSafe: async () => ({ kind: 'failure', reason: 'offline' }),
    },
    ...over,
  } as any;
}
function tool(deps: ProjectToolDeps, name: string) {
  const t = buildProjectTools(deps).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not built`);
  return t;
}

describe('Gap 1 — no implicit project fallback', () => {
  it('(1) project-sensitive tools do not fall back to any default when context is empty', async () => {
    // No project in context AND no projectId param → typed fail-closed, not a silent pick.
    for (const name of ['inspect_project', 'inspect_package_completeness', 'list_local_versions', 'explain_project_errors']) {
      const r = await tool(fakeDeps(), name).handler({}, ctx({ projectId: null }));
      expect(r.status, name).toBe('error');
      expect(r.error, name).toMatch(/no project selected/i);
    }
  });

  it('(2) missing project context fails closed for side-effecting tools too (no default open)', async () => {
    const open = vi.fn(() => ({ opened: true }));
    const r = await tool(fakeDeps({ openFileById: open }), 'open_file')
      .handler({ fileName: 'Song.als' }, ctx({ projectId: null }), { confirmedOutOfBand: true });
    expect(r.status).toBe('error');
    expect(open).not.toHaveBeenCalled();
  });

  it('(3) stale project switch prevents any side effect', async () => {
    const open = vi.fn(() => ({ opened: true }));
    const r = await tool(fakeDeps({ openFileById: open }), 'open_file')
      .handler({ fileName: 'Song.als', projectId: 'p_old' }, ctx({ projectId: 'p_now' }), { confirmedOutOfBand: true });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/active project changed/i);
    expect(open).not.toHaveBeenCalled();
  });

  it('(9) a file from another project is rejected (open only resolves active-project files)', async () => {
    const open = vi.fn(() => ({ opened: true }));
    // The requested file is NOT among the active project's files.
    const r = await tool(fakeDeps({ openFileById: open }), 'open_file')
      .handler({ fileName: 'someone-elses-track.wav' }, ctx({ files: [file()] }), { confirmedOutOfBand: true });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/no file named/i);
    expect(open).not.toHaveBeenCalled();
  });

  it('(10) a malformed / foreign file resolves to nothing and fails closed', async () => {
    const open = vi.fn(() => ({ opened: false, notFound: true }));
    // Name matches an active-project file, but main reports it is gone → fail closed.
    const r = await tool(fakeDeps({ openFileById: open }), 'open_file')
      .handler({ fileName: 'Song.als' }, ctx(), { confirmedOutOfBand: true });
    expect(r.status).toBe('error');
  });
});

describe('Gap 2 — no confirmation bypass', () => {
  it('(4) the unsafe static reveal duplicate no longer exists in the registry', () => {
    const names = TOOL_REGISTRY.map((t) => t.name);
    expect(names).not.toContain('reveal_local_file');
    expect(names).not.toContain('reveal_project_folder');
  });

  it('(5) the unsafe static open duplicate no longer exists in the registry', () => {
    expect(TOOL_REGISTRY.map((t) => t.name)).not.toContain('open_local_file');
  });

  it('(6) model-emitted confirmed/approved fields are ignored — open stays gated', async () => {
    const open = vi.fn(() => ({ opened: true }));
    for (const forged of [{ confirmed: true }, { approved: true }, { confirmedOutOfBand: true }]) {
      const r = await tool(fakeDeps({ openFileById: open }), 'open_file').handler({ fileName: 'Song.als', ...forged }, ctx());
      expect(r.status).toBe('needs_confirmation');
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('(7) trusted out-of-band confirmation runs the (project-scoped) open', async () => {
    const open = vi.fn(() => ({ opened: true }));
    const r = await tool(fakeDeps({ openFileById: open }), 'open_file')
      .handler({ fileName: 'Song.als' }, ctx(), { confirmedOutOfBand: true });
    expect(r.status).toBe('done');
    expect(open).toHaveBeenCalledWith('p1', 'f1'); // opaque id, main resolves path
  });

  it('(8) file id is resolved in the main process (dep receives id, tool never sees a path)', async () => {
    const open = vi.fn((_projectId: string, _fileId: string) => ({ opened: true }));
    await tool(fakeDeps({ openFileById: open }), 'open_file').handler({ fileName: 'Song.als' }, ctx(), { confirmedOutOfBand: true });
    const [, fileIdArg] = open.mock.calls[0];
    expect(fileIdArg).toBe('f1');
  });

  it('(13) duplicate legacy names cannot expose an unsafe path — every registry tool with a name is unique', () => {
    const names = TOOL_REGISTRY.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate aliases
  });

  it('(14) read-only inspection tools remain confirmation-free', () => {
    const flags = Object.fromEntries(buildProjectTools(fakeDeps()).map((t) => [t.name, t.confirmationRequired]));
    for (const name of ['inspect_project', 'inspect_package_completeness', 'inspect_daw_compatibility', 'list_local_versions', 'explain_project_errors', 'search_files', 'inspect_sync_status']) {
      expect(flags[name], name).toBe(false);
    }
    // External-launch tools stay gated.
    for (const name of ['open_file', 'reveal_file', 'open_in_daw', 'publish_version']) {
      expect(flags[name], name).toBe(true);
    }
  });
});

describe('Gap 3 — no model-visible raw paths', () => {
  it('sanitizeToolResult drops filePath and redacts message/error/data', () => {
    const dirty: CopilotToolResult = {
      status: 'done', message: 'Opening /Users/me/Music/beat.wav now',
      error: undefined, filePath: '/Users/me/Music/beat.wav',
      data: { file_path: '/Users/me/x.als', nested: { path: 'C:\\Users\\me\\y.flp' }, name: 'beat.wav' },
    };
    const clean = sanitizeToolResult(dirty);
    expect(clean.filePath).toBeUndefined();
    expect(clean.message).toBe('Opening beat.wav now');
    expect(JSON.stringify(clean)).not.toMatch(/\/Users\/|C:\\/);
    expect((clean.data as any).file_path).toBe('x.als');
    expect((clean.data as any).nested.path).toBe('y.flp');
  });

  it('(11) no model-visible result contains an absolute path — across every built tool', async () => {
    const deps = fakeDeps({ getVersions: () => [{ version_number: 1, created_at: '2026-07-01', file_count: 2 }] });
    for (const t of buildProjectTools(deps)) {
      const r = await t.handler({ fileName: 'Song.als', query: 'x' }, ctx(), { confirmedOutOfBand: true });
      expect(JSON.stringify(r), t.name).not.toMatch(/\/Users\/|\/proj\/|[A-Za-z]:\\/);
    }
  });

  it('(12) errors never contain an absolute path', () => {
    const r = sanitizeToolResult({ status: 'error', error: 'File "/Users/me/secret path/track.wav" was moved.' });
    expect(r.error).not.toMatch(/\/Users\//);
    expect(r.error).toContain('track.wav');
  });

  it('redactPathsInText + basename are pure helpers', () => {
    expect(basename('/a/b/c.wav')).toBe('c.wav');
    expect(redactPathsInText('at /x/y/z.als and C:\\p\\q.flp')).toBe('at z.als and q.flp');
    expect(redactPathsInText('no paths here')).toBe('no paths here');
  });
});
