/**
 * Project Brain — query parsing and deterministic retrieval.
 *
 * The property under test is not "finds good results" but "finds the SAME
 * results, in the same order, for the same index and query, and can say why".
 * A later LLM agent presents these as fact, so drift or an unexplainable hit
 * is a correctness bug rather than a quality one.
 */
import { describe, it, expect } from 'vitest';
import { parseBrainQuery, resolveDateToken, isEmptyQuery } from './query';
import {
  rankRecords, scoreRecord, passesFilters, groupHitsByProject,
  type BrainRecord,
} from './retrieval';

const NOW = '2026-10-04T12:00:00.000Z';
const YEAR = 2026;

function rec(over: Partial<BrainRecord> & { id: string }): BrainRecord {
  return {
    kind: 'file', projectId: 'p1', name: 'kick.wav', projectName: 'Midnight Sketch',
    dawType: 'ableton', role: 'audio', fileType: 'wav', bpm: null, keyNote: null,
    status: 'synced', modifiedAt: '2026-06-22T10:00:00.000Z',
    ...over,
  };
}

describe('query parsing', () => {
  it('splits terms and keeps quoted phrases intact', () => {
    const q = parseBrainQuery('vocal "die this way" take', YEAR);
    expect(q.terms).toEqual(['vocal', 'take']);
    expect(q.phrases).toEqual(['die this way']);
  });

  it('reads field filters', () => {
    const q = parseBrainQuery('daw:ableton role:stem bpm:128 key:Am status:synced', YEAR);
    expect(q.filters).toMatchObject({ daw: 'ableton', role: 'stem', bpm: 128, key: 'am', status: 'synced' });
  });

  it('keeps an unknown field as a search term instead of dropping it', () => {
    // Dropping part of what the caller asked for is how retrieval starts lying.
    const q = parseBrainQuery('die:this', YEAR);
    expect(q.terms).toEqual(['die:this']);
    expect(q.uninterpreted).toEqual([]);
  });

  it('surfaces a known field with an unusable value rather than ignoring it', () => {
    const q = parseBrainQuery('bpm:fast after:nonsense', YEAR);
    expect(q.filters.bpm).toBeUndefined();
    expect(q.uninterpreted).toEqual(['bpm:fast', 'after:nonsense']);
  });

  it('never throws on junk input', () => {
    expect(() => parseBrainQuery('"""   :::  ', YEAR)).not.toThrow();
    expect(isEmptyQuery(parseBrainQuery('   ', YEAR))).toBe(true);
  });
});

describe('date resolution is reference-year driven, not clock driven', () => {
  it('resolves a month name to its full span', () => {
    // The reference year is injected so this query parses identically today,
    // next week and next year.
    expect(resolveDateToken('june', 2026, 'start')).toBe('2026-06-01T00:00:00.000Z');
    expect(resolveDateToken('june', 2026, 'end')).toBe('2026-06-30T23:59:59.999Z');
  });

  it('handles month + day, and month + explicit year', () => {
    expect(resolveDateToken('june 22', 2026, 'start')).toBe('2026-06-22T00:00:00.000Z');
    expect(resolveDateToken('june 2024', 2026, 'end')).toBe('2024-06-30T23:59:59.999Z');
  });

  it('gets February right in a leap year', () => {
    expect(resolveDateToken('february', 2024, 'end')).toBe('2024-02-29T23:59:59.999Z');
    expect(resolveDateToken('february', 2026, 'end')).toBe('2026-02-28T23:59:59.999Z');
  });

  it('handles ISO dates and bare years', () => {
    expect(resolveDateToken('2026-06-22', 2026, 'start')).toBe('2026-06-22T00:00:00.000Z');
    expect(resolveDateToken('2025', 2026, 'end')).toBe('2025-12-31T23:59:59.999Z');
  });

  it('returns null for something it cannot interpret', () => {
    expect(resolveDateToken('soonish', 2026, 'start')).toBeNull();
  });
});

