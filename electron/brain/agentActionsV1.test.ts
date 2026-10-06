/**
 * Agent Actions v1 — the full pipeline, including the golden paths.
 *
 * What these defend is not usefulness but containment: the agent cannot reach
 * a capability it was not given, cannot act on an entity it was not shown,
 * cannot invent a canonical id, cannot grant itself permission, and cannot
 * cause a mutation without a human approving that exact proposal.
 *
 * The execution tests drive the REAL `create_project_link` tool, built through
 * the real registry with the authoritative service injected as a fake. A test
 * that mocked the tool boundary itself would prove only that this file agrees
 * with itself.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildProjectTools, type ProjectToolDeps } from '../copilotTools/index';
import type { AssistantCreateResult, AssistantListResult, AssistantRevokeResult } from '../copilotTools/localTools';
import { toAssistantSafeLink } from '../assistantLinkRefs';
import { buildAssistantContext, type AssistantContextInput } from './assistantContext';
import { parseActionProposal } from './actionSchema';
import { resolveProjectTarget, resolveLatestVersion, extractProjectName } from './actionResolution';
import { authorizeAction, OWNER_AUTHORIZATION } from './actionAuthorization';
import { detectUnsupportedIntent } from './actionIntent';
import { createProposalStore } from './proposalStore';
import { planAgentAction, inferProposalFromRequest } from './actionPlanner';
import { executeConfirmedProposal } from './actionExecution';
import { ACTION_ALLOWLIST, describeOutcome } from './agentActions';
import { coalesceActivity, summarizeActivity } from './activityView';
import { redactPathsInText } from '../copilotTools/envelope';

const NOW = '2026-10-06T12:00:00.000Z';

// ── Fixture: Sunshine, versions v7 and v8 (§15) ─────────────────────────────
const SUNSHINE = { id: 'p-sun', name: 'Sunshine', dawType: 'fl-studio' };
const VERSIONS = [
  { id: 'ver-7', versionNumber: 7, publishedAt: '2026-09-01T00:00:00Z' },
  { id: 'ver-8', versionNumber: 8, publishedAt: '2026-10-01T00:00:00Z' },
];

function ctx(over: Partial<AssistantContextInput> = {}) {
  return buildAssistantContext({
    query: '', project: SUNSHINE,
    memory: [], facts: [], inferences: [], versions: [], recentActivity: [],
    files: [
      { id: 'f1', name: 'Sunshine.flp', role: 'project', status: 'synced', modifiedAt: NOW },
      { id: 'f2', name: 'master-v8.wav', role: 'audio', status: 'synced', modifiedAt: NOW },
    ],
    now: NOW, ...over,
  });
}
const NO_PROJECT_CTX = () => buildAssistantContext({
  query: '', project: null, memory: [], facts: [], inferences: [],
  files: [], versions: [], recentActivity: [], now: NOW,
});

// ── The real tool, with the authoritative service faked ─────────────────────
const SAFE_LINK = toAssistantSafeLink('plink_00000001', {
  project_id: 'p-sun', version_id: 'ver-8', allow_download: 0, collaborator_mode: 'view',
  created_at: NOW, expires_at: null, revoked_at: null,
}, 'server-confirmed');

function toolDeps(createSpy?: any): ProjectToolDeps {
  return {
    isAuthenticated: () => true, logAudit: () => {},
    searchFiles: () => [], openPath: vi.fn(), fileExists: () => true,
    getSyncStatus: () => 'idle', getQueueCounts: () => ({}),
    prioritizeProject: () => ({ needsConfirmation: false, bumped: 0, requeued: 0, blockedPermanent: 0, skippedMissing: 0 }),
    publishVersion: async () => ({ versionId: 'ver-9', versionNumber: 9, fileCount: 1 }),
    revealFileById: () => ({ revealed: true }), openFileById: () => ({ opened: true }),
    getVersions: () => [], getCapabilities: () => null,
    classifyErrors: () => ({ retryable: [], permanent: [], missing: [] }),
    projectLinks: {
      listProjectLinksSafe: async (): Promise<AssistantListResult> => ({ kind: 'ok', links: [], pageComplete: true, reconciliationNeeded: 0 }),
      createProjectLinkSafe: createSpy ?? (async (): Promise<AssistantCreateResult> => ({ kind: 'created', link: SAFE_LINK })),
      revokeProjectLinkSafe: async (): Promise<AssistantRevokeResult> => ({ kind: 'revoked', ref: 'x', alreadyRevoked: false }),
    },
    multiplayer: {
      resolveInviteTargetSafe: async () => ({ kind: 'unresolved' as const }),
      inviteCollaboratorSafe: async () => ({ kind: 'failure' as const, reason: 'offline' as const }),
      listActivitySafe: async () => ({ kind: 'ok' as const, events: [], pageComplete: true, skippedUnknownEvents: 0 }),
      publishChildVersionSafe: async () => ({ kind: 'failure' as const, reason: 'offline' as const }),
    },
  } as any;
}

function registry(createSpy?: any) {
  const tools = buildProjectTools(toolDeps(createSpy));
  return (name: string) => tools.find((t) => t.name === name) ?? null;
}

function store(clock = () => new Date(NOW)) {
  let n = 0;
  return createProposalStore({ now: clock, newId: () => `prop_${++n}` });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('§3 proposal schema — structured only, fail closed', () => {
  it('accepts the canonical envelope', () => {
    const r = parseActionProposal({
      tool: 'create_project_link', version: 1,
      arguments: { allowDownload: false }, reason: 'You asked to share Sunshine.', evidence: ['A1'],
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.arguments).toEqual({ allowDownload: false });
  });

  it('accepts "params" as the alias already in the response contract', () => {
    const r = parseActionProposal({ tool: 'inspect_project', params: {} });
    expect(r.ok).toBe(true);
  });

  it('refuses a proposal that sets BOTH arguments and params', () => {
    // A contradiction; resolving it in either direction would be a guess.
    const r = parseActionProposal({ tool: 'x', arguments: {}, params: { a: 1 } });
    expect(r.ok).toBe(false);
  });

  it('refuses an unknown envelope field rather than dropping it', () => {
    // The dropped field could be the destructive one.
    const r = parseActionProposal({ tool: 'inspect_project', force: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('unknown-field');
  });

  it('refuses a version it does not implement', () => {
    expect(parseActionProposal({ tool: 'x', version: 2 }).ok).toBe(false);
  });

  it('IGNORES a model asserting its own action is safe, per the envelope convention', () => {
    const r = parseActionProposal({ tool: 'create_project_link', requiresConfirmation: false, confirmed: true, mutating: false });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.ok ? r.value.arguments : {})).toHaveLength(0);
  });

  it('strips a self-granted confirmation hidden inside the arguments', () => {
    const r = parseActionProposal({ tool: 'create_project_link', arguments: { confirmed: true, allowDownload: true } });
    expect(r.ok && r.value.arguments).toEqual({ allowDownload: true });
  });

  it('there is no prose instruction parsing anywhere in the action path', () => {
    // Guarding the design, not the behaviour: a [TOOL:…] scanner would make
    // every sentence the model writes executable.
    for (const f of ['actionSchema.ts', 'actionPlanner.ts', 'agentActions.ts', 'actionExecution.ts']) {
      const src = require('node:fs').readFileSync(require('node:path').join(__dirname, f), 'utf8');
      // Comments stripped: prose ABOUT the absence of a marker parser is not a
      // marker parser, and the first version of this test failed on its own
      // documentation.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/\[TOOL:/);
      expect(code).not.toMatch(/TOOL_CALL|<tool>|exec\(|eval\(|child_process/);
    }
  });
});

describe('§4 deterministic entity resolution — the model never supplies an id', () => {
  const CANDS = [
    { id: 'p-sun', name: 'Sunshine' },
    { id: 'p-rmx', name: 'Sunshine Remix' },
    { id: 'p-2', name: 'Sunshine 2' },
  ];

  it('strips the phrasing around a name', () => {
    expect(extractProjectName('the newest Sunshine project')).toBe('sunshine');
  });

  it('an exact name wins even when other names contain it', () => {
    // A user with Sunshine, Sunshine Remix and Sunshine 2 who says "Sunshine"
    // means Sunshine; asking them to disambiguate that would be obtuse.
    const r = resolveProjectTarget('make a link for Sunshine', CANDS);
    expect(r.kind).toBe('resolved');
    expect(r.kind === 'resolved' && r.project.id).toBe('p-sun');
  });

  it('§10 refuses to guess between plausible matches', () => {
    const r = resolveProjectTarget('the sunshine remix thing', CANDS);
    expect(r.kind === 'resolved' ? r.project.name : 'ambiguous').toBe('Sunshine Remix');
    const amb = resolveProjectTarget('sun', CANDS);
    expect(amb.kind).toBe('ambiguous');
    expect(amb.kind === 'ambiguous' && amb.candidates).toHaveLength(3);
  });

  it('two projects genuinely sharing a name is ambiguous, exact or not', () => {
    const r = resolveProjectTarget('Sunshine', [{ id: 'a', name: 'Sunshine' }, { id: 'b', name: 'Sunshine' }]);
    expect(r.kind).toBe('ambiguous');
  });

  it('resolves the newest version by Wavi’s own version number', () => {
    const r = resolveLatestVersion(VERSIONS);
    expect(r.kind === 'resolved' && r.version.id).toBe('ver-8');
  });

  it('refuses to pick when records disagree about the newest', () => {
    const r = resolveLatestVersion([
      { id: 'a', versionNumber: 8 }, { id: 'b', versionNumber: 8 },
    ]);
    expect(r.kind).toBe('ambiguous');
  });

  it('no versions at all is not a resolution', () => {
    expect(resolveLatestVersion([]).kind).toBe('none');
  });
});

describe('§13 permission — the model cannot widen access', () => {
  it('a view-only user cannot publish, however the model phrased it', () => {
    const r = authorizeAction('publish_child_version', { role: 'view', canPublishChildVersion: false }, true);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/view access/);
  });

  it('only the owner may create a Project Link', () => {
    expect(authorizeAction('create_project_link', { role: 'comment', canPublishChildVersion: true }, true).ok).toBe(false);
    expect(authorizeAction('create_project_link', OWNER_AUTHORIZATION, true).ok).toBe(true);
  });

  it('contribution follows the existing comment-only rule', () => {
    expect(authorizeAction('publish_child_version', { role: 'comment', canPublishChildVersion: true }, true).ok).toBe(true);
  });

  it('unknown authorization fails CLOSED for a mutation', () => {
    // Not knowing is not the same as being allowed.
    const r = authorizeAction('create_project_link', null, true);
    expect(r.ok).toBe(false);
  });

  it('read-only actions need no authorization at all', () => {
    expect(authorizeAction('inspect_project', null, false).ok).toBe(true);
  });
});

describe('§9 requests the agent refuses outright', () => {
  it('"Run rm -rf ~/Music" — hard reject, and shell is not a capability', () => {
    const i = detectUnsupportedIntent('Run rm -rf ~/Music');
    expect(i?.category).toBe('shell');
    expect(i?.message).toMatch(/can’t run shell commands/);
  });

  it('"Delete all my old mixes" — no action', () => {
    expect(detectUnsupportedIntent('Delete all my old mixes')?.category).toBe('destructive');
  });

  it('rename and move are refused too', () => {
    expect(detectUnsupportedIntent('rename these files for me')?.category).toBe('destructive');
  });

  it('removing access is refused', () => {
    expect(detectUnsupportedIntent('remove Kevin’s access')?.category).toBe('permissions');
  });

  it('an ordinary request is not refused', () => {
    expect(detectUnsupportedIntent('make me a link for Sunshine')).toBeNull();
    expect(detectUnsupportedIntent('what is my latest Sunshine version?')).toBeNull();
  });

  it('refusal is a courtesy, not the defence — the tools simply do not exist', () => {
    // If this were the safety layer, a rephrasing would defeat it. The real
    // guarantee is that no delete/move/shell tool is proposable at all.
    for (const name of Object.keys(ACTION_ALLOWLIST)) {
      expect(name).not.toMatch(/delete|remove|destroy|rename|move|trash|revoke|invite|shell|exec/);
    }
  });
});

describe('§9/§12 the planner, end to end', () => {
  const base = {
    projects: [SUNSHINE], versions: VERSIONS, authorization: OWNER_AUTHORIZATION,
  };

  it('"Make me a link for Sunshine" → proposal, confirmation required', () => {
    const p = planAgentAction({
      question: 'Make me a link for Sunshine', context: ctx(),
      modelProposal: { tool: 'create_project_link', arguments: {} }, ...base,
    });
    expect(p.kind).toBe('proposal');
    if (p.kind !== 'proposal') return;
    expect(p.requiresConfirmation).toBe(true);
    expect(p.projectId).toBe('p-sun');
    expect(p.versionLabel).toBe('v8');
    expect(p.summary).toContain('Sunshine v8');
  });

  it('"…with downloads off" carries the parameter into the summary', () => {
    const p = planAgentAction({
      question: 'Make a link for the latest Sunshine version with downloads off', context: ctx(),
      modelProposal: { tool: 'create_project_link', arguments: { allowDownload: false } }, ...base,
    });
    expect(p.kind === 'proposal' && p.action.params.allowDownload).toBe(false);
    expect(p.kind === 'proposal' && p.summary).toContain('downloads off');
  });

  it('"What is my latest Sunshine version?" → read-only, no proposal needed', () => {
    const p = planAgentAction({ question: 'What is my latest Sunshine version?', context: ctx(), ...base });
    expect(p.kind).toBe('none');
  });

  it('"Delete all my old mixes" → refused, nothing proposed', () => {
    const p = planAgentAction({
      question: 'Delete all my old mixes', context: ctx(),
      modelProposal: { tool: 'create_project_link', arguments: {} }, ...base,
    });
    expect(p.kind).toBe('refused');
  });

  it('"Invite Kevin and send everything" → no action, invite is not allowlisted', () => {
    const p = planAgentAction({
      question: 'Invite Kevin and send everything', context: ctx(),
      modelProposal: { tool: 'invite_collaborator', arguments: { targetRef: 'kevin' } }, ...base,
    });
    expect(p.kind).toBe('rejected');
    expect(p.kind === 'rejected' && p.reason).toMatch(/may propose/);
  });

  it('§12 an invented canonical id is rejected, not corrected', () => {
    const p = planAgentAction({
      question: 'share it', context: ctx(),
      modelProposal: { tool: 'create_project_link', arguments: { projectId: 'p-someone-else' } }, ...base,
    });
    expect(p.kind).toBe('rejected');
    expect(p.kind === 'rejected' && p.reason).toMatch(/not the one in context/);
  });

  it('§12 an unsupported argument is rejected rather than dropped', () => {
    // Dropping would turn "share with downloads off" into "share".
    const p = planAgentAction({
      question: 'share Sunshine', context: ctx(),
      modelProposal: { tool: 'create_project_link', arguments: { allowDownload: false, deleteOriginals: true } }, ...base,
    });
    expect(p.kind).toBe('rejected');
    expect(p.kind === 'rejected' && p.reason).toMatch(/does not accept an argument/);
  });

  it('§12 a non-JSON reply never reaches the planner as a proposal', () => {
    const p = planAgentAction({ question: 'share Sunshine', context: ctx(), modelProposal: 'just do it', ...base });
    expect(p.kind).toBe('rejected');
  });

  it('§13 a view-only project cannot be shared, even with a valid proposal', () => {
    const p = planAgentAction({
      question: 'share Sunshine', context: ctx(),
      modelProposal: { tool: 'create_project_link', arguments: {} },
      projects: [SUNSHINE], versions: VERSIONS,
      authorization: { role: 'view', canPublishChildVersion: false },
    });
    expect(p.kind).toBe('rejected');
    expect(p.kind === 'rejected' && p.reason).toMatch(/owner/);
  });

  it('§10 ambiguity yields candidates with safe refs, never a canonical id', () => {
    const p = planAgentAction({
      question: 'make a link for sun', context: NO_PROJECT_CTX(),
      modelProposal: { tool: 'create_project_link', arguments: {} },
      projects: [SUNSHINE, { id: 'p-rmx', name: 'Sunshine Remix' }],
      versions: VERSIONS, authorization: OWNER_AUTHORIZATION,
    });
    expect(p.kind).toBe('clarify');
    if (p.kind !== 'clarify') return;
    expect(p.options.map((o) => o.ref)).toEqual(['cand_1', 'cand_2']);
    expect(JSON.stringify(p.options)).not.toContain('p-sun');
  });

  it('resolves the target from the request when nothing is selected', () => {
    const p = planAgentAction({
      question: 'make a link for the newest Sunshine project', context: NO_PROJECT_CTX(),
      modelProposal: { tool: 'create_project_link', arguments: {} }, ...base,
    });
    expect(p.kind === 'proposal' && p.projectId).toBe('p-sun');
  });
});

describe('§11 the action path works without a local model', () => {
  it('recognises a plain share request and proposes identically', () => {
    const inferred = inferProposalFromRequest('Create a link for Sunshine');
    expect(inferred?.tool).toBe('create_project_link');
    const p = planAgentAction({
      question: 'Create a link for Sunshine', context: ctx(),
      modelProposal: inferred, projects: [SUNSHINE], versions: VERSIONS,
      authorization: OWNER_AUTHORIZATION,
    });
    expect(p.kind).toBe('proposal');
    expect(p.kind === 'proposal' && p.requiresConfirmation).toBe(true);
  });

  it('picks up "without downloads" deterministically', () => {
    expect(inferProposalFromRequest('share Sunshine but no downloads')?.arguments).toEqual({ allowDownload: false });
  });

  it('does not mistake a question for a request', () => {
    expect(inferProposalFromRequest('what links do I have for Sunshine?')).toBeNull();
    expect(inferProposalFromRequest('list my share links')).toBeNull();
  });

  it('stays silent when it is not confident', () => {
    expect(inferProposalFromRequest('how loud is my master?')).toBeNull();
  });
});

describe('§5 confirmation binds to the exact proposal', () => {
  it('the arguments never leave main — the renderer gets an id and a sentence', () => {
    const s = store();
    const p = planAgentAction({
      question: 'share Sunshine with downloads off', context: ctx(),
      modelProposal: { tool: 'create_project_link', arguments: { allowDownload: false } },
      projects: [SUNSHINE], versions: VERSIONS, authorization: OWNER_AUTHORIZATION,
    });
    if (p.kind !== 'proposal') throw new Error('expected a proposal');
    const bound = s.mint(p.action, { projectId: p.projectId, summary: p.summary });
    expect(bound.id).toBe('prop_1');
    // Confirming takes the id alone: there is no argument channel to tamper
    // with, because the arguments were never handed out.
    const got = s.consume('prop_1');
    expect(got.ok && got.proposal.action.params.allowDownload).toBe(false);
  });

  it('a confirmation for an unknown proposal does nothing', () => {
    expect(store().consume('prop_nope')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('§17 a proposal is single-use, so a double confirmation cannot run twice', () => {
    const s = store();
    s.mint({ tool: 'create_project_link', params: {}, mutating: true, requiresConfirmation: true, summary: 's' },
      { projectId: 'p-sun', summary: 's' });
    expect(s.consume('prop_1').ok).toBe(true);
    const again = s.consume('prop_1');
    expect(again).toEqual({ ok: false, reason: 'already-used' });
  });

  it('a stale card expires rather than acting on a forgotten question', () => {
    let t = Date.parse(NOW);
    const s = createProposalStore({ now: () => new Date(t), newId: () => 'prop_x', ttlMs: 1000 });
    s.mint({ tool: 'create_project_link', params: {}, mutating: true, requiresConfirmation: true, summary: 's' },
      { projectId: 'p-sun', summary: 's' });
    t += 5000;
    expect(s.consume('prop_x')).toEqual({ ok: false, reason: 'expired' });
  });

  it('cancelling discards it, so a later confirmation finds nothing', () => {
    const s = store();
    s.mint({ tool: 'create_project_link', params: {}, mutating: true, requiresConfirmation: true, summary: 's' },
      { projectId: 'p-sun', summary: 's' });
    expect(s.discard('prop_1')).toBe(true);
    expect(s.consume('prop_1').ok).toBe(false);
    expect(s.pendingCount()).toBe(0);
  });
});

describe('§15 golden path — driving the REAL create_project_link tool', () => {
  /** Plan → mint → confirm → execute, exactly as main does it. */
  function pipeline(question: string, modelProposal: unknown, createSpy?: any) {
    const recorded: any[] = [];
    const s = store();
    const plan = planAgentAction({
      question, context: ctx(), modelProposal,
      projects: [SUNSHINE], versions: VERSIONS, authorization: OWNER_AUTHORIZATION,
    });
    const getTool = registry(createSpy);
    return {
      plan, store: s, recorded,
      confirm: async (id: string) => {
        const c = s.consume(id);
        if (!c.ok) return { ok: false as const, error: c.reason };
        recorded.push({ outcome: 'confirmed', tool: c.proposal.action.tool });
        return executeConfirmedProposal(c.proposal, {
          getTool,
          buildToolContext: (pr) => ({
            projectId: pr.projectId, projectName: 'Sunshine', versionId: 'ver-8',
            dawType: 'fl-studio', filePath: null, versionCount: 2, lastSyncedAt: null,
            files: [], cloudProject: null,
          }),
          record: (r) => recorded.push(r),
        });
      },
    };
  }

  it('1–12: resolves, proposes, waits, executes once, and reports the tool’s own result', async () => {
    const spy = vi.fn(async (): Promise<AssistantCreateResult> => ({ kind: 'created', link: SAFE_LINK }));
    const run = pipeline(
      'Make a link for the newest Sunshine version but don’t allow downloads',
      { tool: 'create_project_link', arguments: { allowDownload: false } },
      spy,
    );

    // 1–4. Sunshine and v8 resolved deterministically; the argument survived.
    if (run.plan.kind !== 'proposal') throw new Error('expected a proposal');
    expect(run.plan.projectId).toBe('p-sun');
    expect(run.plan.versionId).toBe('ver-8');
    expect(run.plan.action.params.allowDownload).toBe(false);

    // 5–6. Nothing has happened yet.
    const bound = run.store.mint(run.plan.action, { projectId: run.plan.projectId, summary: run.plan.summary });
    expect(spy).not.toHaveBeenCalled();

    // 7–8. The user confirms; the canonical path runs exactly once.
    const result = await run.confirm(bound.id);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ projectId: 'p-sun', allowDownload: false });

    // 9. The authoritative result is the tool's, not the model's prediction.
    expect(result.ok).toBe(true);
    expect(result.ok && result.message).toContain('plink_00000001');

    // 10. Recorded as confirmed then executed.
    expect(run.recorded.map((r) => r.outcome)).toEqual(['confirmed', 'executed']);

    // 12. No canonical server id, token or path in what the user is shown.
    const shown = String(result.ok ? result.message : '');
    expect(shown).not.toMatch(/did:privy|Bearer|invt_|\/Users\//);
  });

  it('§16 cancellation: zero calls, zero mutation, no fake success', async () => {
    const spy = vi.fn(async (): Promise<AssistantCreateResult> => ({ kind: 'created', link: SAFE_LINK }));
    const run = pipeline('share Sunshine', { tool: 'create_project_link', arguments: {} }, spy);
    if (run.plan.kind !== 'proposal') throw new Error('expected a proposal');
    const bound = run.store.mint(run.plan.action, { projectId: run.plan.projectId, summary: run.plan.summary });

    run.store.discard(bound.id);                       // the user clicks Cancel
    const after = await run.confirm(bound.id);         // and a late confirm arrives

    expect(spy).not.toHaveBeenCalled();
    expect(after.ok).toBe(false);
    expect(run.recorded).toHaveLength(0);              // nothing claims success
  });

  it('§17 a duplicated confirmation creates exactly one link', async () => {
    const spy = vi.fn(async (): Promise<AssistantCreateResult> => ({ kind: 'created', link: SAFE_LINK }));
    const run = pipeline('share Sunshine', { tool: 'create_project_link', arguments: {} }, spy);
    if (run.plan.kind !== 'proposal') throw new Error('expected a proposal');
    const bound = run.store.mint(run.plan.action, { projectId: run.plan.projectId, summary: run.plan.summary });

    const [a, b] = await Promise.all([run.confirm(bound.id), run.confirm(bound.id)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('§7 a failing tool is reported honestly, never as success', async () => {
    const spy = vi.fn(async (): Promise<AssistantCreateResult> => ({ kind: 'failure', reason: 'offline' }));
    const run = pipeline('share Sunshine', { tool: 'create_project_link', arguments: {} }, spy);
    if (run.plan.kind !== 'proposal') throw new Error('expected a proposal');
    const bound = run.store.mint(run.plan.action, { projectId: run.plan.projectId, summary: run.plan.summary });
    const r = await run.confirm(bound.id);
    expect(r.ok).toBe(false);
    expect(run.recorded.at(-1)).toMatchObject({ outcome: 'failed' });
  });

  it('§6 the registry’s own envelope still gates the mutation', async () => {
    // Proof the agent is not the only gate: invoked WITHOUT confirmation, the
    // real tool refuses on its own.
    const spy = vi.fn(async (): Promise<AssistantCreateResult> => ({ kind: 'created', link: SAFE_LINK }));
    const tool = registry(spy)('create_project_link')!;
    const r = await tool.handler({ projectId: 'p-sun' }, { projectId: 'p-sun', projectName: 'Sunshine' } as any);
    expect(r.status).toBe('needs_confirmation');
    expect(spy).not.toHaveBeenCalled();
  });

  it('§6 an unauthenticated session cannot execute a confirmed mutation either', async () => {
    const spy = vi.fn(async (): Promise<AssistantCreateResult> => ({ kind: 'created', link: SAFE_LINK }));
    const tools = buildProjectTools({ ...toolDeps(spy), isAuthenticated: () => false } as any);
    const tool = tools.find((t) => t.name === 'create_project_link')!;
    const r = await tool.handler({ projectId: 'p-sun' }, { projectId: 'p-sun', projectName: 'Sunshine' } as any, { confirmedOutOfBand: true });
    expect(r.status).toBe('error');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('§8 the audit loop closes: agent acts → Wavi records → Brain remembers', () => {
  it('each stage has a plain-language record', () => {
    const say = (outcome: any, detail?: string) =>
      describeOutcome({ tool: 'create_project_link', mutating: true, outcome, detail });
    expect(say('proposed')).toBe('Agent suggested: create_project_link');
    expect(say('confirmed')).toMatch(/You confirmed/);
    expect(say('cancelled')).toMatch(/You cancelled/);
    expect(say('executed')).toBe('Ran: create_project_link');
    expect(say('failed', 'offline')).toMatch(/Failed: create_project_link — offline/);
  });

  it('an agent_action event flows into Project Brain’s activity view', () => {
    // No type allowlist stands between activity_log and Brain, so recording
    // the action is what makes the agent's own history retrievable later.
    const events = [{
      id: 'a1', type: 'agent_action', projectId: 'p-sun', projectName: 'Sunshine',
      message: 'Ran: create_project_link', at: NOW,
    }];
    expect(summarizeActivity(events)).toEqual([{ type: 'agent_action', count: 1 }]);
    const grouped = coalesceActivity(events);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].type).toBe('agent_action');
  });

  it('the recorded sentence carries no raw path, token or DID', () => {
    const rendered = describeOutcome({
      tool: 'create_project_link', mutating: true, outcome: 'failed',
      detail: redactPathsInText('failed writing /Users/someone/Music/Sunshine/Sunshine.flp'),
    });
    expect(rendered).not.toContain('/Users/');
    expect(rendered).toContain('Sunshine.flp');
  });
});
