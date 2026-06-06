"use strict";
/**
 * Project Association Engine — Phase 2 Tests
 *
 * Uses a pure-JS in-memory mock database so the native better-sqlite3 module
 * (compiled for Electron's Node ABI) is never loaded. This lets Vitest run
 * the tests under the system Node runtime without a NODE_MODULE_VERSION
 * mismatch.
 *
 * The mock implements exactly the subset of the better-sqlite3 API that the
 * engine uses: prepare(sql).run(...), prepare(sql).all(...), prepare(sql).get(...).
 * SQL is pattern-matched; no real query engine is involved.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const crypto_1 = __importDefault(require("crypto"));
const projectAssociationEngine_1 = require("./projectAssociationEngine");
/**
 * Minimal in-memory "database" that supports the SQL patterns the engine
 * issues. Pattern recognition is by keyword prefix, not a real SQL parser.
 */
function buildMockDb() {
    const tables = {
        files: [],
        association_queue: [],
        asset_associations: [],
        activity_log: [],
    };
    const db = {
        // Expose raw tables for assertions
        _tables: tables,
        pragma: () => db,
        prepare(sql) {
            const s = sql.trim().replace(/\s+/g, ' ').toLowerCase();
            return {
                run(...args) {
                    // ── INSERT INTO files ────────────────────────────────────────────────
                    // SQL: VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1, ?)
                    //      pos:   1  2  3  4  -  5  6  7  8  9  10 -  11
                    if (s.startsWith('insert into files')) {
                        const [id, file_path, file_name, file_type, role, created_at, modified_at, classifier_role, classifier_confidence, name_tokens, project_id] = args;
                        tables.files.push({
                            id, file_path, file_name, file_type,
                            file_size: 0,
                            role, created_at, modified_at,
                            classifier_role, classifier_confidence,
                            name_tokens,
                            classification_version: 1,
                            project_id: project_id ?? null,
                        });
                        return { changes: 1 };
                    }
                    // ── INSERT INTO association_queue ────────────────────────────────────
                    if (s.startsWith('insert or ignore into association_queue') ||
                        s.startsWith('insert into association_queue')) {
                        const [id, file_ids, suggested_project_id, relationship, confidence, signals] = args;
                        const exists = tables.association_queue.some(r => r.id === id);
                        if (!exists) {
                            tables.association_queue.push({
                                id, file_ids, suggested_project_id, relationship,
                                confidence, signals, status: 'pending',
                                shown_at: null, resolved_at: null,
                                created_at: Math.floor(Date.now() / 1000),
                            });
                        }
                        return { changes: 1 };
                    }
                    // ── UPDATE association_queue SET status ──────────────────────────────
                    if (s.startsWith('update association_queue set status')) {
                        const status = args[0];
                        const id = args[1];
                        let changed = 0;
                        for (const r of tables.association_queue) {
                            if (id === undefined || r.id === id) {
                                r.status = status;
                                r.resolved_at = Math.floor(Date.now() / 1000);
                                changed++;
                            }
                        }
                        return { changes: changed };
                    }
                    // ── UPDATE association_queue (bulk, no WHERE) ────────────────────────
                    if (s.startsWith("update association_queue set status = 'rejected'") && args.length === 0) {
                        for (const r of tables.association_queue) {
                            r.status = 'rejected';
                            r.resolved_at = Math.floor(Date.now() / 1000);
                        }
                        return { changes: tables.association_queue.length };
                    }
                    // ── INSERT INTO asset_associations ───────────────────────────────────
                    if (s.startsWith('insert into asset_associations')) {
                        const [id, source_file_id, target_file_id, relationship, confidence] = args;
                        tables.asset_associations.push({
                            id, source_file_id, target_file_id, relationship, confidence,
                            confirmed_by: 'user',
                            confirmed_at: Math.floor(Date.now() / 1000),
                            created_at: Math.floor(Date.now() / 1000),
                        });
                        return { changes: 1 };
                    }
                    // ── INSERT INTO activity_log ─────────────────────────────────────────
                    if (s.startsWith('insert into activity_log')) {
                        tables.activity_log.push({ id: args[0], type: args[1], message: args[2] });
                        return { changes: 1 };
                    }
                    return { changes: 0 };
                },
                all(...args) {
                    // ── SELECT from files ────────────────────────────────────────────────
                    if (s.startsWith('select') && s.includes('from files')) {
                        const cutoff = args[0];
                        return tables.files.filter(f => Number(f.classification_version) > 0 &&
                            f.classifier_role != null &&
                            f.classifier_role !== 'misc' &&
                            (cutoff === undefined || String(f.modified_at) >= cutoff));
                    }
                    // ── SELECT file_ids from association_queue (pending) ─────────────────
                    if (s.startsWith('select file_ids from association_queue')) {
                        return tables.association_queue
                            .filter(r => r.status === 'pending')
                            .slice(0, 200);
                    }
                    // ── SELECT * from association_queue (pending) ────────────────────────
                    if (s.startsWith('select *') && s.includes('association_queue')) {
                        return tables.association_queue.filter(r => r.status === 'pending');
                    }
                    // ── SELECT * from asset_associations ────────────────────────────────
                    if (s.startsWith('select *') && s.includes('asset_associations')) {
                        return tables.asset_associations;
                    }
                    return [];
                },
                get(...args) {
                    // ── SELECT id FROM files WHERE file_type = ? ─────────────────────────
                    if (s.includes('from files') && s.includes('file_type')) {
                        const type = args[0];
                        return tables.files.find(f => f.file_type === type) ?? undefined;
                    }
                    // ── SELECT id FROM files WHERE classifier_role = ? ───────────────────
                    if (s.includes('from files') && s.includes('classifier_role')) {
                        const role = args[0];
                        return tables.files.find(f => f.classifier_role === role) ?? undefined;
                    }
                    return undefined;
                },
            };
        },
    };
    return db;
}
// ── Seed helpers ──────────────────────────────────────────────────────────────
const NOW = new Date().toISOString();
const RECENT = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
function insertFile(db, opts) {
    const id = opts.id ?? crypto_1.default.randomUUID();
    db.prepare(`
    INSERT INTO files
      (id, file_path, file_name, file_type, file_size, role, created_at, modified_at,
       classifier_role, classifier_confidence, name_tokens, classification_version, project_id)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, opts.file_path, opts.file_name, opts.file_type ?? 'wav', opts.classifier_role, NOW, opts.modified_at ?? RECENT, opts.classifier_role, opts.classifier_confidence ?? 0.75, opts.name_tokens ?? null, opts.project_id ?? null);
    return id;
}
function getPendingQueue(db) {
    return db.prepare("SELECT * FROM association_queue WHERE status = 'pending'").all();
}
function getAssetAssociations(db) {
    return db.prepare('SELECT * FROM asset_associations').all();
}
// ── Tests ─────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('runAssociationEngine', () => {
    let db;
    (0, vitest_1.beforeEach)(() => {
        db = buildMockDb();
    });
    // ── 1. Same-folder cluster: .flp + bounce + stems ───────────────────────────
    (0, vitest_1.it)('groups .flp + bounce + stem in the same folder', () => {
        const folder = '/Users/rishig/Music/MyBeat';
        insertFile(db, { file_path: `${folder}/MyBeat.flp`, file_name: 'MyBeat.flp', file_type: 'flp', classifier_role: 'daw_project' });
        insertFile(db, { file_path: `${folder}/MyBeat FINAL.wav`, file_name: 'MyBeat FINAL.wav', file_type: 'wav', classifier_role: 'master' });
        insertFile(db, { file_path: `${folder}/stems/Kick.wav`, file_name: 'Kick.wav', file_type: 'wav', classifier_role: 'stem' });
        const result = (0, projectAssociationEngine_1.runAssociationEngine)(db, 30 * 24 * 60 * 60 * 1000);
        (0, vitest_1.expect)(result.groupsFound).toBeGreaterThanOrEqual(1);
        (0, vitest_1.expect)(result.groupsQueued).toBeGreaterThanOrEqual(1);
        // Inspect raw table to avoid SQL pattern-matching gaps in mock
        const allQueued = db._tables.association_queue;
        (0, vitest_1.expect)(allQueued.length).toBeGreaterThanOrEqual(1);
        // Verify the queued item contains the .flp and master file IDs
        const flpRow = db._tables.files.find((f) => f.file_type === 'flp');
        const masterRow = db._tables.files.find((f) => f.classifier_role === 'master');
        const hasFlp = allQueued.some((q) => JSON.parse(q.file_ids).includes(flpRow?.id));
        const hasBounce = allQueued.some((q) => JSON.parse(q.file_ids).includes(masterRow?.id));
        (0, vitest_1.expect)(hasFlp).toBe(true);
        (0, vitest_1.expect)(hasBounce).toBe(true);
    });
    // ── 2. Export folder bounce with parent .flp ────────────────────────────────
    (0, vitest_1.it)('groups export-folder bounce with its parent .flp (parent/child)', () => {
        const parent = '/Users/rishig/Music/Session1';
        const exportDir = `${parent}/exports`;
        insertFile(db, { file_path: `${parent}/Session1.flp`, file_name: 'Session1.flp', file_type: 'flp', classifier_role: 'daw_project' });
        insertFile(db, { file_path: `${exportDir}/Session1 bounce.wav`, file_name: 'Session1 bounce.wav', file_type: 'wav', classifier_role: 'bounce' });
        const result = (0, projectAssociationEngine_1.runAssociationEngine)(db, 30 * 24 * 60 * 60 * 1000);
        (0, vitest_1.expect)(result.groupsQueued).toBeGreaterThanOrEqual(1);
        const allQueued = db._tables.association_queue;
        const anyExportUnder = allQueued.some((q) => {
            const sigs = JSON.parse(q.signals);
            return sigs.exportUnderProject === true || sigs.parentChildFolder === true || sigs.hasDawProject === true;
        });
        (0, vitest_1.expect)(anyExportUnder).toBe(true);
    });
    // ── 3. Unrelated files are NOT grouped ─────────────────────────────────────
    (0, vitest_1.it)('does not group unrelated files in different folders with no shared tokens', () => {
        // Two isolated files in completely different directories, no shared hints
        insertFile(db, { file_path: '/Users/rishig/Music/ProjectA/beatA.flp', file_name: 'beatA.flp', file_type: 'flp', classifier_role: 'daw_project' });
        insertFile(db, { file_path: '/Users/rishig/Documents/Misc/notes.wav', file_name: 'notes.wav', file_type: 'wav', classifier_role: 'misc' });
        const result = (0, projectAssociationEngine_1.runAssociationEngine)(db, 30 * 24 * 60 * 60 * 1000);
        // misc role is excluded from grouping — so 0 relevant groups
        (0, vitest_1.expect)(result.groupsQueued).toBe(0);
    });
    // ── 4. Duplicate queue entries are avoided ──────────────────────────────────
    (0, vitest_1.it)('does not insert duplicate queue entries for the same file set', () => {
        const folder = '/Users/rishig/Music/Duplication';
        insertFile(db, { file_path: `${folder}/track.flp`, file_name: 'track.flp', file_type: 'flp', classifier_role: 'daw_project' });
        insertFile(db, { file_path: `${folder}/track FINAL.wav`, file_name: 'track FINAL.wav', file_type: 'wav', classifier_role: 'master' });
        (0, projectAssociationEngine_1.runAssociationEngine)(db, 30 * 24 * 60 * 60 * 1000);
        const countAfterFirst = getPendingQueue(db).length;
        // Run engine a second time — should not add more entries for the same group
        (0, projectAssociationEngine_1.runAssociationEngine)(db, 30 * 24 * 60 * 60 * 1000);
        const countAfterSecond = getPendingQueue(db).length;
        (0, vitest_1.expect)(countAfterSecond).toBe(countAfterFirst);
    });
    // ── 5. Confidence is within valid range ─────────────────────────────────────
    (0, vitest_1.it)('queued items have confidence between 0.45 and 0.99', () => {
        const folder = '/Users/rishig/Music/ConfCheck';
        insertFile(db, { file_path: `${folder}/beat.flp`, file_name: 'beat.flp', file_type: 'flp', classifier_role: 'daw_project' });
        insertFile(db, { file_path: `${folder}/beat FINAL.wav`, file_name: 'beat FINAL.wav', file_type: 'wav', classifier_role: 'master' });
        insertFile(db, { file_path: `${folder}/Kick.wav`, file_name: 'Kick.wav', file_type: 'wav', classifier_role: 'stem' });
        (0, projectAssociationEngine_1.runAssociationEngine)(db, 30 * 24 * 60 * 60 * 1000);
        const queue = getPendingQueue(db);
        for (const q of queue) {
            (0, vitest_1.expect)(q.confidence).toBeGreaterThanOrEqual(0.45);
            (0, vitest_1.expect)(q.confidence).toBeLessThanOrEqual(0.99);
        }
    });
    // ── 6. Shared-token grouping ─────────────────────────────────────────────────
    (0, vitest_1.it)('groups files sharing significant filename tokens across sub-folders', () => {
        const base = '/Users/rishig/Music/Rapture';
        // name_tokens with shared meaningful word "rapture"
        const tok = JSON.stringify({ songHint: 'rapture', artistHint: null, rawTokens: ['rapture'], versionNumber: null, isFinal: false, descriptors: [] });
        insertFile(db, { file_path: `${base}/Rapture.flp`, file_name: 'Rapture.flp', file_type: 'flp', classifier_role: 'daw_project', name_tokens: tok });
        insertFile(db, { file_path: `${base}/exports/Rapture_mix.wav`, file_name: 'Rapture_mix.wav', file_type: 'wav', classifier_role: 'bounce', name_tokens: tok });
        const result = (0, projectAssociationEngine_1.runAssociationEngine)(db, 30 * 24 * 60 * 60 * 1000);
        (0, vitest_1.expect)(result.groupsQueued).toBeGreaterThanOrEqual(1);
        const allQueued = db._tables.association_queue;
        const sharedToken = allQueued.some((q) => {
            const sigs = JSON.parse(q.signals);
            return (sigs.tokenOverlap ?? 0) >= 1 || !!sigs.sharedHint;
        });
        (0, vitest_1.expect)(sharedToken).toBe(true);
    });
});
// ── confirmQueueItem ──────────────────────────────────────────────────────────
(0, vitest_1.describe)('confirmQueueItem', () => {
    let db;
    (0, vitest_1.beforeEach)(() => {
        db = buildMockDb();
    });
    (0, vitest_1.it)('writes asset_associations rows for every file pair on confirm', () => {
        const folder = '/Users/rishig/Music/ConfirmTest';
        const idA = insertFile(db, { file_path: `${folder}/beat.flp`, file_name: 'beat.flp', file_type: 'flp', classifier_role: 'daw_project' });
        const idB = insertFile(db, { file_path: `${folder}/vocal.wav`, file_name: 'vocal.wav', file_type: 'wav', classifier_role: 'vocal_take' });
        const idC = insertFile(db, { file_path: `${folder}/Kick.wav`, file_name: 'Kick.wav', file_type: 'wav', classifier_role: 'stem' });
        (0, projectAssociationEngine_1.confirmQueueItem)(db, crypto_1.default.randomUUID(), [idA, idB, idC], 'same_project', 0.87);
        const rows = getAssetAssociations(db);
        // 3 files → C(3,2) = 3 pairs
        (0, vitest_1.expect)(rows.length).toBe(3);
        (0, vitest_1.expect)(rows.every((r) => r.confirmed_by === 'user')).toBe(true);
        (0, vitest_1.expect)(rows.every((r) => r.relationship === 'same_project')).toBe(true);
    });
    (0, vitest_1.it)('writes 1 association row for a 2-file confirmation', () => {
        const folder = '/Users/rishig/Music/TwoFile';
        const idA = insertFile(db, { file_path: `${folder}/x.flp`, file_name: 'x.flp', file_type: 'flp', classifier_role: 'daw_project' });
        const idB = insertFile(db, { file_path: `${folder}/x.wav`, file_name: 'x.wav', file_type: 'wav', classifier_role: 'bounce' });
        (0, projectAssociationEngine_1.confirmQueueItem)(db, crypto_1.default.randomUUID(), [idA, idB], 'exported_from', 0.91);
        const rows = getAssetAssociations(db);
        (0, vitest_1.expect)(rows.length).toBe(1);
        (0, vitest_1.expect)(rows[0].relationship).toBe('exported_from');
    });
});
// ── reject flow ───────────────────────────────────────────────────────────────
(0, vitest_1.describe)('queue status — reject', () => {
    let db;
    (0, vitest_1.beforeEach)(() => {
        db = buildMockDb();
    });
    (0, vitest_1.it)('rejected queue items are not re-queued on the next engine run', () => {
        const folder = '/Users/rishig/Music/RejectTest';
        insertFile(db, { file_path: `${folder}/rej.flp`, file_name: 'rej.flp', file_type: 'flp', classifier_role: 'daw_project' });
        insertFile(db, { file_path: `${folder}/rej FINAL.wav`, file_name: 'rej FINAL.wav', file_type: 'wav', classifier_role: 'master' });
        (0, projectAssociationEngine_1.runAssociationEngine)(db, 30 * 24 * 60 * 60 * 1000);
        // Manually mark queued items as rejected
        db.prepare("UPDATE association_queue SET status = 'rejected'").run();
        (0, vitest_1.expect)(getPendingQueue(db).length).toBe(0);
        // Run engine again — rejected items should not reappear as pending
        // (engine only inserts via INSERT OR IGNORE so same group key won't re-insert)
        (0, projectAssociationEngine_1.runAssociationEngine)(db, 30 * 24 * 60 * 60 * 1000);
        (0, vitest_1.expect)(getPendingQueue(db).length).toBe(0);
    });
});
