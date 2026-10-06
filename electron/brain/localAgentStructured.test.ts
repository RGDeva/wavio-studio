/**
 * Local Agent v1 — structured contract, lifecycle, privacy, and the golden path.
 *
 * The question these answer is not "is the model good?" but "can the model
 * hurt the user?": by inventing workspace facts, by reaching the network, or
 * by being required at all.
 */
import { describe, it, expect } from 'vitest';
import { buildAssistantContext, type AssistantContextInput } from './assistantContext';
import { parseModelResponse, validateCitations, extractJsonObject } from './modelResponse';
import { contextItemIds, buildGroundedPrompt } from './grounding';
import { resolveModelState, describeModelState } from './modelLifecycle';
import { LocalHttpProvider } from './localProvider';
import { answerQuestion } from './answer';

const NOW = '2026-10-06T12:00:00.000Z';

/** The §17 fixture. */
function goldenContext(query: string) {
  const input: AssistantContextInput = {
    query,
    project: { id: 'p-sun', name: 'Sunshine', dawType: 'fl-studio' },
    memory: [{
      key: 'vocal-export', value: 'I usually export vocals into Bounces', category: 'note',
      scope: 'global', origin: 'user', producer: 'ui', observedAt: NOW,
    }],
    facts: [{ key: 'source-daw', value: 'fl-studio' }],
    inferences: [{ key: 'likely-master', value: 'master-v8.wav', evidence: 'highest version', strength: 'strong' }],
    files: [
      { id: 'f1', name: 'Sunshine.flp', role: 'project', status: 'synced', modifiedAt: NOW },
      { id: 'f2', name: 'vocal.wav', role: 'audio', status: 'synced', modifiedAt: NOW },
      { id: 'f3', name: 'master-v8.wav', role: 'audio', status: 'synced', modifiedAt: NOW },
    ],
    versions: [],
    recentActivity: [{ type: 'file_added', message: 'master-v8.wav added', at: NOW }],
    now: NOW,
  };
  return buildAssistantContext(input);
}

