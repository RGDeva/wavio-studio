/**
 * Project Brain — making raw activity readable.
 *
 * One DAW save can produce dozens of low-level rows ("kick.wav analysed",
 * "bass.wav analysed", …). Those are worth keeping: each is a real
 * observation, and deleting them would throw away history the user may later
 * need.
 *
 * So coalescing happens at READ time, not write time. The log stays complete;
 * what the assistant sees is grouped, so "what did I work on this week?" reads
 * like an answer rather than a transaction dump.
 *
 * Pure: no I/O, no clock.
 */

export interface RawActivity {
  type: string;
  message: string;
  projectId: string | null;
  projectName: string | null;
  at: string;
}

export interface ActivityGroup {
  type: string;
  projectId: string | null;
  projectName: string | null;
  /** How many raw rows this group represents. */
  count: number;
  /** Oldest and newest timestamps in the group. */
  firstAt: string;
  lastAt: string;
  /** A representative line; for a group of one, the original message. */
  summary: string;
  /** Up to a few examples, so detail is available without the full dump. */
  examples: string[];
}

const MAX_EXAMPLES = 3;

/**
 * Group consecutive same-type, same-project events that happened close
 * together.
 *
 * Grouping is bounded by a time window rather than merging a whole range: a
 * file changed this morning and the same file changed last Tuesday are two
 * separate pieces of information, and flattening them would answer "when did
 * this change?" wrongly.
 */
export function coalesceActivity(events: RawActivity[], windowMs = 120_000): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  // Newest-first in, newest-first out — the order the caller already uses.
  for (const e of events) {
    const last = groups[groups.length - 1];
    const sameBucket = last
      && last.type === e.type
      && last.projectId === e.projectId
      && Math.abs(Date.parse(last.firstAt) - Date.parse(e.at)) <= windowMs;

    if (sameBucket) {
      last.count++;
      // Events arrive newest-first, so each successive one is older.
      last.firstAt = e.at < last.firstAt ? e.at : last.firstAt;
      last.lastAt = e.at > last.lastAt ? e.at : last.lastAt;
      if (last.examples.length < MAX_EXAMPLES) last.examples.push(e.message);
      continue;
    }
    groups.push({
      type: e.type, projectId: e.projectId, projectName: e.projectName,
      count: 1, firstAt: e.at, lastAt: e.at,
      summary: e.message, examples: [e.message],
    });
  }

  // Only rewrite the summary where grouping actually happened, so a single
  // event still reads as itself rather than as "1 × something".
  for (const g of groups) {
    if (g.count > 1) {
      const where = g.projectName ? ` in ${g.projectName}` : '';
      g.summary = `${g.count} × ${g.type.replace(/_/g, ' ')}${where}`;
    }
  }
  return groups;
}

/** Totals by event type, for a quick "what kind of work was this?" read. */
export function summarizeActivity(events: RawActivity[]): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    // Stable: count desc, then type asc, so the same input always renders the
    // same way.
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}
