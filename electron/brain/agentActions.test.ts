/**
 * Agent Actions v1 — the model proposes, code decides.
 *
 * What these defend is not usefulness but containment: the agent cannot reach
 * a capability it was not given, cannot act on something it was not shown, and
 * cannot cause a mutation without a human.
 */
import { describe, it, expect } from 'vitest';
import { buildAssistantContext, type AssistantContextInput } from './assistantContext';
import {
  validateProposedAction, ACTION_ALLOWLIST, describeAllowlistForPrompt, describeOutcome,
} from './agentActions';
import { parseModelResponse } from './modelResponse';
import { answerQuestion } from './answer';

const NOW = '2026-10-06T12:00:00.000Z';

function ctx(over: Partial<AssistantContextInput> = {}) {
  return buildAssistantContext({
    query: '',
    project: { id: 'p-sun', name: 'Sunshine', dawType: 'fl-studio' },
    memory: [], facts: [], inferences: [], versions: [], recentActivity: [],
    files: [
      { id: 'f1', name: 'Sunshine.flp', role: 'project', status: 'synced', modifiedAt: NOW },
      { id: 'f2', name: 'master-v8.wav', role: 'audio', status: 'synced', modifiedAt: NOW },
    ],
    now: NOW, ...over,
  });
}

describe('the allowlist is the boundary', () => {
  it('accepts a listed read-only action', () => {
    const r = validateProposedAction({ tool: 'inspect_project' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.ok && r.action).toMatchObject({ mutating: false, requiresConfirmation: false });
  });

  it('REFUSES anything not on the list, even a real registry tool', () => {
    // The distinction matters: the tool exists in the registry and is still
    // off-limits to the agent.
    for (const tool of ['revoke_project_link', 'invite_collaborator', 'open_file', 'made_up_tool']) {
      const r = validateProposedAction({ tool }, ctx());
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/not an action the agent may propose/);
    }
  });

  it('contains nothing destructive — a property of the list, not the prompt', () => {
    for (const name of Object.keys(ACTION_ALLOWLIST)) {
      expect(name).not.toMatch(/delete|remove|destroy|rename|move|trash|revoke/);
    }
  });

  it('rejects a malformed proposal rather than repairing it', () => {
    // An almost-right proposal is still one the model got wrong; silently
    // fixing it would hide the failure this exists to catch.
    for (const bad of [null, 'inspect_project', [], {}, { tool: '' }, { tool: 'inspect_project', params: 'x' }]) {
      expect(validateProposedAction(bad, ctx()).ok).toBe(false);
    }
  });

  it('requires declared arguments, named as the canonical tool names them', () => {
    // reveal_file takes fileName. An allowlist that said "fileId" would produce
    // a proposal that passes every gate here and is then rejected by the tool.
    const r = validateProposedAction({ tool: 'reveal_file' }, ctx());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/missing required argument "fileName"/);
  });
});

describe('entity grounding — it cannot act on what it was not shown', () => {
  it('accepts a file that is in context, by id or by name', () => {
    expect(validateProposedAction({ tool: 'reveal_file', params: { fileName: 'f2' } }, ctx()).ok).toBe(true);
    expect(validateProposedAction({ tool: 'reveal_file', params: { fileName: 'master-v8.wav' } }, ctx()).ok).toBe(true);
  });

  it('REFUSES a file that is not in context', () => {
    const r = validateProposedAction({ tool: 'reveal_file', params: { fileName: 'secrets.wav' } }, ctx());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/not in context/);
  });

  it('REFUSES a project other than the one in context', () => {
    // The most dangerous shape a proposal can take: acting on a project the
    // model inferred rather than one it was shown.
    const r = validateProposedAction({ tool: 'inspect_project', params: { projectId: 'p-faith' } }, ctx());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/not the one in context/);
  });

  it('accepts the project it was shown', () => {
    expect(validateProposedAction({ tool: 'inspect_project', params: { projectId: 'p-sun' } }, ctx()).ok).toBe(true);
  });

  it('refuses a project-scoped action when no project is in context', () => {
    const empty = buildAssistantContext({
      query: '', project: null, memory: [], facts: [], inferences: [],
      files: [], versions: [], recentActivity: [], now: NOW,
    });
    expect(validateProposedAction({ tool: 'inspect_project', params: { projectId: 'p-sun' } }, empty).ok).toBe(false);
  });

  it('matches ids case-insensitively but never loosely', () => {
    expect(validateProposedAction({ tool: 'reveal_file', params: { fileName: 'MASTER-V8.WAV' } }, ctx()).ok).toBe(true);
    expect(validateProposedAction({ tool: 'reveal_file', params: { fileName: 'master-v8' } }, ctx()).ok).toBe(false);
  });
});

