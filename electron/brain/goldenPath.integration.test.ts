/**
 * Project Brain — golden path, end to end, headless.
 *
 * Walks a REAL music folder on disk through REAL discovery into a REAL
 * file-backed SQLite database built from db.ts's own SQL, then searches,
 * derives, records activity, restarts, and reconciles a moved file.
 *
 * File-backed rather than :memory: on purpose — "restart" has to mean closing
 * the database and opening it again, or step 11 proves nothing.
 *
 * Electron is never launched (ENV-1). Discovery is imported directly; it
 * touches `app` only inside defaultDiscoveryRoots(), which this never calls.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, utimesSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import { readFileSync } from 'fs';
import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from '../test-helpers/native-sqlite';
import { parseBrainQuery } from './query';
import { rankRecords, type BrainRecord } from './retrieval';
import { deriveProjectMemory, type DeriveFile } from './derive';
import { resolveNamedRange } from './timeRange';

const maybeDescribe = nativeSqliteAvailable ? describe : describe.skip;
const dbSrc = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');

function extractSql(marker: string): string {
  const idx = dbSrc.indexOf(marker);
  if (idx < 0) throw new Error(`marker not found: ${marker}`);
  return dbSrc.slice(dbSrc.lastIndexOf('`', idx) + 1, dbSrc.indexOf('`', idx + marker.length));
}

/** Schema steps in db.ts's own source order (an ALTER that drifts above its CREATE fails here). */
function schemaSteps(): Array<{ sql: string; tolerant: boolean }> {
  const steps: Array<{ at: number; sql: string; tolerant: boolean }> = [];
  for (const marker of ['CREATE TABLE IF NOT EXISTS projects', 'CREATE TABLE IF NOT EXISTS bounce_candidates', 'CREATE TABLE IF NOT EXISTS links']) {
    steps.push({ at: dbSrc.indexOf(marker), sql: extractSql(marker), tolerant: false });
  }
  for (const m of dbSrc.matchAll(/db\.exec\('((?:ALTER TABLE|CREATE UNIQUE INDEX|CREATE INDEX)[^']*)'\)/g)) {
    steps.push({ at: m.index!, sql: m[1], tolerant: true });
  }
  for (const m of dbSrc.matchAll(/db\.exec\("((?:ALTER TABLE)[^"]*)"\)/g)) {
    steps.push({ at: m.index!, sql: m[1], tolerant: true });
  }
  return steps.sort((a, b) => a.at - b.at).map(({ sql, tolerant }) => ({ sql, tolerant }));
}

const NOW = '2026-10-08T15:00:00.000Z';

