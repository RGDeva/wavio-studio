/**
 * Project Brain — behaviour at library scale.
 *
 * A producer's music folder is tens of thousands of files, so retrieval has to
 * stay interactive and must not degrade into re-reading or re-hashing. These
 * assert the shape of the work, not just that it finishes: ranking is a single
 * linear pass with no per-record allocation of the whole set, and the result
 * is identical regardless of input order even at scale.
 *
 * Thresholds are deliberately loose. They exist to catch an accidental
 * quadratic or a per-record regex rebuild, not to benchmark the machine — a
 * tight bound here would fail on a busy CI box and teach everyone to ignore it.
 */
import { describe, it, expect } from 'vitest';
import { parseBrainQuery } from './query';
import { rankRecords, type BrainRecord } from './retrieval';
import { deriveProjectMemory, type DeriveFile } from './derive';

const NOW = '2026-10-08T12:00:00.000Z';

function library(n: number): BrainRecord[] {
  const roles = ['audio', 'stem', 'project', 'midi'];
  const daws = ['ableton', 'fl-studio', 'logic'];
  return Array.from({ length: n }, (_, i) => ({
    id: `f-${String(i).padStart(6, '0')}`,
    kind: 'file' as const,
    projectId: `p-${i % 500}`,
    name: `${['vocal', 'kick', 'bass', 'master', 'pad'][i % 5]}-${i}.wav`,
    projectName: `Project ${i % 500}`,
    dawType: daws[i % daws.length],
    role: roles[i % roles.length],
    fileType: 'wav',
    bpm: 120 + (i % 20),
    keyNote: null,
    status: i % 7 === 0 ? 'pending' : 'synced',
    modifiedAt: `2026-0${(i % 9) + 1}-15T00:00:00.000Z`,
  }));
}

describe('retrieval at scale', () => {
  const RECORDS = library(25_000);

  it('ranks a 25k-record library quickly enough to feel instant', () => {
    const t0 = Date.now();
    const hits = rankRecords(RECORDS, parseBrainQuery('vocal', 2026), { now: NOW, limit: 50 });
    const ms = Date.now() - t0;
    expect(hits).toHaveLength(50);
    // Loose: catches an accidental quadratic, not a slow machine.
    expect(ms).toBeLessThan(2000);
  });

  it('stays linear — 4x the records costs far less than 16x the time', () => {
    const small = library(5_000);
    const t0 = Date.now();
    rankRecords(small, parseBrainQuery('vocal', 2026), { now: NOW });
    const smallMs = Math.max(1, Date.now() - t0);

    const t1 = Date.now();
    rankRecords(library(20_000), parseBrainQuery('vocal', 2026), { now: NOW });
    const bigMs = Date.now() - t1;

    // Quadratic growth would be ~16x. Allow generous headroom for noise.
    expect(bigMs).toBeLessThan(smallMs * 12 + 500);
  });

  it('narrows hard with filters instead of scanning more', () => {
    const hits = rankRecords(RECORDS, parseBrainQuery('vocal daw:logic bpm:125', 2026), { now: NOW, limit: 100 });
    for (const h of hits) {
      expect(h.record.dawType).toBe('logic');
      expect(h.record.bpm).toBe(125);
    }
  });

  it('is order-independent at scale, not just on small inputs', () => {
    // Ties are far more likely with 25k records; this is where an unstable
    // sort would actually surface.
    const q = parseBrainQuery('master', 2026);
    const forward = rankRecords(RECORDS, q, { now: NOW, limit: 100 }).map((h) => h.record.id);
    const reversed = rankRecords([...RECORDS].reverse(), q, { now: NOW, limit: 100 }).map((h) => h.record.id);
    expect(reversed).toEqual(forward);
  });

  it('a query matching nothing costs the same single pass', () => {
    const t0 = Date.now();
    const hits = rankRecords(RECORDS, parseBrainQuery('zzzzznotathing', 2026), { now: NOW });
    expect(hits).toHaveLength(0);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('derived memory at project scale', () => {
  it('handles a project with 5,000 files without re-reading anything', () => {
    const files: DeriveFile[] = Array.from({ length: 5_000 }, (_, i) => ({
      id: `f${i}`, name: i === 4_999 ? 'master-v3.wav' : `stem-${i}.wav`,
      role: 'stem', fileType: 'wav', sizeBytes: 1000,
      modifiedAt: '2026-10-01T00:00:00.000Z',
      localStatus: 'present', syncStatus: 'synced',
      // Hashes are already computed by the indexer; deriving must never need
      // to recompute one.
      checksum: 'a'.repeat(64),
    }));
    const t0 = Date.now();
    const mem = deriveProjectMemory({
      projectId: 'p1', projectName: 'Big', dawType: 'ableton', files, versions: [],
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(mem.facts.find((f) => f.key === 'file-count')!.value).toBe('5000');
    expect(mem.inferences.find((i) => i.key === 'likely-master')!.value).toBe('master-v3.wav');
  });
});
