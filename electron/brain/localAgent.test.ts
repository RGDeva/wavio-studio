/**
 * Local Agent v1 — grounding, the local-only boundary, and the answer pipeline.
 *
 * The property under test is not answer quality but *safety*: a model cannot
 * invent facts about the user's files, cannot be pointed off the machine, and
 * cannot be required for Wavi to answer at all.
 */
import { describe, it, expect } from 'vitest';
import { buildAssistantContext, type AssistantContextInput } from './assistantContext';
import { verifyGrounded, buildAllowedFacts, buildGroundedPrompt, renderContextForModel } from './grounding';
import { validateLocalEndpoint, LocalHttpProvider, createLocalProvider } from './localProvider';
import { answerQuestion, buildDeterministicAnswer } from './answer';

const NOW = '2026-10-06T12:00:00.000Z';

function ctxWith(over: Partial<AssistantContextInput> = {}) {
  return buildAssistantContext({
    query: '',   // broad: keeps everything, so these test GROUNDING not relevance
    project: { id: 'p1', name: 'Sunshine', dawType: 'fl-studio' },
    memory: [], facts: [], inferences: [], versions: [], recentActivity: [],
    files: [
      { id: 'f1', name: 'master-v8.wav', role: 'audio', status: 'synced', modifiedAt: NOW },
      { id: 'f2', name: 'vocal.wav', role: 'audio', status: 'synced', modifiedAt: NOW },
    ],
    now: NOW,
    ...over,
  });
}

describe('grounding — a model cannot invent facts', () => {
  it('accepts an answer that only names files from the context', () => {
    const r = verifyGrounded('Your latest master is master-v8.wav, next to vocal.wav.', ctxWith());
    expect(r.grounded).toBe(true);
    expect(r.unsupported).toEqual([]);
  });

  it('REJECTS a filename the user does not have', () => {
    // The exact failure this exists to stop: a fluent, confident, wrong claim
    // about someone's files.
    const r = verifyGrounded('Your latest master is master-v12.wav.', ctxWith());
    expect(r.grounded).toBe(false);
    expect(r.unsupported).toContain('master-v12.wav');
  });

  it('rejects an invented count', () => {
    const r = verifyGrounded('You have 47 files in this project.', ctxWith());
    expect(r.grounded).toBe(false);
    expect(r.unsupported).toContain('47');
  });

  it('accepts a count the context supports', () => {
    const ctx = ctxWith({ facts: [{ key: 'file-count', value: '112' }] });
    expect(verifyGrounded('There are 112 files.', ctx).grounded).toBe(true);
  });

  it('does not fire on small numbers in ordinary prose', () => {
    // "one of your projects", "2 of them" — flagging these would make the
    // verifier noise and get it switched off.
    expect(verifyGrounded('There are 2 files here.', ctxWith()).grounded).toBe(true);
  });

  it('allows a version number the context lists', () => {
    const ctx = ctxWith({ versions: [{ versionNumber: 42, createdAt: NOW, fileCount: null }] });
    expect(verifyGrounded('The latest published version is v42.', ctx).grounded).toBe(true);
    expect(verifyGrounded('The latest published version is v43.', ctx).grounded).toBe(false);
  });

  it('allows filenames mentioned only inside a remembered note', () => {
    // The user's own words count as context.
    const ctx = ctxWith({
      memory: [{ key: 'reference', value: 'reference mix is sunshine-ref.wav', category: 'note',
                 scope: 'project', origin: 'user', producer: 'ui', observedAt: NOW }],
    });
    expect(verifyGrounded('Your reference is sunshine-ref.wav.', ctx).grounded).toBe(true);
  });

  it('builds the allowed set from the CONTEXT only', () => {
    // Never from the database — the verifier can only approve what the model
    // was actually shown.
    const allowed = buildAllowedFacts(ctxWith());
    expect(allowed.names.has('master-v8.wav')).toBe(true);
    expect(allowed.names.has('something-else.wav')).toBe(false);
  });

  it('is case-insensitive about filenames', () => {
    expect(verifyGrounded('MASTER-V8.WAV is the latest.', ctxWith()).grounded).toBe(true);
  });
});

describe('prompt construction', () => {
  it('labels guesses as guesses and keeps attribution', () => {
    const ctx = ctxWith({
      inferences: [{ key: 'likely-master', value: 'master-v8.wav', evidence: 'highest version', strength: 'strong' }],
      memory: [{ key: 'style', value: 'keep mixes sparse', category: 'note', scope: 'global', origin: 'user', producer: 'ui', observedAt: NOW }],
    });
    const rendered = renderContextForModel(ctx);
    expect(rendered).toContain('GUESSES');
    expect(rendered).toContain('highest version');
    expect(rendered).toContain('WHAT THE USER TOLD WAVI');
    expect(rendered).toContain('global memory');
  });

  it('instructs the model to rephrase, not to answer', () => {
    const prompt = buildGroundedPrompt({ question: 'q', context: ctxWith(), deterministicAnswer: 'A true answer.' });
    expect(prompt).toContain('CORRECT ANSWER');
    expect(prompt).toContain('A true answer.');
    expect(prompt).toMatch(/Never invent/);
  });

  it('tells the model when the view is partial', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, name: `t${i}.wav`, role: 'audio', status: 'synced', modifiedAt: NOW }));
    const prompt = buildGroundedPrompt({ question: 'q', context: ctxWith({ files: many }), deterministicAnswer: 'x' });
    expect(prompt).toContain('partial view');
  });
});