maybeDescribe('Project Brain golden path (real FS → real SQLite → search → restart → reconcile)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require(NATIVE_SQLITE_PATH);
  let root: string;
  let dbPath: string;
  let db: any;

  function openDb() {
    const d = new Database(dbPath);
    d.pragma('foreign_keys = ON');
    for (const { sql, tolerant } of schemaSteps()) {
      if (tolerant) { try { d.exec(sql); } catch { /* db.ts semantics */ } }
      else d.exec(sql);
    }
    return d;
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'wavi-brain-golden-'));
    dbPath = join(root, 'brain.db');

    // ── The fixture from the spec ──────────────────────────────────────────
    mkdirSync(join(root, 'Music', 'Sunshine'), { recursive: true });
    writeFileSync(join(root, 'Music', 'Sunshine', 'Sunshine.flp'), 'FLP');
    writeFileSync(join(root, 'Music', 'Sunshine', 'vocal.wav'), 'VOCAL');
    writeFileSync(join(root, 'Music', 'Sunshine', 'drums.wav'), 'DRUMS');
    writeFileSync(join(root, 'Music', 'Sunshine', 'master-v7.wav'), 'MASTER');

    mkdirSync(join(root, 'Music', 'Faith', 'stems'), { recursive: true });
    writeFileSync(join(root, 'Music', 'Faith', 'Faith.als'), 'ALS');
    writeFileSync(join(root, 'Music', 'Faith', 'stems', 'bass.wav'), 'BASS');
    writeFileSync(join(root, 'Music', 'Faith', 'stems', 'vocals.wav'), 'VOCALS');

    db = openDb();
  });
  afterAll(() => { db?.close(); rmSync(root, { recursive: true, force: true }); });

  const insertProject = db_ => (id: string, name: string, path: string, daw: string) =>
    db_.prepare(`INSERT OR IGNORE INTO projects (id, project_name, file_path, daw_type, created_at, modified_at)
      VALUES (?,?,?,?,?,?)`).run(id, name, path, daw, NOW, NOW);

  it('1–2. scans the folder and discovers exactly two projects', async () => {
    const { discoverAudioFiles } = await import('../discovery');
    const { paths } = await discoverAudioFiles({ roots: [join(root, 'Music')], maxDepth: 6 });
    // 2 project files + 5 audio files
    expect(paths).toHaveLength(7);
    const projectFiles = paths.filter((p) => p.endsWith('.flp') || p.endsWith('.als'));
    expect(projectFiles).toHaveLength(2);
    expect(projectFiles.some((p) => p.endsWith(`Sunshine${sep}Sunshine.flp`))).toBe(true);
    expect(projectFiles.some((p) => p.endsWith(`Faith${sep}Faith.als`))).toBe(true);
  });

  it('3–5. classifies, associates by directory, and persists', async () => {
    const { discoverAudioFiles } = await import('../discovery');
    const { classifyFileRole } = await import('../adapters/common');
    const { getAdapterForFile } = await import('../adapters/index');
    const { paths } = await discoverAudioFiles({ roots: [join(root, 'Music')], maxDepth: 6 });

    const mk = insertProject(db);
    mk('p-sun', 'Sunshine', join(root, 'Music', 'Sunshine', 'Sunshine.flp'), 'fl-studio');
    mk('p-faith', 'Faith', join(root, 'Music', 'Faith', 'Faith.als'), 'ableton');

    const ins = db.prepare(`INSERT OR IGNORE INTO files
      (id, project_id, file_path, file_name, file_type, file_size, role, created_at, modified_at, discovered_at, last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    let n = 0;
    for (const p of paths) {
      // Deterministic association: the containing project directory.
      const projectId = p.includes(`${sep}Sunshine${sep}`) ? 'p-sun' : 'p-faith';
      const name = p.split(sep).pop()!;
      const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
      ins.run(`f-${++n}`, projectId, p, name, ext, 5, classifyFileRole(name, 'unknown'), NOW, NOW, NOW, NOW);
    }

    expect(getAdapterForFile(join(root, 'Music', 'Sunshine', 'Sunshine.flp')).id).toBe('fl-studio');
    expect(db.prepare('SELECT COUNT(*) c FROM projects').get().c).toBe(2);
    expect(db.prepare("SELECT COUNT(*) c FROM files WHERE project_id='p-sun'").get().c).toBe(4);
    expect(db.prepare("SELECT COUNT(*) c FROM files WHERE project_id='p-faith'").get().c).toBe(3);
    // The project files were classified as projects, not as loose audio.
    expect(db.prepare("SELECT role FROM files WHERE file_name='Sunshine.flp'").get().role).toBe('project');
  });

  function records(): BrainRecord[] {
    const rows = db.prepare(`
      SELECT f.id, f.project_id, f.file_name AS name, p.project_name, p.daw_type,
             f.role, f.file_type, f.modified_at
      FROM files f LEFT JOIN projects p ON f.project_id = p.id`).all();
    return rows.map((r: any) => ({
      id: r.id, kind: 'file' as const, projectId: r.project_id, name: r.name,
      projectName: r.project_name ?? '', dawType: r.daw_type ?? null, role: r.role ?? null,
      fileType: r.file_type ?? null, bpm: null, keyNote: null, status: null, modifiedAt: r.modified_at,
    }));
  }

  it('6. search "Sunshine vocal" finds the right file in the right project', () => {
    const hits = rankRecords(records(), parseBrainQuery('sunshine vocal', 2026), { now: NOW });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].record.name).toBe('vocal.wav');
    expect(hits[0].record.projectName).toBe('Sunshine');
    // Faith's vocals.wav must not win: it is not in the Sunshine project.
    expect(hits[0].record.projectId).toBe('p-sun');
  });

  it('7. identifies master-v7 as the likely master, as an INFERENCE', () => {
    const files: DeriveFile[] = db.prepare("SELECT * FROM files WHERE project_id='p-sun'").all()
      .map((f: any) => ({
        id: f.id, name: f.file_name, role: f.role, fileType: f.file_type, sizeBytes: f.file_size,
        modifiedAt: f.modified_at, localStatus: f.local_status ?? 'present',
        syncStatus: f.sync_status ?? 'pending', checksum: f.checksum ?? null,
      }));
    const mem = deriveProjectMemory({ projectId: 'p-sun', projectName: 'Sunshine', dawType: 'fl-studio', files, versions: [] });
    const master = mem.inferences.find((i) => i.key === 'likely-master')!;
    expect(master.value).toBe('master-v7.wav');
    // It is a guess with evidence, never presented as a fact.
    expect(mem.facts.some((f) => f.key === 'likely-master')).toBe(false);
    expect(master.evidence).toBeTruthy();
  });

  it('8–9. a change to master-v7 is detected and recorded as activity', () => {
    const later = '2026-10-08T16:30:00.000Z';
    writeFileSync(join(root, 'Music', 'Sunshine', 'master-v7.wav'), 'MASTER v8 CONTENT');
    const future = new Date('2026-10-08T16:30:00.000Z');
    utimesSync(join(root, 'Music', 'Sunshine', 'master-v7.wav'), future, future);

    db.prepare("UPDATE files SET modified_at = ?, file_size = ?, last_seen_at = ? WHERE file_name = 'master-v7.wav'")
      .run(later, 17, later);
    db.prepare(`INSERT INTO activity_log (id, type, message, project_id, file_id, created_at)
      VALUES ('a1','file_changed','master-v7.wav changed','p-sun',
              (SELECT id FROM files WHERE file_name='master-v7.wav'), ?)`).run(later);

    expect(db.prepare("SELECT modified_at FROM files WHERE file_name='master-v7.wav'").get().modified_at).toBe(later);
    expect(db.prepare('SELECT COUNT(*) c FROM activity_log').get().c).toBe(1);
  });

  it('10. recent activity answers "what changed today?"', () => {
    const range = resolveNamedRange('today', NOW);
    const events = db.prepare(`
      SELECT a.*, p.project_name FROM activity_log a LEFT JOIN projects p ON a.project_id = p.id
      WHERE a.created_at >= ? AND a.created_at <= ? ORDER BY a.created_at DESC`)
      .all(range.from, range.to);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('file_changed');
    expect(events[0].project_name).toBe('Sunshine');

    // And the window genuinely excludes other days.
    const yesterday = resolveNamedRange('yesterday', NOW);
    expect(db.prepare('SELECT COUNT(*) c FROM activity_log WHERE created_at >= ? AND created_at <= ?')
      .get(yesterday.from, yesterday.to).c).toBe(0);
  });

  it('11–12. the same facts survive closing and reopening the database', () => {
    db.close();
    db = openDb();   // genuine restart: new connection to the same file

    expect(db.prepare('SELECT COUNT(*) c FROM projects').get().c).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM files').get().c).toBe(7);
    expect(db.prepare('SELECT COUNT(*) c FROM activity_log').get().c).toBe(1);
    expect(db.prepare("SELECT modified_at FROM files WHERE file_name='master-v7.wav'").get().modified_at)
      .toBe('2026-10-08T16:30:00.000Z');
    // Re-running the schema must not duplicate anything.
    expect(db.prepare("SELECT COUNT(*) c FROM files WHERE file_name='vocal.wav'").get().c).toBe(1);

    // Search still works identically after the restart.
    const hits = rankRecords(records(), parseBrainQuery('sunshine vocal', 2026), { now: NOW });
    expect(hits[0].record.name).toBe('vocal.wav');
  });

  it('13–14. a moved file reconciles honestly rather than silently vanishing', () => {
    const from = join(root, 'Music', 'Sunshine', 'drums.wav');
    const to = join(root, 'Music', 'Sunshine', 'drums-final.wav');
    renameSync(from, to);

    // The index first notices the old path is gone...
    db.prepare("UPDATE files SET local_status='missing' WHERE file_path = ?").run(from);
    expect(db.prepare("SELECT local_status FROM files WHERE file_path = ?").get(from).local_status).toBe('missing');

    // ...and a missing file is excluded from the master inference rather than
    // being quietly treated as present.
    const filesNow: DeriveFile[] = db.prepare("SELECT * FROM files WHERE project_id='p-sun'").all()
      .map((f: any) => ({
        id: f.id, name: f.file_name, role: f.role, fileType: f.file_type, sizeBytes: f.file_size,
        modifiedAt: f.modified_at, localStatus: f.local_status ?? 'present',
        syncStatus: f.sync_status ?? 'pending', checksum: f.checksum ?? null,
      }));
    const mem = deriveProjectMemory({ projectId: 'p-sun', projectName: 'Sunshine', dawType: 'fl-studio', files: filesNow, versions: [] });
    expect(mem.facts.find((f) => f.key === 'missing-file-count')!.value).toBe('1');
    expect(mem.facts.find((f) => f.key === 'present-file-count')!.value).toBe('3');

    // Reconciliation to the new path restores it without creating a duplicate.
    db.prepare("UPDATE files SET file_path = ?, file_name = 'drums-final.wav', local_status='present', reconciled_from = ? WHERE file_path = ?")
      .run(to, from, from);
    expect(db.prepare('SELECT COUNT(*) c FROM files').get().c).toBe(7);
    const row = db.prepare("SELECT * FROM files WHERE file_name='drums-final.wav'").get();
    expect(row.local_status).toBe('present');
    expect(row.reconciled_from).toBe(from);
  });
});
