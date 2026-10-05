/**
 * Project Brain — time ranges and derived project memory.
 *
 * The rule defended here is the FACT / INFERENCE split: a convention-based
 * guess ("this is probably the master") must never be presented with the same
 * authority as something the index states outright, because a confident wrong
 * guess propagates into everything downstream.
 */
import { describe, it, expect } from 'vitest';
import { resolveNamedRange, parseRange } from './timeRange';
import { deriveProjectMemory, inferMaster, collectStems, type DeriveFile } from './derive';

// A Thursday, so week boundaries are unambiguous.
const NOW = '2026-10-08T15:30:00.000Z';

function f(over: Partial<DeriveFile> & { id: string; name: string }): DeriveFile {
  return {
    role: 'audio', fileType: 'wav', sizeBytes: 1000,
    modifiedAt: '2026-10-01T00:00:00.000Z', localStatus: 'present',
    syncStatus: 'synced', checksum: null, ...over,
  };
}

describe('time ranges resolve against an injected now, never the clock', () => {
  it('today and yesterday cover whole days', () => {
    expect(resolveNamedRange('today', NOW)).toMatchObject({
      from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T23:59:59.999Z',
    });
    expect(resolveNamedRange('yesterday', NOW)).toMatchObject({
      from: '2026-10-07T00:00:00.000Z', to: '2026-10-07T23:59:59.999Z',
    });
  });

  it('weeks start on Monday', () => {
    // Asked on a Sunday night, "this week" must mean the week just worked —
    // a Sunday-start week would answer with an almost-empty window.
    const thursday = resolveNamedRange('this-week', NOW);
    expect(thursday.from).toBe('2026-10-05T00:00:00.000Z'); // Monday
    const sunday = resolveNamedRange('this-week', '2026-10-11T22:00:00.000Z');
    expect(sunday.from).toBe('2026-10-05T00:00:00.000Z');   // same Monday
  });

  it('last week is the full preceding Monday–Sunday', () => {
    const r = resolveNamedRange('last-week', NOW);
    expect(r.from).toBe('2026-09-28T00:00:00.000Z');
    expect(r.to).toBe('2026-10-04T23:59:59.999Z');
  });

  it('last month is the whole previous calendar month', () => {
    const r = resolveNamedRange('last-month', NOW);
    expect(r.from).toBe('2026-09-01T00:00:00.000Z');
    expect(r.to).toBe('2026-09-30T23:59:59.999Z');
  });

  it('handles a January boundary without rolling the year wrong', () => {
    const r = resolveNamedRange('last-month', '2026-01-15T00:00:00.000Z');
    expect(r.from).toBe('2025-12-01T00:00:00.000Z');
    expect(r.to).toBe('2025-12-31T23:59:59.999Z');
  });

  it('parses loose aliases and relative windows', () => {
    expect(parseRange('this week', NOW)!.label).toBe('this week');
    expect(parseRange('last 7 days', NOW)!.from).toBe('2026-10-01T00:00:00.000Z');
    expect(parseRange('30d', NOW)!.label).toContain('30');
  });

  it('returns null for a range it does not understand', () => {
    // Defaulting to a window the user did not ask for would answer the wrong
    // question confidently.
    expect(parseRange('whenever', NOW)).toBeNull();
    expect(parseRange('', NOW)).toBeNull();
  });
});