describe('filters are gates, never score', () => {
  it('excludes a strong name match that fails a filter', () => {
    // A query saying daw:ableton must never surface an FL project just
    // because its name matched perfectly.
    const r = rec({ id: 'f1', name: 'kick.wav', dawType: 'fl-studio' });
    const q = parseBrainQuery('kick daw:ableton', YEAR);
    expect(scoreRecord(r, q, NOW)).toBeNull();
    expect(passesFilters(r, q)).toEqual({ ok: false, failed: 'daw:ableton' });
  });

  it('reports which filter rejected the record', () => {
    const r = rec({ id: 'f1', bpm: 120 });
    expect(passesFilters(r, parseBrainQuery('bpm:128', YEAR))).toEqual({ ok: false, failed: 'bpm:128' });
  });

  it('applies date bounds against modifiedAt', () => {
    const june = rec({ id: 'f1', modifiedAt: '2026-06-22T10:00:00.000Z' });
    const july = rec({ id: 'f2', modifiedAt: '2026-07-02T10:00:00.000Z' });
    const q = parseBrainQuery('after:june before:june', YEAR);
    expect(passesFilters(june, q).ok).toBe(true);
    expect(passesFilters(july, q).ok).toBe(false);
  });

  it('a filters-only query returns the filtered set', () => {
    const hits = rankRecords([rec({ id: 'f1' }), rec({ id: 'f2', dawType: 'reaper' })],
      parseBrainQuery('daw:ableton', YEAR), { now: NOW });
    expect(hits.map((h) => h.record.id)).toEqual(['f1']);
    expect(hits[0].matchedOn).toContain('matched filters only');
  });
});

describe('term semantics', () => {
  it('requires EVERY term to match (AND, not OR)', () => {
    // OR floods results with one-common-word matches and makes "why did this
    // match?" useless.
    const r = rec({ id: 'f1', name: 'vocal take 3.wav' });
    expect(scoreRecord(r, parseBrainQuery('vocal take', YEAR), NOW)).not.toBeNull();
    expect(scoreRecord(r, parseBrainQuery('vocal guitar', YEAR), NOW)).toBeNull();
  });

  it('treats a quoted phrase as a hard requirement', () => {
    const r = rec({ id: 'f1', name: 'die this way.wav' });
    expect(scoreRecord(r, parseBrainQuery('"die this way"', YEAR), NOW)).not.toBeNull();
    expect(scoreRecord(r, parseBrainQuery('"die that way"', YEAR), NOW)).toBeNull();
  });

  it('matches tokens inside punctuated file names', () => {
    const r = rec({ id: 'f1', name: 'kick_drum-01.wav' });
    expect(scoreRecord(r, parseBrainQuery('drum', YEAR), NOW)).not.toBeNull();
  });

  it('falls back to the project name, then to role/type', () => {
    const r = rec({ id: 'f1', name: 'take.wav', projectName: 'Midnight Sketch', role: 'stem' });
    expect(scoreRecord(r, parseBrainQuery('midnight', YEAR), NOW)!.matchedOn[0]).toMatch(/project name/);
    expect(scoreRecord(r, parseBrainQuery('stem', YEAR), NOW)!.matchedOn[0]).toMatch(/role\/type/);
  });
});

