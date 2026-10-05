/**
 * Assistant ↔ Project Brain integration.
 *
 * What these defend: the model asks, the brain answers, and the brain's answer
 * comes from deterministic local state. A tool that guessed, computed its own
 * time window, or returned a path would break that contract.
 */
import { describe, it, expect } from 'vitest';
import { buildBrainToolSpecs, type BrainReadDeps } from './brainTools';

function hit(id: string, name: string, project = 'Sunshine') {
  return {
    record: { id, kind: 'file', name, projectId: 'p1', projectName: project, role: 'audio', modifiedAt: '2026-10-01T00:00:00.000Z' },
    score: 40, matchedOn: [`"${name}" in name`],
  };
}

function deps(over: Partial<BrainReadDeps> = {}): BrainReadDeps {
  const base: BrainReadDeps = {
    search: () => ({ empty: false, hits: [hit('f1', 'vocal.wav')], byProject: [{ projectId: 'p1', projectName: 'Sunshine', hits: [] }], query: { uninterpreted: [] } }),
    findFiles: () => ({ empty: false, hits: [hit('f1', 'vocal.wav')], byProject: [], query: { uninterpreted: [] } }),
    recentActivity: () => ({ range: { from: '2026-10-07T00:00:00.000Z', to: '2026-10-07T23:59:59.999Z', label: 'yesterday' }, events: [] }),
    recentProjects: () => ({ range: { from: 'a', to: 'b', label: 'this week' }, projects: [{ id: 'p1', name: 'Sunshine', dawType: 'fl-studio', syncStatus: 'synced', modifiedAt: '2026-10-01T00:00:00.000Z' }] }),
    projectMemory: () => ({
      facts: [{ key: 'file-count', value: '4' }, { key: 'changed-since-publish', value: 'yes' }],
      inferences: [{ key: 'likely-master', value: 'master-v7.wav', evidence: 'only master-like file', strength: 'strong' }],
    }),
    changedSince: () => ({ sinceIso: '2026-10-02T00:00:00.000Z', files: [{ id: 'f1', name: 'master-v7.wav', role: 'audio', modifiedAt: '2026-10-06T00:00:00.000Z', syncStatus: 'pending' }] }),
    ...over,
  };
  return base;
}

const tools = (d = deps()) => Object.fromEntries(buildBrainToolSpecs(d).map((t) => [t.name, t]));

describe('the tool surface stays read-only', () => {
  it('exposes exactly the expected read tools', () => {
    expect(Object.keys(tools()).sort()).toEqual([
      'changed_since_version', 'find_files', 'project_memory',
      'recent_activity', 'recent_projects', 'search_music_library',
    ]);
  });

  it('every tool is local, offline and needs no confirmation', () => {
    // Read-only means no approval gate is needed — and equally, nothing here
    // may ever mutate, which is what keeps that true.
    for (const t of buildBrainToolSpecs(deps())) {
      expect(t.execution).toBe('local');
      expect(t.requiresConfirmation ?? false).toBe(false);
    }
  });
});

describe('search', () => {
  it('returns matches with the reason each one matched', () => {
    // The model must be able to say WHY, without re-deriving it.
    const r: any = tools().search_music_library.run({ query: 'vocal' }, null);
    return r.then((res: any) => {
      expect(res.status).toBe('done');
      expect(res.data.matches[0]).toMatchObject({ name: 'vocal.wav', project: 'Sunshine' });
      expect(res.data.matches[0].why[0]).toContain('vocal');
    });
  });

  it('refuses an empty query rather than returning the library', async () => {
    const res: any = await tools().search_music_library.run({ query: '   ' }, null);
    expect(res.status).toBe('error');
  });

  it('tells the caller when a query had nothing to match on', async () => {
    const d = deps({ search: () => ({ empty: true, hits: [], byProject: [], query: { uninterpreted: [] } }) });
    const res: any = await tools(d).search_music_library.run({ query: ':::' }, null);
    expect(res.status).toBe('error');
  });

  it('surfaces the part of a query it could not interpret', async () => {
    // Silently dropping it would answer a different question than was asked.
    const d = deps({ search: () => ({ empty: false, hits: [], byProject: [], query: { uninterpreted: ['bpm:fast'] } }) });
    const res: any = await tools(d).search_music_library.run({ query: 'x bpm:fast' }, null);
    expect(res.data.notInterpreted).toEqual(['bpm:fast']);
  });

  it('find_files returns files only', async () => {
    const res: any = await tools().find_files.run({ query: 'vocal' }, null);
    expect(res.data.files[0].name).toBe('vocal.wav');
    expect(res.data).not.toHaveProperty('projectsMatched');
  });
});