describe('confirmation cannot be self-granted', () => {
  it('marks mutating actions as requiring confirmation', () => {
    for (const tool of ['create_project_link', 'publish_child_version']) {
      const r = validateProposedAction({ tool }, ctx());
      expect(r.ok).toBe(true);
      expect(r.ok && r.action).toMatchObject({ mutating: true, requiresConfirmation: true });
    }
  });

  it('IGNORES a model trying to declare its own action safe', () => {
    // requiresConfirmation comes from the allowlist; a model emitting
    // requiresConfirmation:false has no effect whatsoever.
    const r = validateProposedAction(
      { tool: 'create_project_link', requiresConfirmation: false, mutating: false } as any,
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.action.requiresConfirmation).toBe(true);
  });

  it('read-only actions need no confirmation — a wrong suggestion to look costs nothing', () => {
    expect(validateProposedAction({ tool: 'list_local_versions' }, ctx()).ok).toBe(true);
    const r = validateProposedAction({ tool: 'list_local_versions' }, ctx());
    expect(r.ok && r.action.requiresConfirmation).toBe(false);
  });
});

describe('the contract carries proposals without trusting them', () => {
  it('parses an optional proposedAction', () => {
    const r = parseModelResponse(JSON.stringify({
      answer: 'You could share this.', citedContextIds: [], confidence: 'medium',
      proposedAction: { tool: 'create_project_link', params: {} },
    }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.proposedAction?.tool).toBe('create_project_link');
  });

  it('a malformed proposal does not invalidate a good answer', () => {
    // The answer may be perfectly correct even when the suggestion is junk.
    const r = parseModelResponse(JSON.stringify({
      answer: 'Here is what I found.', citedContextIds: [], confidence: 'high',
      proposedAction: 'do the thing',
    }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.proposedAction).toBeUndefined();
  });

  it('the prompt tells the model what it may suggest, and that it cannot perform it', () => {
    const text = describeAllowlistForPrompt();
    expect(text).toMatch(/you cannot perform them/i);
    expect(text).toContain('inspect_project');
    expect(text).toMatch(/needs the user/);
  });
});

describe('end to end through the answer pipeline', () => {
  const reply = (proposedAction: unknown) => async () => ({
    text: JSON.stringify({
      answer: 'Sunshine has master-v8.wav.', citedContextIds: ['F2'], confidence: 'high',
      proposedAction,
    }),
    provider: 'local-http',
  });

  it('surfaces a valid suggestion WITHOUT executing it', async () => {
    const r = await answerQuestion('q', { context: ctx(), callModel: reply({ tool: 'create_project_link' }) });
    expect(r.source).toBe('model');
    expect(r.proposedAction).toMatchObject({
      tool: 'create_project_link', mutating: true, requiresConfirmation: true,
    });
    // Nothing ran: the pipeline has no execution path at all.
    expect(r).not.toHaveProperty('executed');
  });

  it('drops a disallowed suggestion and reports why, keeping the answer', async () => {
    const r = await answerQuestion('q', { context: ctx(), callModel: reply({ tool: 'invite_collaborator' }) });
    expect(r.source).toBe('model');
    expect(r.text).toContain('master-v8.wav');     // answer survives
    expect(r.proposedAction).toBeUndefined();
    expect(r.rejectedAction).toMatchObject({ tool: 'invite_collaborator' });
    expect(r.rejectedAction?.reason).toMatch(/may propose/);
  });

  it('drops a suggestion pointing at an unseen project', async () => {
    const r = await answerQuestion('q', {
      context: ctx(),
      callModel: reply({ tool: 'inspect_project', params: { projectId: 'p-someone-else' } }),
    });
    expect(r.proposedAction).toBeUndefined();
    expect(r.rejectedAction?.reason).toMatch(/not the one in context/);
  });

  it('an answer with no suggestion is entirely normal', async () => {
    const r = await answerQuestion('q', { context: ctx(), callModel: reply(undefined) });
    expect(r.source).toBe('model');
    expect(r.proposedAction).toBeUndefined();
    expect(r.rejectedAction).toBeUndefined();
  });

  it('a rejected ANSWER yields no action either', async () => {
    // Ungrounded prose is discarded, and its suggestion goes with it.
    const r = await answerQuestion('q', {
      context: ctx(),
      callModel: async () => ({
        text: JSON.stringify({
          answer: 'Your master is ghost-v99.wav.', citedContextIds: [], confidence: 'high',
          proposedAction: { tool: 'create_project_link' },
        }),
        provider: 'local-http',
      }),
    });
    expect(r.source).toBe('deterministic');
    expect(r.proposedAction).toBeUndefined();
  });
});

describe('outcomes are recordable', () => {
  it('describes each stage in plain language', () => {
    expect(describeOutcome({ tool: 'create_project_link', mutating: true, outcome: 'proposed' }))
      .toBe('Agent suggested: create_project_link');
    expect(describeOutcome({ tool: 'create_project_link', mutating: true, outcome: 'confirmed' }))
      .toMatch(/You confirmed/);
    expect(describeOutcome({ tool: 'x', mutating: true, outcome: 'failed', detail: 'offline' }))
      .toMatch(/Failed: x — offline/);
  });
});
