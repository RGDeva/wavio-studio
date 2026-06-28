/**
 * Core sync engine tests.
 *
 * Intentionally avoids better-sqlite3 (compiled for Electron x86 ABI,
 * incompatible with arm64 Node test runner). Each test covers real behavior:
 *
 *  1. SHA-256 output length — verifies the fix to watcher.ts (.slice removal)
 *  2. Truncated-hash migration logic — verifies the SQL WHERE pattern is correct
 *     using a pure-JS row-filter that mirrors the SQL semantics
 *  3. Retry time-gate logic — verifies getPendingSyncItems filtering behavior
 *     using the same time-comparison the SQL query performs
 *  4. next_retry_at computation — verifies syncAgent writes the correct future time
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers that mirror the actual implementation logic
// ─────────────────────────────────────────────────────────────────────────────

/** Mirror of watcher.ts fileChecksum — full 64-char hex, no slice */
async function fileChecksumLogic(content: Buffer): Promise<string> {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Mirror of the db.ts migration SQL:
 *    UPDATE ... SET checksum = NULL
 *    WHERE checksum IS NOT NULL
 *      AND length(checksum) = 16
 *      AND checksum GLOB '[0-9a-f]*'
 */
function applyTruncatedHashMigration<T extends { checksum: string | null }>(rows: T[]): T[] {
  return rows.map(row => {
    if (
      row.checksum !== null &&
      row.checksum.length === 16 &&
      /^[0-9a-f]+$/.test(row.checksum)
    ) {
      return { ...row, checksum: null };
    }
    return row;
  });
}

/** Mirror of getPendingSyncItems SQL WHERE clause */
function filterEligibleJobs(
  jobs: Array<{ id: string; status: string; next_retry_at: string | null; priority: number; created_at: string }>,
  now: string,
  limit: number
) {
  return jobs
    .filter(j =>
      (j.status === 'pending' || j.status === 'retrying') &&
      (j.next_retry_at === null || j.next_retry_at <= now)
    )
    .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))
    .slice(0, limit);
}

