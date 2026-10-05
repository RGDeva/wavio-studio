/**
 * Project Brain — deterministic query language.
 *
 * A later local LLM agent will turn natural language ("that vocal take from
 * the Midnight session in June") into one of these structured queries. This
 * module is the boundary: everything below it is deterministic and
 * explainable, so the brain's answers never depend on model behaviour.
 *
 * Deliberately NOT a natural-language parser. It understands tokens, quoted
 * phrases and a small set of field filters, because those are the parts a
 * model can map onto reliably and a human can read back. Anything fuzzier
 * belongs above this line, not inside it.
 *
 * Pure: no I/O, no Electron.
 */

export interface BrainQuery {
  /** Free tokens, lowercased, order-insensitive. */
  terms: string[];
  /** Quoted phrases, lowercased, matched as contiguous substrings. */
  phrases: string[];
  /** Field filters. An unknown field is kept as a term rather than dropped. */
  filters: {
    daw?: string;
    role?: string;
    project?: string;
    type?: string;
    /** ISO date (inclusive lower bound) on modified/created time. */
    after?: string;
    /** ISO date (inclusive upper bound). */
    before?: string;
    bpm?: number;
    key?: string;
    /** Sync state, e.g. 'synced' | 'pending' | 'failed' | 'missing'. */
    status?: string;
  };
  /** Terms the caller wrote that we could not interpret — surfaced, not silently dropped. */
  uninterpreted: string[];
}

const KNOWN_FIELDS = new Set(['daw', 'role', 'project', 'type', 'after', 'before', 'bpm', 'key', 'status']);

/** Month names → 1-based index, for `after:june` style shorthands. */
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * Resolve a date-ish token to an ISO instant.
 *
 * `referenceYear` is injected rather than read from the clock so the same
 * query parses identically in a test, next week, and next year — a brain whose
 * answers drift with the wall clock is not deterministic.
 */
export function resolveDateToken(token: string, referenceYear: number, edge: 'start' | 'end'): string | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;

  // Full ISO date
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return edge === 'start' ? `${t}T00:00:00.000Z` : `${t}T23:59:59.999Z`;
  }
  // Year only
  const year = t.match(/^(\d{4})$/);
  if (year) {
    return edge === 'start' ? `${t}-01-01T00:00:00.000Z` : `${t}-12-31T23:59:59.999Z`;
  }
  // Month name, optionally with a day and/or year: "june", "june 22", "june 2026"
  const m = t.match(/^([a-z]+)(?:\s+(\d{1,2}))?(?:\s+(\d{4}))?$/);
  if (m && MONTHS[m[1]]) {
    const month = MONTHS[m[1]];
    const y = m[3] ? parseInt(m[3], 10) : referenceYear;
    const day = m[2] ? parseInt(m[2], 10) : null;
    const mm = String(month).padStart(2, '0');
    if (day !== null) {
      const dd = String(day).padStart(2, '0');
      return edge === 'start' ? `${y}-${mm}-${dd}T00:00:00.000Z` : `${y}-${mm}-${dd}T23:59:59.999Z`;
    }
    if (edge === 'start') return `${y}-${mm}-01T00:00:00.000Z`;
    // Last day of the month, via day 0 of the next month.
    const last = new Date(Date.UTC(y, month, 0)).getUTCDate();
    return `${y}-${mm}-${String(last).padStart(2, '0')}T23:59:59.999Z`;
  }
  return null;
}

/**
 * Parse a query string. Never throws: an unparseable fragment becomes a term
 * or lands in `uninterpreted`, because silently discarding part of what the
 * caller asked for is how a retrieval layer starts lying.
 */
export function parseBrainQuery(input: string, referenceYear: number): BrainQuery {
  const q: BrainQuery = { terms: [], phrases: [], filters: {}, uninterpreted: [] };
  if (typeof input !== 'string') return q;

  // Pull quoted phrases out first so their spaces do not split into terms.
  const rest = input.replace(/"([^"]*)"/g, (_m, phrase: string) => {
    const p = String(phrase).trim().toLowerCase();
    if (p) q.phrases.push(p);
    return ' ';
  });

  for (const raw of rest.split(/\s+/)) {
    const token = raw.trim();
    if (!token) continue;

    const colon = token.indexOf(':');
    if (colon > 0) {
      const field = token.slice(0, colon).toLowerCase();
      const value = token.slice(colon + 1).trim();
      if (KNOWN_FIELDS.has(field)) {
        if (!value) { q.uninterpreted.push(token); continue; }
        switch (field) {
          case 'bpm': {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) q.filters.bpm = Math.round(n);
            else q.uninterpreted.push(token);
            break;
          }
          case 'after':
          case 'before': {
            const edge = field === 'after' ? 'start' : 'end';
            const resolved = resolveDateToken(value, referenceYear, edge);
            if (resolved) q.filters[field] = resolved;
            else q.uninterpreted.push(token);
            break;
          }
          default:
            (q.filters as Record<string, string>)[field] = value.toLowerCase();
        }
        continue;
      }
      // Unknown field — keep the whole token as a search term rather than
      // guessing, so "die:this" still finds something.
      q.terms.push(token.toLowerCase());
      continue;
    }
    q.terms.push(token.toLowerCase());
  }

  return q;
}

/** True when the query asks for nothing at all. */
export function isEmptyQuery(q: BrainQuery): boolean {
  return q.terms.length === 0 && q.phrases.length === 0 && Object.keys(q.filters).length === 0;
}