describe('local means local', () => {
  it('accepts loopback endpoints', () => {
    for (const url of ['http://127.0.0.1:11434', 'http://localhost:8080', 'http://[::1]:1234']) {
      expect(validateLocalEndpoint(url).ok).toBe(true);
    }
  });

  it('REJECTS any off-machine endpoint', () => {
    // A "local provider" pointed at someone's server would quietly ship the
    // user's workspace off the machine.
    for (const url of ['http://api.openai.com', 'https://example.com:11434', 'http://192.168.1.50:11434', 'http://evil.test']) {
      const r = validateLocalEndpoint(url);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/loopback/);
    }
  });

  it('rejects a non-HTTP protocol', () => {
    expect(validateLocalEndpoint('file:///etc/passwd').ok).toBe(false);
    expect(validateLocalEndpoint('not a url').ok).toBe(false);
  });

  it('refuses to construct a provider for a remote endpoint', () => {
    expect(createLocalProvider({ enabled: true, endpoint: 'https://example.com', model: 'x' })).toBeNull();
  });

  it('returns null when no model is configured — the default state', () => {
    expect(createLocalProvider(null)).toBeNull();
    expect(createLocalProvider({ enabled: false, endpoint: 'http://127.0.0.1:11434', model: 'x' })).toBeNull();
    expect(createLocalProvider({ enabled: true, endpoint: 'http://127.0.0.1:11434' })).toBeNull();
  });

  it('reports unavailable rather than throwing when nothing is listening', async () => {
    const p = new LocalHttpProvider({
      endpoint: 'http://127.0.0.1:11434', model: 'test',
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as any,
    });
    expect(await p.isAvailable()).toBe(false);
    expect((await p.complete({ question: 'q', context: 'p' })).unavailable).toBe(true);
  });

  it('never calls out when the endpoint is remote', async () => {
    let called = false;
    const p = new LocalHttpProvider({
      endpoint: 'https://example.com', model: 'test',
      fetchImpl: (async () => { called = true; return { ok: true, json: async () => ({}) } as any; }) as any,
    });
    await p.complete({ question: 'q', context: 'p' });
    expect(called).toBe(false);   // fails closed, no request attempted
  });

  it('returns the model text on success', async () => {
    const p = new LocalHttpProvider({
      endpoint: 'http://127.0.0.1:11434', model: 'test',
      fetchImpl: (async () => ({ ok: true, json: async () => ({ response: '  Hello there.  ' }) })) as any,
    });
    expect((await p.complete({ question: 'q', context: 'p' })).text).toBe('Hello there.');
  });
});

describe('the answer pipeline', () => {
  const ctx = ctxWith({ inferences: [{ key: 'likely-master', value: 'master-v8.wav', evidence: 'highest version', strength: 'strong' }] });

  it('answers with no model at all', async () => {
    // The whole point of "optional".
    const r = await answerQuestion('where is my master?', { context: ctx });
    expect(r.source).toBe('deterministic');
    expect(r.text).toContain('master-v8.wav');
  });

  it('uses the model when its wording is grounded', async () => {
    const r = await answerQuestion('q', {
      context: ctx,
      callModel: async () => ({ text: 'Your latest master looks like master-v8.wav.', provider: 'local-http' }),
    });
    expect(r.source).toBe('model');
    expect(r.grounding?.grounded).toBe(true);
  });

  it('DISCARDS a model answer that invents a file, and says so', async () => {
    const r = await answerQuestion('q', {
      context: ctx,
      callModel: async () => ({ text: 'Your master is final-master-v99.wav.', provider: 'local-http' }),
    });
    expect(r.source).toBe('deterministic');
    expect(r.grounding?.grounded).toBe(false);
    // Kept for display, so the rejection is visible rather than silent.
    expect(r.rejectedModelOutput).toContain('final-master-v99.wav');
    expect(r.text).not.toContain('v99');
  });

  it('falls back when the model throws, times out, or returns nothing', async () => {
    for (const bad of [
      async () => { throw new Error('timeout'); },
      async () => null,
      async () => ({ text: '   ', provider: 'local-http' }),
    ]) {
      const r = await answerQuestion('q', { context: ctx, callModel: bad as any });
      expect(r.source).toBe('deterministic');
      expect(r.text.length).toBeGreaterThan(0);
    }
  });

  it('says plainly when it knows nothing, rather than speculating', async () => {
    const empty = buildAssistantContext({
      query: 'q', project: null, memory: [], facts: [], inferences: [],
      files: [], versions: [], recentActivity: [], now: NOW,
    });
    expect(buildDeterministicAnswer(empty)).toMatch(/don't have anything indexed/);
  });

  it('always marks an inference as a guess, with its evidence', () => {
    const text = buildDeterministicAnswer(ctx);
    expect(text).toMatch(/guess/);
    expect(text).toContain('highest version');
  });

  it('surfaces a conflict and says the scan wins', () => {
    const conflicted = ctxWith({
      memory: [{ key: 'latest-master', value: 'master-v7.wav', category: 'note', scope: 'project', origin: 'user', producer: 'ui', observedAt: NOW }],
      facts: [{ key: 'latest-master', value: 'master-v8.wav' }],
    });
    const text = buildDeterministicAnswer(conflicted);
    expect(text).toMatch(/scan is what's on disk now/);
  });

  it('never leaks a path or secret into the answer', () => {
    const text = buildDeterministicAnswer(ctx);
    expect(text).not.toMatch(/\/Users\/|Bearer |did:privy:/);
  });
});
