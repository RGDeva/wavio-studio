/**
 * queue.test.ts — unit tests for sync queue helpers (Fix 10)
 *
 * Uses better-sqlite3 :memory: database via initDatabaseForTesting().
 * No Electron APIs are invoked — the 'electron' module is mocked below.
 */

import { vi, beforeEach, test, expect } from 'vitest';

// Mock electron before any db import so the module-level `import { app }` doesn't throw
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/wavi-test'),
  },
}));

import crypto from 'crypto';
import {
  initDatabaseForTesting,
  enqueueSyncItemIdempotent,
  repairStalledQueue,
  getDb,
} from './db';

function generateId() {
  return crypto.randomUUID();
}

function makeItem(overrides: Partial<{
  id: string;
  project_id: string;
  file_id: string;
  type: string;
  priority: number;
  created_at: string;
}> = {}) {
  return {
    id: generateId(),
    project_id: 'proj-1',
    file_id: 'file-1',
    type: 'dependency_upload',
    priority: 3,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  // Fresh in-memory DB for every test
  initDatabaseForTesting(':memory:');
});

// ── Test 1: repairStalledQueue resets uploading→pending ────────────────────────

test('repairStalledQueue resets uploading rows to pending', () => {
  const db = getDb();

  // Insert rows manually at various statuses
  const ids = [generateId(), generateId(), generateId()];
  const now = new Date().toISOString();
  for (const [i, id] of ids.entries()) {
    db.prepare(
      `INSERT INTO sync_queue (id, project_id, file_id, type, status, priority, created_at, started_at)
       VALUES (?, ?, ?, ?, ?, 5, ?, ?)`
    ).run(id, 'proj-1', `file-${i}`, 'dependency_upload', 'uploading', now, now);
  }

  const result = repairStalledQueue();

  expect(result.recovered).toBe(3);
  const rows = db.prepare(`SELECT status FROM sync_queue`).all() as { status: string }[];
  for (const row of rows) {
    expect(row.status).toBe('pending');
  }
});

// ── Test 2: enqueueSyncItemIdempotent returns inserted:false when active job exists ──

test('enqueueSyncItemIdempotent returns inserted:false when active job exists', () => {
  const item = makeItem();
  const first = enqueueSyncItemIdempotent(item);
  expect(first.inserted).toBe(true);

  const second = enqueueSyncItemIdempotent(makeItem({
    project_id: item.project_id,
    file_id: item.file_id,
    type: item.type,
  }));
  expect(second.inserted).toBe(false);
  expect(second.existingId).toBe(first.id);
});

// ── Test 3: enqueueSyncItemIdempotent returns inserted:true when no active job ────

test('enqueueSyncItemIdempotent returns inserted:true when no active job exists', () => {
  const item = makeItem({ project_id: 'proj-new', file_id: 'file-new' });
  const result = enqueueSyncItemIdempotent(item);
  expect(result.inserted).toBe(true);
  expect(result.id).toBe(item.id);
});

// ── Test 4: Two enqueue calls for same (type, project_id, file_id) → 1 active row ──

test('two enqueue calls for same key produce exactly 1 active row', () => {
  const base = { project_id: 'proj-1', file_id: 'file-1', type: 'dependency_upload' };
  enqueueSyncItemIdempotent(makeItem(base));
  enqueueSyncItemIdempotent(makeItem(base));

  const db = getDb();
  const count = (db.prepare(
    `SELECT COUNT(*) as n FROM sync_queue WHERE project_id = ? AND file_id = ? AND type = ? AND status IN ('pending','uploading','retrying')`
  ).get('proj-1', 'file-1', 'dependency_upload') as { n: number }).n;

  expect(count).toBe(1);
});

// ── Test 5: After completing a job, new enqueue for same file creates new row ─────

test('after completing a job, a new enqueue creates a new active row', () => {
  const item = makeItem();
  const first = enqueueSyncItemIdempotent(item);
  expect(first.inserted).toBe(true);

  // Mark it completed
  const db = getDb();
  db.prepare(`UPDATE sync_queue SET status = 'completed' WHERE id = ?`).run(first.id);

  // Now enqueue again — should insert because no active job remains
  const second = enqueueSyncItemIdempotent(makeItem({
    project_id: item.project_id,
    file_id: item.file_id,
    type: item.type,
  }));
  expect(second.inserted).toBe(true);
});

// ── Test 6: repairStalledQueue collapses 5 duplicate pending rows into 1 ──────────

test('repairStalledQueue collapses 5 duplicate pending rows into 1', () => {
  const db = getDb();
  const now = new Date().toISOString();

  // Insert 5 rows with same (type, project_id, file_id) — bypass idempotent helper
  for (let i = 0; i < 5; i++) {
    db.prepare(
      `INSERT INTO sync_queue (id, project_id, file_id, type, status, priority, created_at)
       VALUES (?, 'proj-dup', 'file-dup', 'dependency_upload', 'pending', 3, ?)`
    ).run(generateId(), new Date(Date.now() + i * 1000).toISOString());
  }

  const result = repairStalledQueue();
  expect(result.deduped).toBe(4); // 5 rows → 1 kept, 4 deleted

  const remaining = (db.prepare(
    `SELECT COUNT(*) as n FROM sync_queue WHERE project_id = 'proj-dup' AND file_id = 'file-dup' AND status IN ('pending','retrying')`
  ).get() as { n: number }).n;
  expect(remaining).toBe(1);
});
