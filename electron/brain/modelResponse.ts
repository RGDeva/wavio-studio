/**
 * The structured contract a local model must answer in.
 *
 * Free prose is unverifiable: you cannot tell which part of the context a
 * sentence came from, so you cannot tell when it came from nowhere. Requiring
 * the model to cite the context items it used turns "did it make this up?"
 * into a mechanical check — a citation naming an item that does not exist is
 * a fabrication signal on its own, before the prose is even examined.
 *
 * Parsing is deliberately tolerant of how small models actually behave (code
 * fences, a sentence before the JSON) and strict about the shape once found.
 * Anything that fails validation is discarded and the deterministic answer is
 * used instead.
 *
 * Pure: no I/O, no model.
 */

export type Confidence = 'high' | 'medium' | 'low';

export interface ModelAnswer {
  answer: string;
  /** Ids of context items the answer relies on, e.g. ['M1', 'F2']. */
  citedContextIds: string[];
  confidence: Confidence;
}

export type ParseResult =
  | { ok: true; value: ModelAnswer }
  | { ok: false; reason: string };

const CONFIDENCES = new Set<Confidence>(['high', 'medium', 'low']);

/**
 * Pull the first balanced JSON object out of a model's reply.
 *
 * Small instruct models routinely wrap JSON in ``` fences or precede it with
 * "Sure, here you go:". Rejecting those would discard answers that are
 * perfectly well-formed underneath, so the object is located rather than
 * assumed to be the entire string.
 */
export function extractJsonObject(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse and validate. Never throws. */
export function parseModelResponse(raw: string): ParseResult {
  const json = extractJsonObject(raw ?? '');
  if (!json) return { ok: false, reason: 'no JSON object in model output' };

  let obj: unknown;
  try { obj = JSON.parse(json); } catch { return { ok: false, reason: 'model output is not valid JSON' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reason: 'model output is not an object' };
  }

  const o = obj as Record<string, unknown>;

  if (typeof o.answer !== 'string' || !o.answer.trim()) {
    return { ok: false, reason: 'missing or empty "answer"' };
  }

  // Citations are required but may legitimately be empty: "I don't know" is a
  // valid answer that cites nothing, and demanding a citation there would
  // push the model to invent one.
  let cited: string[] = [];
  if (Array.isArray(o.citedContextIds)) {
    if (!o.citedContextIds.every((c) => typeof c === 'string')) {
      return { ok: false, reason: '"citedContextIds" must be strings' };
    }
    cited = (o.citedContextIds as string[]).map((c) => c.trim().toUpperCase()).filter(Boolean);
  } else if (o.citedContextIds !== undefined) {
    return { ok: false, reason: '"citedContextIds" must be an array' };
  }

  const confRaw = typeof o.confidence === 'string' ? o.confidence.toLowerCase().trim() : '';
  if (!CONFIDENCES.has(confRaw as Confidence)) {
    return { ok: false, reason: `"confidence" must be one of high|medium|low` };
  }

  return {
    ok: true,
    value: { answer: o.answer.trim(), citedContextIds: cited, confidence: confRaw as Confidence },
  };
}

export interface CitationCheck {
  valid: boolean;
  /** Cited ids that do not exist in the context. */
  unknown: string[];
}

/**
 * Check citations against the ids actually offered.
 *
 * A model citing `F9` when the context stopped at `F3` has invented a source,
 * which is a stronger and cheaper signal than inspecting the prose — so it is
 * treated as a validation failure in its own right.
 */
export function validateCitations(answer: ModelAnswer, knownIds: Iterable<string>): CitationCheck {
  const known = new Set([...knownIds].map((k) => k.toUpperCase()));
  const unknown = answer.citedContextIds.filter((c) => !known.has(c));
  return { valid: unknown.length === 0, unknown };
}

/** The response shape, rendered for the prompt. */
export const RESPONSE_SCHEMA_INSTRUCTION = [
  'Reply with ONLY a JSON object, no other text:',
  '{',
  '  "answer": "<your reply in one or two short sentences>",',
  '  "citedContextIds": ["<ids of the context lines you used, e.g. M1, F2>"],',
  '  "confidence": "high" | "medium" | "low"',
  '}',
  'If the context does not answer the question, say so in "answer", cite nothing, and use "low".',
].join('\n');
