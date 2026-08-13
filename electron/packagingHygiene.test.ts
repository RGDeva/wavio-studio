/**
 * Packaging hygiene — keeps compiled test artifacts and developer paths out of
 * the shipped app.
 *
 * Why this exists: `dist-electron/` was never cleaned between builds, so output
 * compiled BEFORE `tsconfig.electron.json` started excluding `*.test.ts`
 * survived indefinitely on disk. The builder's `dist-electron/**` glob then
 * swept 7 stale `*.test.js` files into every `app.asar` — three of them
 * containing the developer's home directory. The tsconfig exclude was already
 * correct; nothing was regenerating those files, and nothing was removing them.
 *
 * The fix has two layers, and this suite guards both:
 *   1. the build cleans `dist-electron` first, so stale output of ANY kind
 *      cannot accumulate (the root cause, not just its test-file symptom);
 *   2. the builder `files` globs negate test output and dependency test trees,
 *      so even a reappearing artifact cannot reach the bundle.
 *
 * These are static assertions on config. The end-to-end proof — extracting a
 * freshly packaged `app.asar` and finding zero matches — is recorded in the
 * packaging section of docs/WAVI_MULTIPLAYER_V1_DESKTOP_AUDIT.md.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

/** Every electron-builder config that can produce a shippable bundle. */
const BUILDER_CONFIGS: { file: string; get: (d: any) => any }[] = [
  { file: 'package.json', get: (d) => d.build },
  { file: 'electron-builder.qa.json', get: (d) => d },
  { file: 'electron-builder.staging.json', get: (d) => d },
];

/** Negations every config must carry. A new config missing one is a failure. */
const REQUIRED_NEGATIONS = [
  '!dist-electron/**/*.test.js',
  '!dist-electron/**/*.spec.js',
  '!dist-electron/**/__tests__/**',
  '!node_modules/**/*.test.js',
  '!node_modules/**/*.spec.js',
];

describe('layer 1 — the build cleans stale output (root cause)', () => {
  const pkg = readJson('package.json');

  it('exposes a clean step for the electron output directory', () => {
    expect(pkg.scripts['clean:electron']).toBeTruthy();
    expect(pkg.scripts['clean:electron']).toContain('dist-electron');
  });

  it('every build path cleans before compiling', () => {
    // Without this, output from a previous tsconfig (e.g. before *.test.ts was
    // excluded) survives forever and gets packaged.
    expect(pkg.scripts.build).toContain('clean:electron');
    expect(pkg.scripts['build:electron']).toContain('clean:electron');
  });

  it('the clean step precedes compilation, not follows it', () => {
    for (const s of [pkg.scripts.build, pkg.scripts['build:electron']]) {
      expect(s.indexOf('clean:electron')).toBeLessThan(s.indexOf('tsc -p tsconfig.electron.json'));
    }
  });
});

describe('layer 2 — builder globs cannot ship test output', () => {
  for (const { file, get } of BUILDER_CONFIGS) {
    describe(file, () => {
      const files: string[] = get(readJson(file)).files;

      it('carries every required negation', () => {
        for (const n of REQUIRED_NEGATIONS) expect(files, n).toContain(n);
      });

      it('still ships the runtime it is supposed to ship', () => {
        expect(files).toContain('dist/**/*');
        expect(files).toContain('dist-electron/**/*');
      });

      it('negations come after the broad includes so they actually subtract', () => {
        const broad = files.indexOf('dist-electron/**/*');
        for (const n of files.filter((f) => f.startsWith('!'))) {
          expect(files.indexOf(n), n).toBeGreaterThan(broad);
        }
      });

      it('drops dependency source maps, which are debugging-only', () => {
        // ~10.5k files. Nothing reads them at runtime; excluding them took the
        // bundle from 162 MB to 70 MB.
        expect(files).toContain('!node_modules/**/*.map');
      });

      it('never excludes OUR OWN output — only dependency and test artifacts', () => {
        // A negation matching dist/ or the electron runtime tree would silently
        // break the app; every negation must target tests, node_modules, or both.
        for (const f of files.filter((x) => x.startsWith('!'))) {
          const ok = /^!node_modules\//.test(f)
            || /\.(test|spec)\.js(\.map)?$/.test(f)
            || /__tests__/.test(f);
          expect(ok, f).toBe(true);
        }
      });

      it('drops the SQLite C amalgamation, which is build-time only', () => {
        // ~9.5 MB of source the packaged app never reads — it loads the
        // prebuilt .node from app.asar.unpacked — and it carries the upstream
        // maintainer's build path.
        expect(files).toContain('!node_modules/better-sqlite3/deps/**');
      });

      it('does NOT exclude the native binary or its loader', () => {
        // Over-broad exclusion would silently break SQLite at runtime.
        for (const f of files.filter((x) => x.startsWith('!'))) {
          expect(f).not.toMatch(/better-sqlite3\/\*\*|better-sqlite3\/build|\.node/);
        }
      });
    });
  }
});

