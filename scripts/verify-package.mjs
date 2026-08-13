#!/usr/bin/env node
/**
 * Verifies the PACKAGED artifact, not the config that produced it.
 *
 * The packaging defect this guards against was invisible to config review: the
 * TypeScript config already excluded `*.test.ts`, and the builder globs looked
 * correct. The bug was that `dist-electron/` was never cleaned, so compiled
 * output from BEFORE that exclude existed survived on disk and was swept into
 * every bundle. Only inspecting the real artifact catches that class of fault.
 *
 * Usage:  node scripts/verify-package.mjs [path/to/app.asar]
 * Exits non-zero on any violation, so it can gate a release.
 */
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { tmpdir } from 'os';

const FORBIDDEN_FILE = [
  { label: '*.test.js', re: /\.test\.js$/ },
  { label: '*.test.ts', re: /\.test\.ts$/ },
  { label: '*.spec.js', re: /\.spec\.js$/ },
  { label: '*.spec.ts', re: /\.spec\.ts$/ },
  { label: '.env files', re: /(^|\/)\.env(\.|$)/ },
  { label: 'local databases', re: /\.(db|sqlite|sqlite3)$/ },
  { label: 'log files', re: /\.log$/ },
  { label: 'source maps', re: /\.map$/ },
];

const FORBIDDEN_DIR = [
  { label: '__tests__ dirs', name: '__tests__' },
  { label: 'coverage dirs', name: 'coverage' },
];

/** Required runtime entry points — their absence is as serious as a leak. */
const REQUIRED = [
  'dist-electron/main.js',
  'dist-electron/preload.js',
  'dist/index.html',
];

/**
 * Developer-machine paths. `/home/…` is deliberately NOT scanned as a leak:
 * @opentelemetry/semantic-conventions embeds `/home/user`-style strings as
 * documentation EXAMPLES inside attribute descriptions, and they are dependency
 * content rather than anything from a build machine. Our own output is scanned
 * strictly and must contain none of these.
 */
const DEV_PATH = /\/Users\/[A-Za-z0-9._-]+\/|C:\\Users\\/;

/** Credential shapes that must never ship. */
const SECRET = [
  { label: 'bearer token', re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { label: 'desktop token', re: /\bwv_[A-Za-z0-9]{16,}/ },
  { label: 'privy DID fixture', re: /did:privy:[A-Za-z0-9]{8,}/ },
  { label: 'supabase service role', re: /service_role|SUPABASE_SERVICE/ },
  { label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function findAsar() {
  for (const root of ['release', 'release-staging']) {
    if (!existsSync(root)) continue;
    const hits = walk(root).filter((f) => f.endsWith('app.asar'));
    if (hits.length) return hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  }
  return null;
}

const asar = process.argv[2] ?? findAsar();
if (!asar || !existsSync(asar)) {
  console.error('verify-package: no app.asar found. Package first (npm run build && npx electron-builder --mac --dir).');
  process.exit(2);
}

const out = join(tmpdir(), `wavi-verify-${process.pid}`);
rmSync(out, { recursive: true, force: true });
execFileSync('npx', ['asar', 'extract', asar, out], { stdio: 'pipe' });

const files = walk(out);
const rel = (f) => relative(out, f);
const violations = [];

for (const { label, re } of FORBIDDEN_FILE) {
  const hits = files.filter((f) => re.test(rel(f)));
  if (hits.length) violations.push({ label, count: hits.length, sample: hits.slice(0, 5).map(rel) });
}

for (const { label, name } of FORBIDDEN_DIR) {
  const hits = files.filter((f) => rel(f).split('/').includes(name));
  if (hits.length) violations.push({ label, count: hits.length, sample: hits.slice(0, 3).map(rel) });
}

// Text scans. Binaries are skipped: a .node or image can contain arbitrary
// bytes, and decoding them as UTF-8 produces meaningless matches.
const TEXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.html', '.css', '.txt', '.md', '']);
const devPathHits = [];
const secretHits = [];
for (const f of files) {
  if (!TEXT.has(extname(f))) continue;
  let body;
  try { body = readFileSync(f, 'utf8'); } catch { continue; }
  if (DEV_PATH.test(body)) devPathHits.push(rel(f));
  for (const { label, re } of SECRET) if (re.test(body)) secretHits.push(`${label}: ${rel(f)}`);
}
if (devPathHits.length) violations.push({ label: 'developer paths', count: devPathHits.length, sample: devPathHits.slice(0, 5) });
if (secretHits.length) violations.push({ label: 'secrets', count: secretHits.length, sample: secretHits.slice(0, 5) });

const missing = REQUIRED.filter((r) => !existsSync(join(out, r)));
if (missing.length) violations.push({ label: 'MISSING runtime entry points', count: missing.length, sample: missing });

// Production builds must not carry a staging API base as their default.
const pkgPath = join(out, 'package.json');
if (existsSync(pkgPath)) {
  const meta = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const baked = meta.waviQaDefaults?.apiBase;
  const isStagingBuild = /release-staging/.test(asar) || /Staging/.test(asar);
  if (baked && !isStagingBuild) {
    violations.push({ label: 'staging apiBase baked into a production build', count: 1, sample: [baked] });
  }
}

console.log(`verify-package: ${asar}`);
console.log(`  files inspected: ${files.length}`);
for (const r of REQUIRED) console.log(`  required present: ${r}`);
if (!violations.length) {
  console.log('  RESULT: PASS — production runtime only');
  rmSync(out, { recursive: true, force: true });
  process.exit(0);
}
console.error('  RESULT: FAIL');
for (const v of violations) {
  console.error(`   · ${v.label}: ${v.count}`);
  for (const s of v.sample) console.error(`       ${s}`);
}
rmSync(out, { recursive: true, force: true });
process.exit(1);