describe('ranking is explainable and totally ordered', () => {
  it('ranks an exact name match above a project-name match', () => {
    const exact = rec({ id: 'a', name: 'vocal' });
    const viaProject = rec({ id: 'b', name: 'other.wav', projectName: 'vocal sessions' });
    const hits = rankRecords([viaProject, exact], parseBrainQuery('vocal', YEAR), { now: NOW });
    expect(hits.map((h) => h.record.id)).toEqual(['a', 'b']);
  });

  it('every hit explains itself', () => {
    const hits = rankRecords([rec({ id: 'a', name: 'vocal.wav' })], parseBrainQuery('vocal', YEAR), { now: NOW });
    expect(hits[0].matchedOn.length).toBeGreaterThan(0);
    expect(hits[0].matchedOn[0]).toContain('vocal');
  });

  it('breaks ties deterministically by recency then id, not by input order', () => {
    // Identical scores must not let row order leak into the answer.
    const a = rec({ id: 'aaa', name: 'vocal.wav', modifiedAt: '2026-06-01T00:00:00.000Z' });
    const b = rec({ id: 'bbb', name: 'vocal.wav', modifiedAt: '2026-06-01T00:00:00.000Z' });
    const forward = rankRecords([a, b], parseBrainQuery('vocal', YEAR), { now: NOW });
    const reversed = rankRecords([b, a], parseBrainQuery('vocal', YEAR), { now: NOW });
    expect(forward.map((h) => h.record.id)).toEqual(['aaa', 'bbb']);
    expect(reversed.map((h) => h.record.id)).toEqual(forward.map((h) => h.record.id));
  });

  it('is stable across repeated runs', () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      rec({ id: `id-${i}`, name: 'vocal.wav', modifiedAt: '2026-06-01T00:00:00.000Z' }));
    const once = rankRecords(records, parseBrainQuery('vocal', YEAR), { now: NOW }).map((h) => h.record.id);
    const twice = rankRecords([...records].reverse(), parseBrainQuery('vocal', YEAR), { now: NOW }).map((h) => h.record.id);
    expect(twice).toEqual(once);
  });

  it('scores recency without letting the clock decide relevance', () => {
    const old = rec({ id: 'a', name: 'vocal.wav', modifiedAt: '2020-01-01T00:00:00.000Z' });
    const today = rec({ id: 'b', name: 'vocal.wav', modifiedAt: '2026-10-04T08:00:00.000Z' });
    const hits = rankRecords([old, today], parseBrainQuery('vocal', YEAR), { now: NOW });
    expect(hits[0].record.id).toBe('b');
    // but recency is a nudge, not an override: an exact match still wins
    const exactOld = rec({ id: 'c', name: 'vocal', modifiedAt: '2020-01-01T00:00:00.000Z' });
    const hits2 = rankRecords([today, exactOld], parseBrainQuery('vocal', YEAR), { now: NOW });
    expect(hits2[0].record.id).toBe('c');
  });

  it('respects the limit', () => {
    const records = Array.from({ length: 10 }, (_, i) => rec({ id: `id-${i}`, name: 'vocal.wav' }));
    expect(rankRecords(records, parseBrainQuery('vocal', YEAR), { now: NOW, limit: 3 })).toHaveLength(3);
  });

  it('never exposes a filesystem path in a record', () => {
    // Results may be handed to a model; a path is user data it never needs.
    const hits = rankRecords([rec({ id: 'a', name: 'vocal.wav' })], parseBrainQuery('vocal', YEAR), { now: NOW });
    expect(JSON.stringify(hits)).not.toMatch(/\/Users\//);
    expect(Object.keys(hits[0].record)).not.toContain('path');
  });
});

describe('grouping by project', () => {
  it('groups while preserving the ranked order', () => {
    const hits = rankRecords([
      rec({ id: 'a', projectId: 'p1', projectName: 'Alpha', name: 'vocal' }),
      rec({ id: 'b', projectId: 'p2', projectName: 'Beta', name: 'vocal.wav' }),
      rec({ id: 'c', projectId: 'p1', projectName: 'Alpha', name: 'vocal.wav' }),
    ], parseBrainQuery('vocal', YEAR), { now: NOW });
    const groups = groupHitsByProject(hits);
    expect(groups[0].projectId).toBe('p1');          // contains the exact match
    expect(groups.map((g) => g.projectId)).toEqual(['p1', 'p2']);
    expect(groups[0].hits).toHaveLength(2);
  });
});