describe('master detection is an INFERENCE, with evidence', () => {
  it('names a single master-like file strongly', () => {
    const m = inferMaster([f({ id: '1', name: 'master-v7.wav' }), f({ id: '2', name: 'vocal.wav' })])!;
    expect(m).toMatchObject({ key: 'likely-master', value: 'master-v7.wav', strength: 'strong' });
    expect(m.evidence).toContain('only file');
  });

  it('prefers the highest explicit version when several compete', () => {
    const m = inferMaster([
      f({ id: '1', name: 'master-v2.wav' }),
      f({ id: '2', name: 'master-v7.wav' }),
      f({ id: '3', name: 'master-v3.wav' }),
    ])!;
    expect(m.value).toBe('master-v7.wav');
    expect(m.strength).toBe('strong');
  });

  it('hedges when only recency separates the candidates', () => {
    const m = inferMaster([
      f({ id: '1', name: 'final mix.wav', modifiedAt: '2026-10-01T00:00:00.000Z' }),
      f({ id: '2', name: 'mixdown.wav', modifiedAt: '2026-10-05T00:00:00.000Z' }),
    ])!;
    expect(m.value).toBe('mixdown.wav');
    expect(m.strength).toBe('weak');          // nothing authoritative said so
    expect(m.evidence).toContain('recently modified');
  });

  it('returns nothing rather than guessing when no file looks like a master', () => {
    expect(inferMaster([f({ id: '1', name: 'vocal.wav' })])).toBeNull();
  });

  it('ignores a missing file when picking the master', () => {
    const m = inferMaster([
      f({ id: '1', name: 'master-v9.wav', localStatus: 'missing' }),
      f({ id: '2', name: 'master-v2.wav' }),
    ])!;
    expect(m.value).toBe('master-v2.wav');
  });
});

describe('derived project memory', () => {
  const base = {
    projectId: 'p1', projectName: 'Sunshine', dawType: 'fl-studio',
    versions: [{ id: 'v1', versionNumber: 4, createdAt: '2026-10-02T00:00:00.000Z' }],
  };

  it('counts what the index states outright as FACTS', () => {
    const m = deriveProjectMemory({
      ...base,
      files: [
        f({ id: '1', name: 'Sunshine.flp', role: 'project', fileType: 'flp' }),
        f({ id: '2', name: 'stems/bass.wav', role: 'stem' }),
        f({ id: '3', name: 'gone.wav', localStatus: 'missing' }),
        f({ id: '4', name: 'lead.mid', fileType: 'mid', role: 'midi' }),
      ],
    });
    const byKey = Object.fromEntries(m.facts.map((x) => [x.key, x.value]));
    expect(byKey['file-count']).toBe('4');
    expect(byKey['missing-file-count']).toBe('1');
    expect(byKey['present-file-count']).toBe('3');
    expect(byKey['midi-count']).toBe('1');
    expect(byKey['source-daw']).toBe('fl-studio');
    expect(byKey['latest-version']).toBe('4');
  });

  it('treats changed-since-publish as a FACT — both timestamps are the index’s own', () => {
    const changed = deriveProjectMemory({
      ...base,
      files: [f({ id: '1', name: 'master.wav', modifiedAt: '2026-10-06T00:00:00.000Z' })],
    });
    expect(changed.facts.find((x) => x.key === 'changed-since-publish')!.value).toBe('yes');

    const unchanged = deriveProjectMemory({
      ...base,
      files: [f({ id: '1', name: 'master.wav', modifiedAt: '2026-10-01T00:00:00.000Z' })],
    });
    expect(unchanged.facts.find((x) => x.key === 'changed-since-publish')!.value).toBe('no');
  });

  it('keeps inferences out of the facts bucket entirely', () => {
    const m = deriveProjectMemory({ ...base, files: [f({ id: '1', name: 'master-v7.wav' })] });
    expect(m.facts.some((x) => x.key === 'likely-master')).toBe(false);
    expect(m.inferences.some((x) => x.key === 'likely-master')).toBe(true);
  });

  it('is byte-stable for the same rows in any order', () => {
    // An unstable recompute would look like a change on every pass and flood
    // the append-only memory.
    const files = [f({ id: '1', name: 'a.wav' }), f({ id: '2', name: 'b.wav' }), f({ id: '3', name: 'master.wav' })];
    const a = deriveProjectMemory({ ...base, files });
    const b = deriveProjectMemory({ ...base, files: [...files].reverse() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('collects stems by role or by stems-like path', () => {
    const stems = collectStems([
      f({ id: '1', name: 'stems/bass.wav' }),
      f({ id: '2', name: 'vocals.wav', role: 'stem' }),
      f({ id: '3', name: 'master.wav' }),
    ]);
    expect(stems.map((s) => s.id)).toEqual(['1', '2']);
  });

  it('handles an empty project without inventing anything', () => {
    const m = deriveProjectMemory({ ...base, files: [], versions: [] });
    expect(m.inferences).toEqual([]);
    expect(m.facts.find((x) => x.key === 'file-count')!.value).toBe('0');
  });
});
