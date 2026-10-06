/**
 * The assistant's single memory-retrieval interface.
 *
 * What these defend: the assistant can reach everything the user explicitly
 * told Wavi, in BOTH scopes, and can always say where each item came from —
 * because "you told me" and "the index worked it out" are different claims and
 * must not be flattened into one.
 */
import { describe, it, expect } from 'vitest';
import { createBrainService, type MemoryRow } from './service';
import { buildBrainToolSpecs, type BrainReadDeps } from '../copilotTools/brainTools';

const T = '2026-10-06T10:00:00.000Z';

function row(over: Partial<MemoryRow> & { key: string; value: string }): MemoryRow {
  return { category: 'note', kind: 'stated', origin: 'user', producer: 'ui', observedAt: T, ...over };
}

function service(store: Record<string, MemoryRow[]>) {
  return createBrainService({
    getRecords: () => ({ projects: [], files: [] }),
    getFactRows: () => [],
    getBelievedFactRow: () => null,
    insertFact: () => {},
    supersedeFact: () => {},
    getProjectPackInput: () => null,
    getActivityInRange: () => [],
    getRecentProjectRows: () => [],
    getRecentFileRows: () => [],
    getFilesChangedSinceVersion: () => null,
    getDeriveInput: () => null,
    listMemoryWithProvenance: (scope) => store[scope ?? '__global__'] ?? [],
    now: () => T,
    newId: () => 'id',
  });
}

describe('recallMemory — both scopes, kept apart', () => {
  const store = {
    __global__: [row({ key: 'style', value: 'keep mixes sparse' })],
    p1: [row({ key: 'bounce-dir', value: 'Sunshine vocals are usually exported to the Bounces folder' })],
  };

  it('returns global and project memory in SEPARATE buckets', () => {
    // Merging them would let a note about one song read as a standing
    // preference, which the assistant would then apply everywhere.
    const out = service(store).recallMemory({ projectId: 'p1' });
    expect(out.global.map((m) => m.key)).toEqual(['style']);
    expect(out.project.map((m) => m.key)).toEqual(['bounce-dir']);
    expect(out.global[0].scope).toBe('global');
    expect(out.project[0].scope).toBe('project');
  });

  it('honours an explicit scope', () => {
    const svc = service(store);
    expect(svc.recallMemory({ projectId: 'p1', scope: 'global' }).project).toEqual([]);
    expect(svc.recallMemory({ projectId: 'p1', scope: 'project' }).global).toEqual([]);
  });

  it('returns only global memory when no project is active', () => {
    const out = service(store).recallMemory({ projectId: null });
    expect(out.global).toHaveLength(1);
    expect(out.project).toEqual([]);
  });

  it('does not leak one project’s memory into another', () => {
    const out = service(store).recallMemory({ projectId: 'p2' });
    expect(out.project).toEqual([]);
    expect(out.global).toHaveLength(1);   // global still applies everywhere
  });

  it('attributes every item in words a person could read back', () => {
    const out = service(store).recallMemory({ projectId: 'p1' });
    expect(out.global[0].attribution).toBe('you told Wavi (via ui)');
  });

  it('labels an agent-recorded memory as such, never as the user speaking', () => {
    // Otherwise the assistant could quote its own earlier note back as the
    // user's instruction.
    const out = service({ __global__: [row({ key: 'k', value: 'v', origin: 'agent', producer: 'copilot' })] })
      .recallMemory({});
    expect(out.global[0].attribution).toBe('recorded by agent (copilot)');
  });

  it('carries the category and timestamp through', () => {
    const out = service({ __global__: [row({ key: 'k', value: 'v', category: 'context' })] }).recallMemory({});
    expect(out.global[0]).toMatchObject({ category: 'context', observedAt: T });
  });
});

// ── The tool the assistant actually calls ───────────────────────────────────

function toolDeps(over: Partial<BrainReadDeps> = {}): BrainReadDeps {
  return {
    search: () => ({ empty: true, hits: [], byProject: [], query: { uninterpreted: [] } }),
    findFiles: () => ({ empty: true, hits: [], byProject: [], query: { uninterpreted: [] } }),
    recentActivity: () => ({ range: null, events: [] }),
    recentProjects: () => ({ range: null, projects: [] }),
    projectMemory: () => null,
    changedSince: () => null,
    recallMemory: () => ({ global: [], project: [], projectId: null }),
    ...over,
  };
}
const tools = (d: BrainReadDeps) => Object.fromEntries(buildBrainToolSpecs(d).map((t) => [t.name, t]));

describe('recall_memory tool', () => {
  const sample = {
    global: [{ key: 'style', value: 'keep mixes sparse', category: 'note', scope: 'global', attribution: 'you told Wavi (via ui)', observedAt: T }],
    project: [{ key: 'bounce-dir', value: 'vocals go to the Bounces folder', category: 'note', scope: 'project', attribution: 'you told Wavi (via ui)', observedAt: T }],
    projectId: 'p1',
  };

  it('is registered, read-only and offline', () => {
    const t = tools(toolDeps()).recall_memory;
    expect(t).toBeTruthy();
    expect(t.execution).toBe('local');
    expect(t.requiresConfirmation ?? false).toBe(false);
  });

  it('returns both buckets with a readable summary', async () => {
    const res: any = await tools(toolDeps({ recallMemory: () => sample })).recall_memory.run({}, { projectId: 'p1' });
    expect(res.status).toBe('done');
    expect(res.data.total).toBe(2);
    expect(res.data.global[0].value).toContain('sparse');
    expect(res.data.project[0].value).toContain('Bounces');
    expect(res.message).toContain('1 for this project');
  });

  it('says plainly when nothing is remembered', async () => {
    // An explicit empty answer, so the model reports "nothing remembered"
    // instead of filling the silence from its own context.
    const res: any = await tools(toolDeps()).recall_memory.run({}, null);
    expect(res.status).toBe('done');
    expect(res.data.total).toBe(0);
    expect(res.message).toMatch(/Nothing has been explicitly remembered/);
  });

  it('asks for a project when project scope is requested without one', async () => {
    const res: any = await tools(toolDeps()).recall_memory.run({ scope: 'project' }, null);
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/No project selected/);
  });

  it('falls back to "both" on an unrecognised scope rather than failing', async () => {
    let seen: any = null;
    const d = toolDeps({ recallMemory: (o) => { seen = o; return sample; } });
    await tools(d).recall_memory.run({ scope: 'nonsense' }, { projectId: 'p1' });
    expect(seen.scope).toBe('both');
  });

  it('uses the active project when none is named', async () => {
    let seen: any = null;
    const d = toolDeps({ recallMemory: (o) => { seen = o; return sample; } });
    await tools(d).recall_memory.run({}, { projectId: 'p9' });
    expect(seen.projectId).toBe('p9');
  });

  it('adds no mutation capability', () => {
    // The memory interface is retrieval only; writing stays on the existing
    // approved paths.
    const names = Object.keys(tools(toolDeps()));
    expect(names).toContain('recall_memory');
    for (const n of names) expect(n).not.toMatch(/delete|remove|write|forget|set_/);
  });
});
