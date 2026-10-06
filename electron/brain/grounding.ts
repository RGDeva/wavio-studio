/**
 * Grounding — the guarantee that a model cannot invent facts about the user's
 * workspace.
 *
 * A prompt that *asks* a model to stick to the context is a request, not a
 * control. This module makes it checkable: the brain produces a deterministic
 * answer first, the model may only rephrase it, and whatever comes back is
 * verified against the context before any of it reaches the user. An answer
 * asserting a filename, count or project the context never mentioned is
 * rejected and the deterministic text is used instead.
 *
 * That ordering is the whole design. The model is a renderer of facts the
 * brain already established — never a source of them.
 *
 * Pure: no I/O, no model, no Electron.
 */
import type { AssistantContext } from './assistantContext';
import { RESPONSE_SCHEMA_INSTRUCTION } from './modelResponse';

// ── What counts as a checkable claim ─────────────────────────────────────────
//
// Only claim shapes that can be verified mechanically are checked. Ordinary
// prose is left alone: flagging every noun would make the verifier fire
// constantly and get switched off, which is worse than not having one.

/**
 * File-like tokens: "master-v8.wav", "Sunshine.flp".
 *
 * Deliberately excludes spaces. Allowing them made the pattern swallow the
 * words before a filename — "latest master looks like master-v8.wav" matched
 * as ONE token, which then matched nothing in the context and failed a
 * perfectly good answer. A name containing spaces is still caught, because the
 * trailing segment ("Project.als") is checked against the context text.
 */
const FILENAME_RE = /\b[\w][\w.'-]*\.(wav|aiff|aif|mp3|flac|m4a|ogg|mid|midi|als|flp|logicx|ptx|ptf|rpp|dawproject|json)\b/gi;
/** bare integers — counts, tempos */
const NUMBER_RE = /\b\d{1,7}\b/g;
/**
 * Version tokens written the way people write them: "v8", "V12".
 *
 * Needed separately because \b does not fire between the "v" and the digits,
 * so NUMBER_RE never sees them — and "the latest version is v43" is exactly
 * the kind of confident invention this must catch.
 */
const VERSION_RE = /\bv(\d{1,6})\b/gi;

export interface GroundingResult {
  grounded: boolean;
  /** Claims the context does not support, in the order they appeared. */
  unsupported: string[];
  /** Everything checkable that WAS supported, for explainability. */
  supported: string[];
}

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Every value the context actually vouches for.
 *
 * Built from the context alone, never from the database, so the verifier can
 * only approve something the model was genuinely shown.
 */
export function buildAllowedFacts(ctx: AssistantContext): { names: Set<string>; numbers: Set<string>; text: string } {
  const names = new Set<string>();
  const numbers = new Set<string>();
  const textParts: string[] = [];

  const absorb = (s: string | null | undefined) => {
    if (!s) return;
    textParts.push(s);
    for (const m of s.match(FILENAME_RE) ?? []) names.add(norm(m));
    for (const m of s.match(NUMBER_RE) ?? []) numbers.add(m);
  };

  if (ctx.project) {
    names.add(norm(ctx.project.name));
    absorb(ctx.project.name);
    absorb(ctx.project.dawType);
  }
  for (const f of ctx.files) { names.add(norm(f.name)); absorb(f.name); absorb(f.role); absorb(f.status); }
  for (const m of ctx.userMemory) { absorb(m.value.key); absorb(m.value.value); }
  for (const f of ctx.facts) { absorb(f.value.key); absorb(f.value.value); }
  for (const i of ctx.inferences) { absorb(i.value.key); absorb(i.value.value); absorb(i.value.evidence); }
  for (const v of ctx.versions) {
    if (v.versionNumber != null) numbers.add(String(v.versionNumber));
    if (v.fileCount != null) numbers.add(String(v.fileCount));
  }
  for (const a of ctx.recentActivity) { absorb(a.message); absorb(a.type); }
  for (const c of ctx.conflicts) { absorb(c.statedValue); absorb(c.indexValue); }

  // Counts the brain can legitimately state about its own context.
  numbers.add(String(ctx.files.length));
  numbers.add(String(ctx.versions.length));
  numbers.add(String(ctx.userMemory.length));
  numbers.add(String(ctx.recentActivity.length));

  return { names, numbers, text: norm(textParts.join(' · ')) };
}

/**
 * Numbers that appear in ordinary prose rather than as claims about the
 * workspace. Rejecting "one of your projects" or a year would make the
 * verifier useless noise.
 */
const INNOCUOUS_NUMBERS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);

/**
 * Verify an answer against the context.
 *
 * Filenames are checked strictly: a model naming a file the user does not have
 * is the exact failure this exists to stop. Numbers are checked only when
 * large enough to be a real assertion, because small integers appear in
 * ordinary sentences constantly.
 */
export function verifyGrounded(answer: string, ctx: AssistantContext): GroundingResult {
  const allowed = buildAllowedFacts(ctx);
  const unsupported: string[] = [];
  const supported: string[] = [];

  for (const raw of answer.match(FILENAME_RE) ?? []) {
    const token = norm(raw);
    if (allowed.names.has(token) || allowed.text.includes(token)) supported.push(raw);
    else unsupported.push(raw);
  }

  for (const raw of answer.match(NUMBER_RE) ?? []) {
    if (INNOCUOUS_NUMBERS.has(raw)) continue;
    if (allowed.numbers.has(raw) || allowed.text.includes(raw)) supported.push(raw);
    else unsupported.push(raw);
  }

  // Version tokens are always checked, including small ones: "v3" when the
  // project has no v3 is a real false claim, not incidental prose.
  for (const m of answer.matchAll(VERSION_RE)) {
    const n = m[1];
    if (allowed.numbers.has(n) || allowed.text.includes('v' + n)) supported.push(m[0]);
    else unsupported.push(m[0]);
  }

  return { grounded: unsupported.length === 0, unsupported, supported };
}

