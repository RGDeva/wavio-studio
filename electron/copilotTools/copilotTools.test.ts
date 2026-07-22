/**
 * Copilot tool envelope + first-five-tools tests (Phase H). Pure — all
 * implementations injected as fakes; exercises the real envelope and the
 * real tool specs.
 */
import { describe, it, expect, vi } from 'vitest';
import { wrapTool, validateParams, sanitizeArgs, CopilotToolSpec, EnvelopeDeps } from './envelope';
import { buildProjectTools, ProjectToolDeps } from './index';

function fakeEnvelopeDeps(overrides: Partial<EnvelopeDeps> = {}): EnvelopeDeps & { auditLog: any[] } {
  const auditLog: any[] = [];
  return {
    isAuthenticated: () => true,
    logAudit: (e) => auditLog.push(e),
    auditLog,
    ...overrides,
  } as any;
}

function fakeDeps(overrides: Partial<ProjectToolDeps> = {}): ProjectToolDeps & { auditLog: any[] } {
  const base = fakeEnvelopeDeps();
  return {
    ...base,
    searchFiles: () => [],
    openPath: vi.fn(),
    fileExists: () => true,
    getSyncStatus: () => 'idle',
    getQueueCounts: () => ({}),
    prioritizeProject: () => ({ needsConfirmation: false, bumped: 1, requeued: 0, blockedPermanent: 0, skippedMissing: 0 }),
    publishVersion: async () => ({ versionId: 'v1', versionNumber: 3, fileCount: 12 }),
    // P3-3 inspection deps
    revealFileById: () => ({ revealed: true }),
    openFileById: () => ({ opened: true }),
    getVersions: () => [],
    getCapabilities: () => ({ dawType: 'ableton', canRestore: true, canOpen: true, notes: [] }),
    classifyErrors: () => ({ retryable: [], permanent: [], missing: [] }),
    ...overrides,
  } as any;
}

const ctxWithProject = { projectId: 'p1', projectName: 'My Song', filePath: '/proj/My Song.als', dawType: 'ableton', versionCount: 2, lastSyncedAt: null, files: [], cloudProject: null };

