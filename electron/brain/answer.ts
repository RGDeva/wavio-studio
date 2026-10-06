/**
 * Answering a natural-language question about the workspace.
 *
 * The pipeline, and the order matters:
 *
 *   question → Project Brain context → DETERMINISTIC answer
 *            → (optional) local model rephrases it
 *            → verify the rephrasing against the context
 *            → use it only if grounded, else keep the deterministic text
 *
 * The deterministic answer is produced first and is always correct, so the
 * model is never the source of a claim — only its wording. If no model is
 * installed, if it times out, or if it invents something, the user still gets
 * a true answer. That is what makes the model genuinely optional rather than
 * nominally optional.
 *
 * Pure except for the injected provider call.
 */
import type { AssistantContext } from './assistantContext';
import { buildGroundedPrompt, verifyGrounded, contextItemIds, type GroundingResult } from './grounding';
import { parseModelResponse, validateCitations, type Confidence } from './modelResponse';

export interface AnswerResult {
  text: string;
  /** 'deterministic' when no model ran or its output was rejected. */
  source: 'deterministic' | 'model';
  provider: string;
  /** Present when a model ran; explains why its output was or was not used. */
  grounding?: GroundingResult;
  /** Set when a model answered but was rejected, so the UI can say so. */
  rejectedModelOutput?: string;
  /** Why the model's answer was discarded, when it was. */
  rejectionReason?: string;
  /** The model's own confidence, when its answer was used. */
  confidence?: Confidence;
  /** Context ids the model cited, when its answer was used. */
  citedContextIds?: string[];
  context: AssistantContext;
}

function list(items: string[], max = 4): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  const joined = shown.length > 1
    ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
    : shown[0] ?? '';
  return rest > 0 ? `${joined} (+${rest} more)` : joined;
}

/**
 * Compose a true answer from the context alone.
 *
 * Deliberately plain rather than polished: this is the claim, and a model may
 * later make it read better. It must never say more than the context supports,
 * including saying "I don't know" when that is the honest answer.
 */
export function buildDeterministicAnswer(ctx: AssistantContext): string {
  const parts: string[] = [];

  if (ctx.userMemory.length) {
    const notes = ctx.userMemory.map((m) => m.value.value);
    parts.push(`You've told me: ${list(notes, 3)}.`);
  }

  if (ctx.project) {
    const daw = ctx.project.dawType ? ` (${ctx.project.dawType})` : '';
    const bits: string[] = [`${ctx.project.name}${daw}`];
    if (ctx.files.length) bits.push(`${ctx.files.length} relevant file${ctx.files.length === 1 ? '' : 's'}`);
    if (ctx.versions.length) {
      const latest = ctx.versions[0]?.versionNumber;
      if (latest != null) bits.push(`latest published version v${latest}`);
    }
    parts.push(`Project: ${bits.join(' · ')}.`);
  }

  if (ctx.files.length) {
    parts.push(`Files: ${list(ctx.files.map((f) => f.name))}.`);
  }

  for (const inf of ctx.inferences) {
    // Always flagged as a guess, with its evidence — never stated flatly.
    parts.push(`Probably ${inf.value.key.replace(/-/g, ' ')}: ${inf.value.value} (${inf.attribution.strength ?? 'uncertain'} guess — ${inf.attribution.evidence ?? 'no evidence'}).`);
  }

  if (ctx.recentActivity.length) {
    parts.push(`Recently: ${list(ctx.recentActivity.map((a) => a.message), 3)}.`);
  }

  for (const c of ctx.conflicts) {
    parts.push(`Note: you said ${c.key} is ${c.statedValue}, but the current scan shows ${c.indexValue} — the scan is what's on disk now.`);
  }

  if (parts.length === 0) {
    // The honest answer. A model is explicitly told not to embellish this.
    return "I don't have anything indexed that answers that.";
  }

  if (ctx.truncation.truncated) {
    parts.push('(This is a partial view of a larger library.)');
  }

  return parts.join(' ');
}

export interface AnswerDeps {
  /** Already-built context for the question. */
  context: AssistantContext;
  /** Returns the model's text, or null when unavailable/failed. */
  callModel?: (prompt: string) => Promise<{ text: string; provider: string } | null>;
}

/**
 * Answer a question, using a model only to improve the wording.
 */
export async function answerQuestion(question: string, deps: AnswerDeps): Promise<AnswerResult> {
  const ctx = deps.context;
  const deterministic = buildDeterministicAnswer(ctx);

  if (!deps.callModel) {
    return { text: deterministic, source: 'deterministic', provider: 'none', context: ctx };
  }

  let model: { text: string; provider: string } | null = null;
  try {
    model = await deps.callModel(buildGroundedPrompt({ question, context: ctx, deterministicAnswer: deterministic }));
  } catch {
    // A failing model must never take the answer down with it.
    model = null;
  }

  if (!model?.text?.trim()) {
    return { text: deterministic, source: 'deterministic', provider: model?.provider ?? 'none', context: ctx };
  }

  const reject = (reason: string, grounding?: GroundingResult): AnswerResult => ({
    text: deterministic,
    source: 'deterministic',
    provider: model!.provider,
    grounding,
    rejectedModelOutput: model!.text,
    rejectionReason: reason,
    context: ctx,
  });

  // 1. The reply must parse into the agreed structure. Free prose is
  //    unverifiable, so malformed output is discarded rather than shown.
  const parsed = parseModelResponse(model.text);
  if (!parsed.ok) return reject(parsed.reason);

  // 2. Citations must name context lines that actually exist. A model citing
  //    F9 when the context stopped at F3 has invented a source — a cheaper
  //    and stronger signal than inspecting the prose.
  const citations = validateCitations(parsed.value, contextItemIds(ctx));
  if (!citations.valid) {
    return reject(`cited context that does not exist: ${citations.unknown.join(', ')}`);
  }

  // 3. And the prose itself must not assert files, counts or versions the
  //    context never mentioned.
  const grounding = verifyGrounded(parsed.value.answer, ctx);
  if (!grounding.grounded) {
    return reject(`unsupported claims: ${grounding.unsupported.join(', ')}`, grounding);
  }

  return {
    text: parsed.value.answer,
    source: 'model',
    provider: model.provider,
    grounding,
    confidence: parsed.value.confidence,
    citedContextIds: parsed.value.citedContextIds,
    context: ctx,
  };
}
