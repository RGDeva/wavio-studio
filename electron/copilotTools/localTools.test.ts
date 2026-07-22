/**
 * P3-3 deterministic local assistant tools — envelope + safety tests.
 * Pure: all deps injected as fakes; exercises the real envelope and specs.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildProjectTools, type ProjectToolDeps } from './index';
import {
  resolveToolProjectContext, redactPath, derivePackageCompleteness,
  deriveErrorExplanation, deriveInspectProject,
} from './localTools';
import type { ProjectContext, ProjectFile } from '../copilotTypes';

function file(o: Partial<ProjectFile> = {}): ProjectFile {
  return {
    id: 'f1', fileName: 'Song.als', fileType: 'als', fileSize: 100, role: 'project',
    bpm: null, keyNote: null, syncStatus: 'synced', cloudUrl: null, ...o,
  };
}

function ctx(o: Partial<ProjectContext> = {}): ProjectContext {
  return {
    projectId: 'p1', projectName: 'My Song', dawType: 'ableton', filePath: '/proj/My Song.als',
    versionCount: 2, lastSyncedAt: null, files: [file(), file({ id: 'f2', fileName: 'mix.wav', role: 'master' })],
    cloudProject: null, ...o,
  };
}

function fakeDeps(over: Partial<ProjectToolDeps> = {}): ProjectToolDeps & { auditLog: any[] } {
  const auditLog: any[] = [];
  return {
    isAuthenticated: () => true,
    logAudit: (e) => auditLog.push(e),
    searchFiles: () => [],
    openPath: vi.fn(),
    fileExists: () => true,
    getSyncStatus: () => 'idle',
    getQueueCounts: () => ({}),
    prioritizeProject: () => ({ needsConfirmation: false, bumped: 0, requeued: 0, blockedPermanent: 0, skippedMissing: 0 }),
    publishVersion: async () => ({ versionId: 'v1', versionNumber: 1, fileCount: 1 }),
    revealFileById: vi.fn(() => ({ revealed: true })),
    openFileById: vi.fn(() => ({ opened: true })),
    getVersions: () => [{ version_number: 1, created_at: '2026-07-01T00:00:00Z', file_count: 3 }],
    getCapabilities: () => ({ dawType: 'Ableton Live', canRestore: true, canOpen: true, notes: [] }),
    classifyErrors: () => ({ retryable: [], permanent: [], missing: [] }),
    auditLog,
    ...over,
  } as any;
}

function tool(deps: ProjectToolDeps, name: string) {
  const t = buildProjectTools(deps).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not built`);
  return t;
}

describe('project-context resolution', () => {
  it('explicit context: a tool acts on the resolved active project', async () => {
    const r = await tool(fakeDeps(), 'inspect_project').handler({}, ctx());
    expect(r.status).toBe('done');
    expect(r.projectId).toBe('p1');
    expect(r.message).toContain('My Song');
  });

  it('stale project-switch: params.projectId ≠ active project → discarded, nothing acted on', async () => {
    const reveal = vi.fn(() => ({ revealed: true }));
    // Model targeted p_old; the active context is now p1 (user switched).
    const r = await tool(fakeDeps({ revealFileById: reveal }), 'reveal_file')
      .handler({ fileName: 'Song.als', projectId: 'p_old' }, ctx({ projectId: 'p1' }), { confirmedOutOfBand: true });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/active project changed/i);
    expect(reveal).not.toHaveBeenCalled(); // no side effect on the wrong project
  });

  it('missing project context → typed no_project_selected error', async () => {
    const r = await tool(fakeDeps(), 'inspect_project').handler({}, ctx({ projectId: null }));
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/no project selected/i);
  });

  it('resolveToolProjectContext is pure and total', () => {
    expect(resolveToolProjectContext(null).ok).toBe(false);
    expect(resolveToolProjectContext(ctx(), 'p1').ok).toBe(true);
    const stale = resolveToolProjectContext(ctx({ projectId: 'p1' }), 'p2');
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('stale_project_switch');
  });
});

describe('no fabricated success / honest blocked states', () => {
  it('server-blocked tools return a typed blockedReason, never a success', async () => {
    for (const name of ['create_project_link', 'revoke_project_link', 'invite_collaborator', 'publish_child_version', 'list_project_links', 'inspect_collaborator_activity']) {
      const r = await tool(fakeDeps(), name).handler({}, ctx());
      expect(r.status, name).toBe('error');
      expect(r.blockedReason, name).toBe('server_contract_pending');
    }
  });

  it('reveal on a missing-on-disk file fails honestly (no fake reveal)', async () => {
    const r = await tool(fakeDeps({ revealFileById: () => ({ revealed: false, missingOnDisk: true }) }), 'reveal_file')
      .handler({ fileName: 'Song.als' }, ctx(), { confirmedOutOfBand: true });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/moved or deleted/i);
  });
});

describe('confirmation enforcement (reveal launches Finder)', () => {
  it('reveal_file is gated: without out-of-band confirmation it does NOT reveal', async () => {
    const reveal = vi.fn(() => ({ revealed: true }));
    const r = await tool(fakeDeps({ revealFileById: reveal }), 'reveal_file').handler({ fileName: 'Song.als' }, ctx());
    expect(r.status).toBe('needs_confirmation');
    expect(reveal).not.toHaveBeenCalled();
  });

  it('a model-provided confirmed:true is ignored — the gate still holds', async () => {
    const reveal = vi.fn(() => ({ revealed: true }));
    // `confirmed` in params is model output; the envelope strips it.
    const r = await tool(fakeDeps({ revealFileById: reveal }), 'reveal_file').handler({ fileName: 'Song.als', confirmed: true }, ctx());
    expect(r.status).toBe('needs_confirmation');
    expect(reveal).not.toHaveBeenCalled();
  });

  it('only the out-of-band confirmation (confirmedOutOfBand) runs the reveal', async () => {
    const reveal = vi.fn(() => ({ revealed: true }));
    const r = await tool(fakeDeps({ revealFileById: reveal }), 'reveal_file')
      .handler({ fileName: 'Song.als' }, ctx(), { confirmedOutOfBand: true });
    expect(r.status).toBe('done');
    expect(reveal).toHaveBeenCalledWith('p1', 'f1');
  });

  it('read-only inspection tools require NO confirmation', () => {
    const deps = fakeDeps();
    for (const name of ['inspect_project', 'inspect_package_completeness', 'inspect_daw_compatibility', 'list_local_versions', 'explain_project_errors']) {
      const t = buildProjectTools(deps).find((x) => x.name === name)!;
      expect(t.confirmationRequired, name).toBe(false);
    }
  });
});

describe('raw-path redaction', () => {
  it('redactPath reduces any absolute path to a basename', () => {
    expect(redactPath('/Users/someone/Music/My Song.als')).toBe('My Song.als');
    expect(redactPath('C:\\Users\\me\\beat.flp')).toBe('beat.flp');
    expect(redactPath(null)).toBe('(unknown)');
  });

  it('no local tool result contains an absolute path', async () => {
    const deps = fakeDeps();
    for (const name of ['inspect_project', 'reveal_file', 'inspect_package_completeness', 'inspect_daw_compatibility', 'list_local_versions', 'explain_project_errors']) {
      const t = buildProjectTools(deps).find((x) => x.name === name)!;
      const r = await t.handler({ fileName: 'Song.als' }, ctx(), { confirmedOutOfBand: true });
      const blob = JSON.stringify(r);
      expect(blob, name).not.toMatch(/\/Users\/|\/proj\/|[A-Z]:\\/);
    }
  });
});

describe('deterministic derivations', () => {
  it('package completeness: complete when DAW file + audio present and all synced', () => {
    const pkg = derivePackageCompleteness([file(), file({ id: 'f2', role: 'master', fileName: 'm.wav' })]);
    expect(pkg).toMatchObject({ complete: true, hasProjectFile: true, hasAudio: true, unsyncedCount: 0 });
  });

  it('package completeness: missing + unsynced files are reported (basenames only)', () => {
    const pkg = derivePackageCompleteness([
      file({ syncStatus: 'missing', fileName: '/abs/lost.wav' }),
      file({ id: 'f3', syncStatus: 'pending', role: 'audio', fileName: 'wip.wav' }),
    ]);
    expect(pkg.complete).toBe(false);
    expect(pkg.unsyncedCount).toBe(1);
    expect(pkg.missingFiles).toEqual(['lost.wav']); // basename, not the abs path
  });

  it('compatibility result surfaces restore/open capability', async () => {
    const r = await tool(fakeDeps({ getCapabilities: () => ({ dawType: 'Ableton Live', canRestore: true, canOpen: false, notes: ['Cross-DAW reconstruction is not supported.'] }) }), 'inspect_daw_compatibility').handler({}, ctx());
    expect(r.status).toBe('done');
    expect(r.message).toMatch(/restore supported/i);
    expect(r.message).toMatch(/open not supported/i);
  });

  it('explain errors classifies transient / permanent / missing', () => {
    const ex = deriveErrorExplanation({ retryable: ['a', 'b'], permanent: ['c'], missing: ['d'] });
    expect(ex).toMatchObject({ retryable: 2, permanent: 1, missing: 1 });
    expect(ex.headline).toMatch(/4 sync error/);
    expect(deriveErrorExplanation({ retryable: [], permanent: [], missing: [] }).headline).toMatch(/no sync errors/i);
  });

  it('inspect derivation counts roles + sync states', () => {
    const ins = deriveInspectProject({ ok: true, projectId: 'p1', projectName: 'X', dawType: 'ableton', versionCount: 2, files: [file(), file({ id: 'f2', role: 'master', syncStatus: 'missing' })] });
    expect(ins.fileCount).toBe(2);
    expect(ins.missingCount).toBe(1);
    expect(ins.byRole).toMatchObject({ project: 1, master: 1 });
  });
});

describe('offline & error normalization', () => {
  it('inspection tools work with no auth (offline/local) — never fabricate cloud data', async () => {
    const r = await tool(fakeDeps({ isAuthenticated: () => false }), 'inspect_sync_status').handler({}, ctx());
    expect(r.status).toBe('done'); // local tool, unaffected by auth
  });

  it('a throwing dep is contained as a typed error, never an exception', async () => {
    const r = await tool(fakeDeps({ getVersions: () => { throw new Error('db boom'); } }), 'list_local_versions').handler({}, ctx());
    expect(r.status).toBe('error');
    expect(r.error).toBe('db boom');
  });
});
