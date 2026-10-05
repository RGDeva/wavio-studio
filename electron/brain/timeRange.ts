/**
 * Project Brain — time ranges.
 *
 * "Yesterday", "this week", "last month" are the shape most questions about a
 * music library take. Resolving them here, deterministically and against an
 * injected `now`, keeps the answer reproducible: a model that computed the
 * window itself would quietly shift the answer every time it ran.
 *
 * All ranges are half-open-ish ISO instants [from, to] in UTC, because every
 * timestamp the index stores is an ISO string compared lexically.
 *
 * Pure: no I/O, no clock.
 */

export type NamedRange = 'today' | 'yesterday' | 'this-week' | 'last-week' | 'this-month' | 'last-month' | 'all-time';

export interface TimeRange {
  from: string;
  to: string;
  label: string;
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}
function iso(d: Date): string { return d.toISOString(); }
function endOfDay(d: Date): string {
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999)));
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/**
 * Weeks start Monday.
 *
 * A producer asking "what did I work on this week?" on a Sunday night means
 * the week they have been working, not one that ended that morning — a
 * Sunday-start week would answer with an almost-empty window.
 */
function startOfWeek(d: Date): Date {
  const day = d.getUTCDay();            // 0 = Sunday
  const back = day === 0 ? 6 : day - 1; // Monday-based
  return startOfDay(addDays(d, -back));
}

export function resolveNamedRange(name: NamedRange, nowIso: string): TimeRange {
  const now = new Date(nowIso);
  switch (name) {
    case 'today':
      return { from: iso(startOfDay(now)), to: endOfDay(now), label: 'today' };
    case 'yesterday': {
      const y = addDays(now, -1);
      return { from: iso(startOfDay(y)), to: endOfDay(y), label: 'yesterday' };
    }
    case 'this-week':
      return { from: iso(startOfWeek(now)), to: endOfDay(now), label: 'this week' };
    case 'last-week': {
      const thisWeek = startOfWeek(now);
      const lastWeek = addDays(thisWeek, -7);
      return { from: iso(lastWeek), to: endOfDay(addDays(thisWeek, -1)), label: 'last week' };
    }
    case 'this-month': {
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { from: iso(first), to: endOfDay(now), label: 'this month' };
    }
    case 'last-month': {
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
      return { from: iso(first), to: endOfDay(last), label: 'last month' };
    }
    case 'all-time':
      return { from: '0000-01-01T00:00:00.000Z', to: endOfDay(now), label: 'all time' };
  }
}

const ALIASES: Record<string, NamedRange> = {
  today: 'today',
  yesterday: 'yesterday',
  'this week': 'this-week', week: 'this-week', 'this-week': 'this-week',
  'last week': 'last-week', 'last-week': 'last-week',
  'this month': 'this-month', month: 'this-month', 'this-month': 'this-month',
  'last month': 'last-month', 'last-month': 'last-month',
  all: 'all-time', 'all time': 'all-time', 'all-time': 'all-time', ever: 'all-time',
};

/**
 * Resolve a loosely-written range. Returns null when it means nothing, so the
 * caller can say "I don't know that range" rather than silently defaulting to
 * a window the user did not ask for.
 */
export function parseRange(input: string | null | undefined, nowIso: string): TimeRange | null {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  const named = ALIASES[key];
  if (named) return resolveNamedRange(named, nowIso);

  // "last 7 days" / "7d" / "30 days"
  const rel = key.match(/^(?:last\s+)?(\d{1,4})\s*(d|days?|w|weeks?|m|months?)$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2][0];
    const days = unit === 'd' ? n : unit === 'w' ? n * 7 : n * 30;
    const now = new Date(nowIso);
    return { from: iso(startOfDay(addDays(now, -days))), to: endOfDay(now), label: `last ${n}${unit === 'd' ? ' days' : unit === 'w' ? ' weeks' : ' months'}` };
  }
  return null;
}