describe('time-ranged questions', () => {
  it('returns the resolved window alongside the events', async () => {
    // "Nothing changed yesterday" needs the window to be stated, or an empty
    // list is ambiguous.
    const res: any = await tools().recent_activity.run({ range: 'yesterday' }, null);
    expect(res.data).toMatchObject({ range: 'yesterday', count: 0 });
    expect(res.data.from).toBe('2026-10-07T00:00:00.000Z');
  });

  it('rejects a range it does not understand, and says what it accepts', async () => {
    const d = deps({ recentActivity: () => ({ range: null, events: [] }) });
    const res: any = await tools(d).recent_activity.run({ range: 'whenever' }, null);
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/today|this-week/);
  });

  it('lists recently touched projects', async () => {
    const res: any = await tools().recent_projects.run({ range: 'this-week' }, null);
    expect(res.data.projects[0].name).toBe('Sunshine');
  });
});

describe('project memory keeps facts and inferences apart', () => {
  it('returns facts as a map and inferences as labelled guesses', async () => {
    // The split is the whole point: a model must not read "probably the
    // master" with the same authority as a file count.
    const res: any = await tools().project_memory.run({ projectId: 'p1' }, null);
    expect(res.data.facts).toMatchObject({ 'file-count': '4', 'changed-since-publish': 'yes' });
    expect(res.data.inferences[0]).toMatchObject({
      what: 'likely-master', value: 'master-v7.wav', confidence: 'strong',
    });
    expect(res.data.inferences[0].why).toBeTruthy();
    expect(res.data.facts).not.toHaveProperty('likely-master');
  });

  it('uses the active project when none is named', async () => {
    const res: any = await tools().project_memory.run({}, { projectId: 'p1' });
    expect(res.status).toBe('done');
  });

  it('asks for a project rather than guessing one', async () => {
    const res: any = await tools().project_memory.run({}, null);
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/No project selected/);
  });

  it('says so when nothing is indexed', async () => {
    const res: any = await tools(deps({ projectMemory: () => null })).project_memory.run({ projectId: 'ghost' }, null);
    expect(res.status).toBe('error');
  });
});

describe('changed since a published version', () => {
  it('reports the comparison point and what moved', async () => {
    const res: any = await tools().changed_since_version.run({ projectId: 'p1', versionId: 'v4' }, null);
    expect(res.data).toMatchObject({ since: '2026-10-02T00:00:00.000Z', count: 1 });
    expect(res.data.changed[0].name).toBe('master-v7.wav');
  });

  it('requires a version rather than assuming the latest', async () => {
    const res: any = await tools().changed_since_version.run({ projectId: 'p1' }, null);
    expect(res.status).toBe('error');
  });

  it('reports an unknown version honestly', async () => {
    const res: any = await tools(deps({ changedSince: () => null }))
      .changed_since_version.run({ projectId: 'p1', versionId: 'nope' }, null);
    expect(res.status).toBe('error');
  });
});

describe('nothing leaks a filesystem path', () => {
  it('search results carry names, never paths', async () => {
    const d = deps({
      search: () => ({
        empty: false,
        hits: [{ record: { id: 'f1', kind: 'file', name: 'vocal.wav', projectId: 'p1', projectName: 'Sunshine', role: 'audio', modifiedAt: null }, score: 1, matchedOn: [] }],
        byProject: [], query: { uninterpreted: [] },
      }),
    });
    const res: any = await tools(d).search_music_library.run({ query: 'vocal' }, null);
    expect(JSON.stringify(res)).not.toMatch(/\/Users\//);
  });
});