describe('the test suite itself is not weakened by the packaging fix', () => {
  it('tests are excluded from the ELECTRON COMPILE, not from the test runner', () => {
    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'tsconfig.electron.json'), 'utf8').replace(/\/\/.*$/gm, ''),
    );
    expect(tsconfig.exclude).toContain('electron/**/*.test.ts');

    // Vitest runs from the TypeScript sources, so excluding them from the
    // electron build removes zero coverage.
    const vitest = fs.readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8');
    expect(vitest).toMatch(/electron\/.*\.test\.ts/);
    expect(vitest).not.toContain('dist-electron');
  });

  it('no test file is excluded from the vitest include list by this change', () => {
    const vitest = fs.readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8');
    const listed = [...vitest.matchAll(/'([^']+\.test\.ts)'/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(40);
    const literals = listed.filter((r) => !r.includes('*'));
    const globs = listed.filter((r) => r.includes('*'));
    for (const rel of literals) {
      expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
    }
    // A glob entry must still resolve to real test files, or coverage silently
    // disappears without any list entry looking wrong.
    for (const g of globs) {
      const dir = path.join(ROOT, g.slice(0, g.indexOf('/**')));
      expect(fs.existsSync(dir), g).toBe(true);
      const found: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (/\.test\.ts$/.test(e.name)) found.push(full);
        }
      };
      walk(dir);
      expect(found.length, g).toBeGreaterThan(0);
    }
  });
});

describe('no developer path can reach the bundle from our own source', () => {
  it('no non-test source file under electron/ or src/ embeds a home path', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === 'test-native') continue;
          walk(full);
        } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          if (/\/Users\//.test(fs.readFileSync(full, 'utf8'))) {
            offenders.push(path.relative(ROOT, full));
          }
        }
      }
    };
    walk(path.join(ROOT, 'electron'));
    walk(path.join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('artifact verification exists and is wired', () => {
  it('ships a script that inspects the real packaged artifact', () => {
    // Config review alone could not have caught the original defect: the
    // tsconfig exclude and the builder globs both looked correct, and the
    // stale output was invisible until the bundle itself was opened.
    const pkg = readJson('package.json');
    expect(pkg.scripts['verify:package']).toContain('verify-package.mjs');
    expect(fs.existsSync(path.join(ROOT, 'scripts/verify-package.mjs'))).toBe(true);
  });

  it('the verifier checks every forbidden class and the required entry points', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/verify-package.mjs'), 'utf8');
    for (const needle of [
      '.test.js', '.test.ts', '.spec.js', '.spec.ts', '.env',
      '__tests__', 'coverage', 'developer paths', 'secrets',
      'dist-electron/main.js', 'dist-electron/preload.js', 'dist/index.html',
      'staging apiBase baked into a production build',
    ]) {
      expect(src, needle).toContain(needle);
    }
  });

  it('the verifier fails the build rather than warning', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/verify-package.mjs'), 'utf8');
    expect(src).toContain('process.exit(1)');
  });
});