describe('structured response contract', () => {
  it('accepts a well-formed reply', () => {
    const r = parseModelResponse('{"answer":"You added master-v8.wav.","citedContextIds":["A1"],"confidence":"high"}');
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toMatchObject({ confidence: 'high', citedContextIds: ['A1'] });
  });

  it('tolerates code fences and preamble, which small models emit constantly', () => {
    // Rejecting these would discard answers that are well-formed underneath.
    const raw = 'Sure! Here you go:\n```json\n{"answer":"ok","citedContextIds":[],"confidence":"low"}\n```';
    expect(parseModelResponse(raw).ok).toBe(true);
  });

  it('finds the object even with braces inside strings', () => {
    const raw = '{"answer":"a } brace","citedContextIds":[],"confidence":"low"}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it('rejects malformed output', () => {
    for (const bad of [
      'I think your master is master-v8.wav.',          // prose, no JSON
      '{"answer":"x"}',                                  // no confidence
      '{"answer":"","citedContextIds":[],"confidence":"high"}', // empty answer
      '{"answer":"x","citedContextIds":"F1","confidence":"high"}', // citations not array
      '{"answer":"x","citedContextIds":[1],"confidence":"high"}',  // non-string id
      '{"answer":"x","citedContextIds":[],"confidence":"certain"}', // bad enum
      '{not json',
    ]) {
      expect(parseModelResponse(bad).ok).toBe(false);
    }
  });

  it('allows an empty citation list — "I don’t know" cites nothing', () => {
    // Demanding a citation there would push the model to invent one.
    const r = parseModelResponse('{"answer":"I don\'t know.","citedContextIds":[],"confidence":"low"}');
    expect(r.ok).toBe(true);
  });

  it('rejects a citation that names a context line which does not exist', () => {
    const ctx = goldenContext('');
    const ids = contextItemIds(ctx);
    const r = parseModelResponse('{"answer":"x","citedContextIds":["F99"],"confidence":"high"}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const check = validateCitations(r.value, ids);
    expect(check.valid).toBe(false);
    expect(check.unknown).toEqual(['F99']);
  });

  it('the id set mirrors what the prompt actually rendered', () => {
    // An id the renderer emits but the validator omits would make a legitimate
    // citation look fabricated — the worst direction for this to fail.
    const ctx = goldenContext('');
    const prompt = buildGroundedPrompt({ question: 'q', context: ctx, deterministicAnswer: 'a' });
    for (const id of contextItemIds(ctx)) {
      expect(prompt).toContain(`[${id}]`);
    }
  });
});

describe('model lifecycle', () => {
  it('reports disabled when nothing is configured — the default', () => {
    const s = resolveModelState({ configured: false, reachable: false });
    expect(s).toMatchObject({ state: 'disabled', usable: false });
    expect(s.label).toBe('Deterministic mode');
  });

  it('distinguishes "runtime not running" from "model not installed"', () => {
    // Different fixes; telling the user the wrong one wastes their time.
    expect(resolveModelState({ configured: true, reachable: false }).state).toBe('unavailable');
    expect(resolveModelState({
      configured: true, reachable: true, installedModels: ['mistral'], wantedModel: 'llama3.2',
    }).state).toBe('model-missing');
  });

  it('matches a model despite a tag difference', () => {
    const s = resolveModelState({
      configured: true, reachable: true, installedModels: ['llama3.2:3b'], wantedModel: 'llama3.2',
    });
    expect(s.state).toBe('ready');
  });

  it('is ready only when reachable and the model is present', () => {
    const s = resolveModelState({
      configured: true, reachable: true, installedModels: ['llama3.2'], wantedModel: 'llama3.2',
    });
    expect(s).toMatchObject({ state: 'ready', usable: true, label: 'Local AI ready' });
  });

  it('never surfaces a raw error to the UI', () => {
    const s = describeModelState('error');
    expect(s.detail).not.toMatch(/Error:|at \w+ \(/);
    expect(s.usable).toBe(false);
  });

  it('always states that answers work anyway', () => {
    for (const st of ['disabled', 'checking', 'ready', 'unavailable', 'model-missing', 'error'] as const) {
      expect(describeModelState(st).fallback).toMatch(/local index/);
    }
  });
});

describe('privacy — the provider makes no outbound network request', () => {
  it('only ever contacts loopback, and records every URL it touched', async () => {
    const seen: string[] = [];
    const provider = new LocalHttpProvider({
      endpoint: 'http://127.0.0.1:11434',
      model: 'test',
      fetchImpl: (async (url: any) => {
        seen.push(String(url));
        return { ok: true, json: async () => ({ response: '{"answer":"ok","citedContextIds":[],"confidence":"low"}' }) } as any;
      }) as any,
    });
    await provider.isAvailable();
    await provider.complete({ question: 'q', context: 'prompt with Sunshine and vocal.wav' });

    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) {
      const host = new URL(url).hostname;
      expect(['127.0.0.1', 'localhost', '::1']).toContain(host);
    }
  });

  it('makes NO request at all when the endpoint is not loopback', async () => {
    // The user's project names, file names and memory are all in the prompt.
    let called = 0;
    const provider = new LocalHttpProvider({
      endpoint: 'https://api.example.com',
      model: 'test',
      fetchImpl: (async () => { called++; return { ok: true, json: async () => ({}) } as any; }) as any,
    });
    expect(await provider.isAvailable()).toBe(false);
    await provider.complete({ question: 'q', context: 'Sunshine vocal.wav' });
    expect(called).toBe(0);
  });
});

describe('golden path (§17)', () => {
  const QUESTION = 'What have I been working on and where do I normally export my vocals?';

  it('answers from context when the model cites properly', async () => {
    const ctx = goldenContext(QUESTION);
    const r = await answerQuestion(QUESTION, {
      context: ctx,
      callModel: async () => ({
        text: JSON.stringify({
          answer: 'You added master-v8.wav to Sunshine, and you usually export vocals into Bounces.',
          citedContextIds: ['A1', 'M1'],
          confidence: 'high',
        }),
        provider: 'local-http',
      }),
    });
    expect(r.source).toBe('model');
    expect(r.text).toContain('master-v8.wav');
    expect(r.text).toContain('Bounces');
    expect(r.citedContextIds).toEqual(['A1', 'M1']);
  });

  it('"Did I send this song to Drake?" — says it does not know, and invents nothing', async () => {
    // No context supports this. The honest answer is the only acceptable one.
    const ctx = goldenContext('Did I send this song to Drake?');
    const r = await answerQuestion('Did I send this song to Drake?', {
      context: ctx,
      callModel: async () => ({
        text: JSON.stringify({
          answer: "I don't have anything about sending this to Drake.",
          citedContextIds: [],
          confidence: 'low',
        }),
        provider: 'local-http',
      }),
    });
    expect(r.source).toBe('model');
    expect(r.text.toLowerCase()).toMatch(/don't have|no record|nothing/);
  });

  it('a model that FABRICATES a Drake answer is discarded', async () => {
    const ctx = goldenContext('Did I send this song to Drake?');
    const r = await answerQuestion('Did I send this song to Drake?', {
      context: ctx,
      callModel: async () => ({
        text: JSON.stringify({
          answer: 'Yes, you shared drake-reference.wav with him on 12 September.',
          citedContextIds: [],
          confidence: 'high',
        }),
        provider: 'local-http',
      }),
    });
    expect(r.source).toBe('deterministic');
    expect(r.rejectionReason).toMatch(/unsupported claims/);
    expect(r.text).not.toMatch(/drake-reference/i);
  });

  it('malformed model output falls back to the deterministic answer', async () => {
    const ctx = goldenContext(QUESTION);
    const r = await answerQuestion(QUESTION, {
      context: ctx,
      callModel: async () => ({ text: 'Your master is master-v8.wav, probably!', provider: 'local-http' }),
    });
    expect(r.source).toBe('deterministic');
    expect(r.rejectionReason).toMatch(/no JSON object/);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('an invented citation is rejected even when the prose looks fine', async () => {
    const ctx = goldenContext(QUESTION);
    const r = await answerQuestion(QUESTION, {
      context: ctx,
      callModel: async () => ({
        text: JSON.stringify({ answer: 'You are working on Sunshine.', citedContextIds: ['F42'], confidence: 'high' }),
        provider: 'local-http',
      }),
    });
    expect(r.source).toBe('deterministic');
    expect(r.rejectionReason).toMatch(/does not exist/);
  });

  it('works with no model at all', async () => {
    const r = await answerQuestion(QUESTION, { context: goldenContext(QUESTION) });
    expect(r.source).toBe('deterministic');
    expect(r.text).toContain('Bounces');
  });

  it('a 25,000-file library still yields a bounded prompt', () => {
    const files = Array.from({ length: 25_000 }, (_, i) => ({
      id: `f${i}`, name: `take-${i}.wav`, role: 'audio', status: 'synced', modifiedAt: NOW,
    }));
    const ctx = buildAssistantContext({
      query: '', project: { id: 'p', name: 'Big', dawType: 'ableton' },
      memory: [], facts: [], inferences: [], files, versions: [], recentActivity: [], now: NOW,
    });
    const prompt = buildGroundedPrompt({ question: 'q', context: ctx, deterministicAnswer: 'a' });
    expect(ctx.files.length).toBeLessThanOrEqual(20);
    // Comfortably inside a small model's window.
    expect(prompt.length).toBeLessThan(8_000);
  });
});
