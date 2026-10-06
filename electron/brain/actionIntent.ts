/**
 * Requests the agent refuses to act on at all.
 *
 * The allowlist already makes a destructive action impossible to perform: no
 * delete, move, rename or shell tool exists for a model to name. This module
 * exists for the step before that — so a request to destroy something is
 * answered with a plain refusal rather than a cheerful, irrelevant suggestion,
 * and so the refusal is recorded as one.
 *
 * It is a courtesy layer, deliberately NOT a safety layer. Nothing downstream
 * relies on it: a request that slips past these patterns still cannot reach a
 * capability the allowlist withholds. Phrasing this the other way round —
 * pattern-matching as the defence — is how prompt-level filters fail.
 *
 * Pure: no I/O.
 */

export type UnsupportedCategory = 'shell' | 'destructive' | 'permissions';

export interface UnsupportedIntent {
  category: UnsupportedCategory;
  /** What the user is told. Plain, final, and not a negotiation. */
  message: string;
}

const PATTERNS: Array<{ re: RegExp; category: UnsupportedCategory; message: string }> = [
  {
    // Shell is not a capability Wavi has at all, in any mode.
    re: /\b(rm\s+-[rf]|sudo\b|chmod\b|chown\b|curl\s+http|wget\s+http|osascript\b|\bbash\b|\bzsh\b|shell command|terminal command)/i,
    category: 'shell',
    message: 'Wavi can’t run shell commands — there is no path from the assistant to a terminal, by design.',
  },
  {
    re: /\b(delete|erase|wipe|trash|remove|rm)\b.{0,40}\b(file|files|mix|mixes|project|projects|track|tracks|folder|everything|all)\b/i,
    category: 'destructive',
    message: 'Wavi’s assistant can’t delete anything. Deleting is something you do yourself in Finder or your DAW, so an agent mistake can’t cost you work.',
  },
  {
    re: /\b(rename|move)\b.{0,30}\b(file|files|project|projects|folder)\b/i,
    category: 'destructive',
    message: 'Wavi’s assistant can’t move or rename files — your folder layout stays yours to change.',
  },
  {
    re: /\b(revoke|remove)\b.{0,30}\b(access|collaborator|permission|permissions)\b/i,
    category: 'permissions',
    message: 'Wavi’s assistant can’t change who has access. You can revoke a Project Link yourself on the Links page.',
  },
];

/**
 * Classify a request the agent will not act on.
 *
 * Returns null for everything else — including requests it simply has no tool
 * for, which are handled by the allowlist rather than guessed at here.
 */
export function detectUnsupportedIntent(question: string): UnsupportedIntent | null {
  const q = String(question ?? '');
  if (!q.trim()) return null;
  for (const p of PATTERNS) {
    if (p.re.test(q)) return { category: p.category, message: p.message };
  }
  return null;
}
