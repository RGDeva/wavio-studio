/**
 * Reading raw activity without drowning in it.
 *
 * The log stays complete — coalescing is a read-time view, because deleting
 * low-level rows would throw away history the user may later need.
 */
import { describe, it, expect } from 'vitest';
import { coalesceActivity, summarizeActivity, type RawActivity } from './activityView';

const base = { projectId: 'p1', projectName: 'Sunshine' };
function ev(type: string, message: string, at: string, over: Partial<RawActivity> = {}): RawActivity {
  return { ...base, type, message, at, ...over };
}

describe('coalesceActivity', () => {
  it('collapses a burst from one save into a single readable line', () => {
    // 20 "file analysed" rows from one save should read as one thing.
    const events = Array.from({ length: 20 }, (_, i) =>
      ev('file_analyzed', `stem-${i}.wav analysed`, `2026-10-05T12:00:${String(59 - i).padStart(2, '0')}.000Z`));
    const groups = coalesceActivity(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(20);
    expect(groups[0].summary).toBe('20 × file analyzed in Sunshine');
  });

  it('keeps a few examples so detail survives the grouping', () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      ev('file_analyzed', `s${i}.wav`, `2026-10-05T12:00:${String(59 - i).padStart(2, '0')}.000Z`));
    expect(coalesceActivity(events)[0].examples).toHaveLength(3);
  });

  it('does NOT merge the same event across a long gap', () => {
    // "changed this morning" and "changed last Tuesday" are two different
    // facts; flattening them would answer "when did this change?" wrongly.
    const groups = coalesceActivity([
      ev('file_changed', 'master.wav changed', '2026-10-05T12:00:00.000Z'),
      ev('file_changed', 'master.wav changed', '2026-09-29T09:00:00.000Z'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('never merges across projects', () => {
    const groups = coalesceActivity([
      ev('file_changed', 'a', '2026-10-05T12:00:10.000Z'),
      ev('file_changed', 'b', '2026-10-05T12:00:05.000Z', { projectId: 'p2', projectName: 'Faith' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.projectId)).toEqual(['p1', 'p2']);
  });

  it('never merges different event types', () => {
    const groups = coalesceActivity([
      ev('file_added', 'a', '2026-10-05T12:00:10.000Z'),
      ev('file_changed', 'b', '2026-10-05T12:00:09.000Z'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('leaves a single event reading as itself', () => {
    // "1 × file changed" would be worse than the original message.
    const groups = coalesceActivity([ev('file_changed', 'master.wav changed', '2026-10-05T12:00:00.000Z')]);
    expect(groups[0].summary).toBe('master.wav changed');
    expect(groups[0].count).toBe(1);
  });

  it('reports the true span of a group', () => {
    const groups = coalesceActivity([
      ev('file_analyzed', 'c', '2026-10-05T12:01:00.000Z'),
      ev('file_analyzed', 'b', '2026-10-05T12:00:30.000Z'),
      ev('file_analyzed', 'a', '2026-10-05T12:00:00.000Z'),
    ]);
    expect(groups[0]).toMatchObject({ count: 3, firstAt: '2026-10-05T12:00:00.000Z', lastAt: '2026-10-05T12:01:00.000Z' });
  });

  it('handles an empty log', () => {
    expect(coalesceActivity([])).toEqual([]);
  });

  it('does not lose any event — counts always add up', () => {
    const events = [
      ...Array.from({ length: 7 }, (_, i) => ev('file_analyzed', `x${i}`, `2026-10-05T12:00:${String(50 - i).padStart(2, '0')}.000Z`)),
      ev('file_added', 'new.wav', '2026-10-05T12:00:40.000Z'),
      ev('file_analyzed', 'old', '2026-09-01T12:00:00.000Z'),
    ];
    const total = coalesceActivity(events).reduce((n, g) => n + g.count, 0);
    expect(total).toBe(events.length);
  });
});

describe('summarizeActivity', () => {
  it('counts by type, most frequent first, deterministically', () => {
    const out = summarizeActivity([
      ev('file_changed', 'a', '2026-10-05T12:00:00.000Z'),
      ev('file_added', 'b', '2026-10-05T12:00:01.000Z'),
      ev('file_changed', 'c', '2026-10-05T12:00:02.000Z'),
    ]);
    expect(out).toEqual([{ type: 'file_changed', count: 2 }, { type: 'file_added', count: 1 }]);
  });

  it('breaks count ties by name so the order never wobbles', () => {
    const out = summarizeActivity([
      ev('zeta', 'a', '2026-10-05T12:00:00.000Z'),
      ev('alpha', 'b', '2026-10-05T12:00:01.000Z'),
    ]);
    expect(out.map((o) => o.type)).toEqual(['alpha', 'zeta']);
  });
});
