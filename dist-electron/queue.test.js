"use strict";
/**
 * queue.test.ts — unit tests for sync queue helpers (Fix 10)
 *
 * Uses better-sqlite3 :memory: database via initDatabaseForTesting().
 * No Electron APIs are invoked — the 'electron' module is mocked below.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Mock electron before any db import so the module-level `import { app }` doesn't throw
jest.mock('electron', () => ({
    app: {
        getPath: jest.fn(() => '/tmp/wavi-test'),
    },
}));
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("./db");
function generateId() {
    return crypto_1.default.randomUUID();
}
function makeItem(overrides = {}) {
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
    (0, db_1.initDatabaseForTesting)(':memory:');
});
// ── Test 1: repairStalledQueue resets uploading→pending ────────────────────────
test('repairStalledQueue resets uploading rows to pending', () => {
    const db = (0, db_1.getDb)();
    // Insert rows manually at various statuses
    const ids = [generateId(), generateId(), generateId()];
    const now = new Date().toISOString();
    for (const [i, id] of ids.entries()) {
        db.prepare(`INSERT INTO sync_queue (id, project_id, file_id, type, status, priority, created_at, started_at)
       VALUES (?, ?, ?, ?, ?, 5, ?, ?)`).run(id, 'proj-1', `file-${i}`, 'dependency_upload', 'uploading', now, now);
    }
    const result = (0, db_1.repairStalledQueue)();
    expect(result.recovered).toBe(3);
    const rows = db.prepare(`SELECT status FROM sync_queue`).all();
    for (const row of rows) {
        expect(row.status).toBe('pending');
    }
});
// ── Test 2: enqueueSyncItemIdempotent returns inserted:false when active job exists ──
test('enqueueSyncItemIdempotent returns inserted:false when active job exists', () => {
    const item = makeItem();
    const first = (0, db_1.enqueueSyncItemIdempotent)(item);
    expect(first.inserted).toBe(true);
    const second = (0, db_1.enqueueSyncItemIdempotent)(makeItem({
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
    const result = (0, db_1.enqueueSyncItemIdempotent)(item);
    expect(result.inserted).toBe(true);
    expect(result.id).toBe(item.id);
});
// ── Test 4: Two enqueue calls for same (type, project_id, file_id) → 1 active row ──
test('two enqueue calls for same key produce exactly 1 active row', () => {
    const base = { project_id: 'proj-1', file_id: 'file-1', type: 'dependency_upload' };
    (0, db_1.enqueueSyncItemIdempotent)(makeItem(base));
    (0, db_1.enqueueSyncItemIdempotent)(makeItem(base));
    const db = (0, db_1.getDb)();
    const count = db.prepare(`SELECT COUNT(*) as n FROM sync_queue WHERE project_id = ? AND file_id = ? AND type = ? AND status IN ('pending','uploading','retrying')`).get('proj-1', 'file-1', 'dependency_upload').n;
    expect(count).toBe(1);
});
// ── Test 5: After completing a job, new enqueue for same file creates new row ─────
test('after completing a job, a new enqueue creates a new active row', () => {
    const item = makeItem();
    const first = (0, db_1.enqueueSyncItemIdempotent)(item);
    expect(first.inserted).toBe(true);
    // Mark it completed
    const db = (0, db_1.getDb)();
    db.prepare(`UPDATE sync_queue SET status = 'completed' WHERE id = ?`).run(first.id);
    // Now enqueue again — should insert because no active job remains
    const second = (0, db_1.enqueueSyncItemIdempotent)(makeItem({
        project_id: item.project_id,
        file_id: item.file_id,
        type: item.type,
    }));
    expect(second.inserted).toBe(true);
});
// ── Test 6: repairStalledQueue collapses 5 duplicate pending rows into 1 ──────────
test('repairStalledQueue collapses 5 duplicate pending rows into 1', () => {
    const db = (0, db_1.getDb)();
    const now = new Date().toISOString();
    // Insert 5 rows with same (type, project_id, file_id) — bypass idempotent helper
    for (let i = 0; i < 5; i++) {
        db.prepare(`INSERT INTO sync_queue (id, project_id, file_id, type, status, priority, created_at)
       VALUES (?, 'proj-dup', 'file-dup', 'dependency_upload', 'pending', 3, ?)`).run(generateId(), new Date(Date.now() + i * 1000).toISOString());
    }
    const result = (0, db_1.repairStalledQueue)();
    expect(result.deduped).toBe(4); // 5 rows → 1 kept, 4 deleted
    const remaining = db.prepare(`SELECT COUNT(*) as n FROM sync_queue WHERE project_id = 'proj-dup' AND file_id = 'file-dup' AND status IN ('pending','retrying')`).get().n;
    expect(remaining).toBe(1);
});