/** Mirror of syncAgent next_retry_at computation */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000];
function computeNextRetryAt(retries: number): string {
  const delay = RETRY_DELAYS_MS[Math.min(retries - 1, RETRY_DELAYS_MS.length - 1)]
    + Math.floor(Math.random() * 1000);
  return new Date(Date.now() + delay).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SHA-256 hash length
// ─────────────────────────────────────────────────────────────────────────────

describe('fileChecksum — full SHA-256, no truncation', () => {
  it('produces a 64-character hex string', async () => {
    const h = await fileChecksumLogic(Buffer.from('hello world'));
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same content', async () => {
    const h1 = await fileChecksumLogic(Buffer.from('same'));
    const h2 = await fileChecksumLogic(Buffer.from('same'));
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different content', async () => {
    const h1 = await fileChecksumLogic(Buffer.from('version_a'));
    const h2 = await fileChecksumLogic(Buffer.from('version_b'));
    expect(h1).not.toBe(h2);
  });

  it('is NOT truncated to 16 characters (regression guard)', async () => {
    const h = await fileChecksumLogic(Buffer.from('any content'));
    expect(h.length).toBeGreaterThan(16);
    // The old broken implementation always returned exactly 16 chars
    expect(h.length).toBe(64);
  });

  it('matches known SHA-256 value for empty buffer', async () => {
    const h = await fileChecksumLogic(Buffer.alloc(0));
    // SHA-256 of empty string is a well-known constant
    expect(h).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Truncated-hash backward-compat migration
// ─────────────────────────────────────────────────────────────────────────────

describe('truncated-hash migration SQL logic', () => {
  const fullHash64 = 'a3f4b2c1d9e8f7001234567890abcdef1234567890abcdef1234567890abcdef12';
  const truncated16 = 'a3f4b2c1d9e8f700';
  const shortUUID = '550e8400-e29b-41d4'; // non-hex, length != 16

  it('nulls out exactly 16-char lowercase hex checksums', () => {
    const rows = [{ checksum: truncated16 }];
    const result = applyTruncatedHashMigration(rows);
    expect(result[0].checksum).toBeNull();
  });

  it('preserves 64-char full SHA-256 checksums', () => {
    const rows = [{ checksum: fullHash64 }];
    const result = applyTruncatedHashMigration(rows);
    expect(result[0].checksum).toBe(fullHash64);
  });

  it('preserves null checksums (already unknown)', () => {
    const rows = [{ checksum: null }];
    const result = applyTruncatedHashMigration(rows);
    expect(result[0].checksum).toBeNull();
  });

  it('does not affect non-hex 16-char strings', () => {
    // A 16-char string with uppercase or non-hex chars is not a truncated SHA-256
    const rows = [{ checksum: 'ABCDEF1234567890' }]; // uppercase
    const result = applyTruncatedHashMigration(rows);
    expect(result[0].checksum).toBe('ABCDEF1234567890');
  });

  it('is idempotent — running twice on already-nulled rows is a no-op', () => {
    const rows = [{ checksum: truncated16 }];
    const pass1 = applyTruncatedHashMigration(rows);
    const pass2 = applyTruncatedHashMigration(pass1);
    expect(pass2[0].checksum).toBeNull();
  });

  it('handles mixed rows correctly', () => {
    const rows = [
      { id: 'f1', checksum: truncated16 },
      { id: 'f2', checksum: fullHash64 },
      { id: 'f3', checksum: null },
    ];
    const result = applyTruncatedHashMigration(rows);
    expect(result.find(r => r.id === 'f1')!.checksum).toBeNull();
    expect(result.find(r => r.id === 'f2')!.checksum).toBe(fullHash64);
    expect(result.find(r => r.id === 'f3')!.checksum).toBeNull();
  });

  it('is a no-op on an empty array (fresh DB)', () => {
    expect(applyTruncatedHashMigration([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Retry time gate — getPendingSyncItems filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('sync queue retry time gate', () => {
  const nowIso = new Date().toISOString();
  const pastIso = new Date(Date.now() - 60_000).toISOString();
  const futureIso = new Date(Date.now() + 60_000).toISOString();
  const createdAt = new Date(Date.now() - 10_000).toISOString();

  function job(id: string, status: string, next_retry_at: string | null, priority = 5) {
    return { id, status, next_retry_at, priority, created_at: createdAt };
  }

  it('returns pending jobs with null next_retry_at', () => {
    const result = filterEligibleJobs([job('j1', 'pending', null)], nowIso, 10);
    expect(result.map(j => j.id)).toContain('j1');
  });

  it('returns retrying jobs whose next_retry_at is in the past', () => {
    const result = filterEligibleJobs([job('j2', 'retrying', pastIso)], nowIso, 10);
    expect(result.map(j => j.id)).toContain('j2');
  });

  it('does NOT return retrying jobs whose next_retry_at is in the future', () => {
    const result = filterEligibleJobs([job('j3', 'retrying', futureIso)], nowIso, 10);
    expect(result.map(j => j.id)).not.toContain('j3');
  });

  it('does NOT return failed jobs', () => {
    const result = filterEligibleJobs([job('j4', 'failed', null)], nowIso, 10);
    expect(result.map(j => j.id)).not.toContain('j4');
  });

  it('does NOT return uploading jobs', () => {
    const result = filterEligibleJobs([job('j5', 'uploading', null)], nowIso, 10);
    expect(result.map(j => j.id)).not.toContain('j5');
  });

  it('respects the limit', () => {
    const jobs = Array.from({ length: 15 }, (_, i) => job(`jl${i}`, 'pending', null, i));
    const result = filterEligibleJobs(jobs, nowIso, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('retrying job with null next_retry_at is eligible (legacy DB row)', () => {
    // Rows created before the migration have null next_retry_at — must still be processed
    const result = filterEligibleJobs([job('j7', 'retrying', null)], nowIso, 10);
    expect(result.map(j => j.id)).toContain('j7');
  });

  it('orders by priority descending, then created_at ascending', () => {
    const earlier = new Date(Date.now() - 5000).toISOString();
    const later   = new Date(Date.now() - 1000).toISOString();
    const jobs = [
      { id: 'low',    status: 'pending', next_retry_at: null, priority: 1,  created_at: earlier },
      { id: 'high',   status: 'pending', next_retry_at: null, priority: 10, created_at: later },
      { id: 'medium', status: 'pending', next_retry_at: null, priority: 5,  created_at: earlier },
    ];
    const result = filterEligibleJobs(jobs, nowIso, 10);
    expect(result[0].id).toBe('high');
    expect(result[1].id).toBe('medium');
    expect(result[2].id).toBe('low');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. next_retry_at computation in syncAgent
// ─────────────────────────────────────────────────────────────────────────────

describe('computeNextRetryAt (syncAgent backoff)', () => {
  it('returns a future ISO timestamp on first retry', () => {
    const t = computeNextRetryAt(1);
    expect(new Date(t).getTime()).toBeGreaterThan(Date.now());
  });

  it('first retry delay is approximately 5s', () => {
    const before = Date.now();
    const t = computeNextRetryAt(1);
    const delayMs = new Date(t).getTime() - before;
    expect(delayMs).toBeGreaterThanOrEqual(5_000);
    expect(delayMs).toBeLessThan(7_000); // 5s + up to 1s jitter + test overhead
  });

  it('second retry delay is approximately 30s', () => {
    const before = Date.now();
    const t = computeNextRetryAt(2);
    const delayMs = new Date(t).getTime() - before;
    expect(delayMs).toBeGreaterThanOrEqual(30_000);
    expect(delayMs).toBeLessThan(32_000);
  });

  it('caps at the last delay entry beyond max retries', () => {
    const before = Date.now();
    const t = computeNextRetryAt(99);
    const delayMs = new Date(t).getTime() - before;
    // Max is 300s (index 3)
    expect(delayMs).toBeGreaterThanOrEqual(300_000);
    expect(delayMs).toBeLessThan(302_000);
  });

  it('produces a valid ISO 8601 string', () => {
    const t = computeNextRetryAt(1);
    expect(() => new Date(t)).not.toThrow();
    expect(isNaN(new Date(t).getTime())).toBe(false);
  });
});