function tool(deps: ProjectToolDeps, name: string) {
  const t = buildProjectTools(deps).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not built`);
  return t;
}

describe('envelope: validation', () => {
  it('rejects missing required and wrong-typed params with a typed error', async () => {
    const deps = fakeDeps();
    const search = tool(deps, 'search_files');
    expect((await search.handler({}, null)).error).toContain('Missing required parameter "query"');
    expect((await search.handler({ query: 42 }, null)).error).toContain('must be a string');
    expect(deps.auditLog.map((e) => e.outcome)).toEqual(['invalid_input', 'invalid_input']);
  });
  it('validateParams accepts optional omissions', () => {
    expect(validateParams({ q: { type: 'string', description: '', required: false } }, {})).toBeNull();
  });
});

describe('envelope: permission + confirmation', () => {
  it('publish_version is denied offline/unauthenticated', async () => {
    const deps = fakeDeps({ isAuthenticated: () => false });
    const result = await tool(deps, 'publish_version').handler({}, ctxWithProject);
    expect(result.status).toBe('error');
    expect(result.error).toContain('Sign in');
    expect(deps.auditLog.at(-1).outcome).toBe('denied_unauthenticated');
  });
  it('publish_version without confirmed:true returns needs_confirmation and has NO side effect', async () => {
    const publishVersion = vi.fn();
    const deps = fakeDeps({ publishVersion: publishVersion as any });
    const result = await tool(deps, 'publish_version').handler({}, ctxWithProject);
    expect(result.status).toBe('needs_confirmation');
    expect(result.confirmationSummary).toContain('My Song');
    expect(publishVersion).not.toHaveBeenCalled();
    expect(deps.auditLog.at(-1).outcome).toBe('confirmation_requested');
  });
  it('SECURITY: model-supplied confirmed:true is ignored — still needs_confirmation, no side effect', async () => {
    const publishVersion = vi.fn();
    const deps = fakeDeps({ publishVersion: publishVersion as any });
    const result = await tool(deps, 'publish_version').handler({ confirmed: true }, ctxWithProject);
    expect(result.status).toBe('needs_confirmation');
    expect(publishVersion).not.toHaveBeenCalled();
  });
  it('publish_version runs only via the out-of-band confirmation (renderer card path)', async () => {
    const deps = fakeDeps();
    const result = await tool(deps, 'publish_version').handler({}, ctxWithProject, { confirmedOutOfBand: true });
    expect(result.status).toBe('done');
    expect(result.message).toContain('v3');
    expect(deps.auditLog.at(-1).outcome).toBe('done');
  });
});

describe('envelope: failure containment + audit sanitization', () => {
  it('a throwing implementation becomes {status:error}, never a throw', async () => {
    const deps = fakeDeps({ searchFiles: () => { throw new Error('db exploded'); } });
    const result = await tool(deps, 'search_files').handler({ query: 'x' }, null);
    expect(result.status).toBe('error');
    expect(result.error).toBe('db exploded');
    expect(deps.auditLog.at(-1).outcome).toBe('threw');
  });
  it('audit args are sanitized: secrets dropped, long strings truncated, objects dropped', () => {
    const out = sanitizeArgs({ query: 'x'.repeat(300), authToken: 'wv_secret', nested: { a: 1 }, bpm: 140 });
    expect(out.authToken).toBeUndefined();
    expect(out.nested).toBeUndefined();
    expect((out.query as string).length).toBeLessThan(130);
    expect(out.bpm).toBe(140);
  });
});

describe('local tools work offline (unauthenticated)', () => {
  const offline = () => fakeDeps({ isAuthenticated: () => false });
  it('search_files works offline', async () => {
    const deps = offline();
    deps.searchFiles = () => [{ file_name: 'idea.wav', project_name: 'My Song', bpm: 140, key_note: 'F' }];
    const r = await tool(deps, 'search_files').handler({ query: 'idea' }, null);
    expect(r.status).toBe('done');
    expect(r.message).toContain('idea.wav');
  });
  it('inspect_sync_status works offline and humanizes states', async () => {
    const deps = offline();
    deps.getSyncStatus = () => 'paused:user';
    deps.getQueueCounts = () => ({ pending: 12, failed: 2 });
    const r = await tool(deps, 'inspect_sync_status').handler({}, null);
    expect(r.status).toBe('done');
    expect(r.message).toContain('Paused by you');
    expect(r.message).toContain('12 pending');
  });
  it('sync_project works offline and reports queue movement', async () => {
    const deps = offline();
    const r = await tool(deps, 'sync_project').handler({}, ctxWithProject);
    expect(r.status).toBe('done');
    expect(r.message).toContain('front of the sync queue');
  });
});

describe('tool behaviors', () => {
  it('open_in_daw is gated: no confirmation → needs_confirmation and NO app launch', async () => {
    const deps = fakeDeps();
    const r = await tool(deps, 'open_in_daw').handler({}, ctxWithProject);
    expect(r.status).toBe('needs_confirmation');
    expect(r.confirmationSummary).toContain('external DAW application');
    expect(deps.openPath).not.toHaveBeenCalled();
  });
  it('SECURITY: open_in_daw model-supplied confirmed:true is ignored — still gated, no launch', async () => {
    const deps = fakeDeps();
    const r = await tool(deps, 'open_in_daw').handler({ confirmed: true }, ctxWithProject);
    expect(r.status).toBe('needs_confirmation');
    expect(deps.openPath).not.toHaveBeenCalled();
  });
  it('open_in_daw uses the selected project when confirmed out-of-band', async () => {
    const deps = fakeDeps();
    const r = await tool(deps, 'open_in_daw').handler({}, ctxWithProject, { confirmedOutOfBand: true });
    expect(r.status).toBe('done');
    expect(deps.openPath).toHaveBeenCalledWith('/proj/My Song.als');
  });
  it('open_in_daw errors clearly with no project and no query (after confirm)', async () => {
    const r = await tool(fakeDeps(), 'open_in_daw').handler({}, null, { confirmedOutOfBand: true });
    expect(r.status).toBe('error');
    expect(r.error).toContain('No project selected');
  });
  it('open_in_daw refuses files missing on disk (after confirm)', async () => {
    const deps = fakeDeps({ fileExists: () => false });
    const r = await tool(deps, 'open_in_daw').handler({}, ctxWithProject, { confirmedOutOfBand: true });
    expect(r.status).toBe('error');
    expect(r.error).toContain('moved or deleted');
  });
  it('sync_project surfaces the large-retry confirmation from the D3 contract', async () => {
    const deps = fakeDeps({ prioritizeProject: () => ({ needsConfirmation: true, retryCount: 60 }) });
    const r = await tool(deps, 'sync_project').handler({}, ctxWithProject);
    expect(r.status).toBe('needs_confirmation');
    expect(r.confirmationSummary).toContain('60 failed uploads');
  });
  it('sync_project passes force=true only on the out-of-band confirm path', async () => {
    const calls: any[] = [];
    const deps = fakeDeps({ prioritizeProject: ((id: string, force?: boolean) => { calls.push(force); return { needsConfirmation: false, bumped: 2, requeued: 1, blockedPermanent: 0, skippedMissing: 0 }; }) as any });
    await tool(deps, 'sync_project').handler({}, ctxWithProject);
    await tool(deps, 'sync_project').handler({}, ctxWithProject, { confirmedOutOfBand: true });
    expect(calls).toEqual([false, true]);
  });
  it('sync_project explains missing-file and blocked outcomes honestly', async () => {
    const deps = fakeDeps({ prioritizeProject: () => ({ needsConfirmation: false, bumped: 0, requeued: 0, blockedPermanent: 0, skippedMissing: 3 }) });
    const r = await tool(deps, 'sync_project').handler({}, ctxWithProject);
    expect(r.message).toContain('missing on disk');
  });
});

describe('registry integration', () => {
  it('every built tool carries the envelope (audit on every call)', async () => {
    const deps = fakeDeps();
    const tools = buildProjectTools(deps);
    // Phase-H cloud/sync tools + P3-3 deterministic inspection tools + honest
    // typed declines for server-blocked capabilities.
    expect(tools.map((t) => t.name)).toEqual([
      'search_files', 'open_in_daw', 'inspect_sync_status', 'sync_project', 'publish_version',
      'inspect_project', 'reveal_file', 'open_file', 'inspect_package_completeness', 'inspect_daw_compatibility',
      'list_local_versions', 'explain_project_errors',
      'list_project_links', 'create_project_link', 'revoke_project_link',
      'invite_collaborator', 'inspect_collaborator_activity', 'publish_child_version',
    ]);
    // Every tool (including gated ones returning needs_confirmation) audits once.
    for (const t of tools) await t.handler({ query: 'x' }, ctxWithProject);
    expect(deps.auditLog.length).toBe(tools.length);
  });
  it('external-app + cloud actions are confirmation-required; read-only + blocked ones are not', () => {
    const flags = Object.fromEntries(buildProjectTools(fakeDeps()).map((t) => [t.name, t.confirmationRequired]));
    expect(flags).toEqual({
      search_files: false, open_in_daw: true, inspect_sync_status: false, sync_project: false, publish_version: true,
      inspect_project: false, reveal_file: true, open_file: true, inspect_package_completeness: false,
      inspect_daw_compatibility: false, list_local_versions: false, explain_project_errors: false,
      list_project_links: false, create_project_link: false, revoke_project_link: false,
      invite_collaborator: false, inspect_collaborator_activity: false, publish_child_version: false,
    });
  });
});