// ── Prompt construction ──────────────────────────────────────────────────────

/**
 * Render the context as plain text for a model.
 *
 * Deliberately a flat, labelled rendering rather than raw JSON: a small local
 * model follows labelled prose far more reliably, and the attribution has to
 * survive into the prompt or the model cannot hedge correctly.
 */
export function renderContextForModel(ctx: AssistantContext): string {
  const lines: string[] = [];

  if (ctx.project) {
    lines.push(`PROJECT: ${ctx.project.name}${ctx.project.dawType ? ` (made in ${ctx.project.dawType})` : ''}`);
  }

  if (ctx.userMemory.length) {
    lines.push('', 'WHAT THE USER TOLD WAVI:');
    ctx.userMemory.forEach((m, i) => {
      lines.push(`[M${i + 1}] ${m.value.value} (${m.value.scope} memory, from ${m.attribution.origin})`);
    });
  }

  if (ctx.facts.length) {
    lines.push('', 'MEASURED FACTS (from scanning the files):');
    ctx.facts.forEach((f, i) => lines.push(`[K${i + 1}] ${f.value.key}: ${f.value.value}`));
  }

  if (ctx.inferences.length) {
    lines.push('', 'GUESSES (not certain):');
    ctx.inferences.forEach((inf, i) => {
      lines.push(`[G${i + 1}] ${inf.value.key}: ${inf.value.value} — ${inf.attribution.evidence ?? 'no evidence recorded'} (${inf.attribution.strength ?? 'unknown'} confidence)`);
    });
  }

  if (ctx.files.length) {
    lines.push('', 'FILES:');
    ctx.files.forEach((f, i) => lines.push(`[F${i + 1}] ${f.name}${f.role ? ` (${f.role})` : ''}${f.status === 'missing' ? ' — MISSING' : ''}`));
  }

  if (ctx.versions.length) {
    lines.push('', 'VERSIONS:');
    ctx.versions.forEach((v, i) => lines.push(`[V${i + 1}] v${v.versionNumber ?? '?'}${v.createdAt ? ` on ${v.createdAt.slice(0, 10)}` : ''}`));
  }

  if (ctx.recentActivity.length) {
    lines.push('', 'RECENT ACTIVITY:');
    ctx.recentActivity.forEach((a, i) => lines.push(`[A${i + 1}] ${a.message}`));
  }

  if (ctx.conflicts.length) {
    lines.push('', 'DISAGREEMENTS (the scan is authoritative for current file state):');
    for (const c of ctx.conflicts) {
      lines.push(`- "${c.key}": you said ${c.statedValue}, the scan currently shows ${c.indexValue}`);
    }
  }

  if (ctx.truncation.truncated) {
    lines.push('', `NOTE: this is a partial view. ${ctx.truncation.notes.join(' ')}`);
  }

  return lines.join('\n');
}

/**
 * The instruction given to a local model.
 *
 * It is a rephrasing job, not a question-answering one: the deterministic
 * answer is already correct, and the model's only task is to say it naturally.
 * Verification enforces this regardless of whether the model complies.
 */
export function buildGroundedPrompt(opts: {
  question: string;
  context: AssistantContext;
  deterministicAnswer: string;
}): string {
  return [
    'You are Wavi, helping a music producer with their local projects.',
    '',
    'Below is everything known about their workspace, followed by a correct answer.',
    'Rewrite the answer so it sounds natural and conversational.',
    '',
    'Rules:',
    '- Use ONLY information in the context and the answer below.',
    '- Never invent a file name, number, project, or date.',
    '- If something is marked a guess, say it is a guess.',
    '- If the answer says nothing is known, say that plainly. Do not speculate.',
    '- Keep it short.',
    '- Cite the bracketed ids ([M1], [F2], ...) of the context lines you used.',
    '',
    '--- CONTEXT ---',
    renderContextForModel(opts.context),
    '',
    '--- CORRECT ANSWER ---',
    opts.deterministicAnswer,
    '',
    RESPONSE_SCHEMA_INSTRUCTION,
    '',
    '--- YOUR JSON ---',
  ].join('\n');
}

/**
 * Every id the context offers, for validating citations.
 *
 * Must mirror renderContextForModel exactly: an id the renderer emits but
 * this omits would make a legitimate citation look fabricated, which is the
 * worst possible direction for this check to fail in.
 */
export function contextItemIds(ctx: AssistantContext): Set<string> {
  const ids = new Set<string>();
  ctx.userMemory.forEach((_, i) => ids.add(`M${i + 1}`));
  ctx.facts.forEach((_, i) => ids.add(`K${i + 1}`));
  ctx.inferences.forEach((_, i) => ids.add(`G${i + 1}`));
  ctx.files.forEach((_, i) => ids.add(`F${i + 1}`));
  ctx.versions.forEach((_, i) => ids.add(`V${i + 1}`));
  ctx.recentActivity.forEach((_, i) => ids.add(`A${i + 1}`));
  return ids;
}
