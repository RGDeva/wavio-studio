#!/usr/bin/env node
/**
 * Build the macOS release: every cell of the matrix, explicitly.
 *
 * Why this exists rather than `npm run build:mac`:
 *
 *   1. `electron-builder --mac dmg` builds the HOST architecture only,
 *      discarding the `arch` list in the config, and exits 0. The previous RC
 *      lost its x64 DMG that way and nothing reported a problem. Each cell is
 *      therefore invoked with its own explicit `--<arch>`.
 *   2. Credentials are checked BEFORE the expensive part. A distribution build
 *      that discovers at the notarization step that it has no certificate has
 *      wasted ten minutes and produced something misleading.
 *   3. `python` is checked, because the DMG target shells out to it and this
 *      machine's Xcode-shimmed python3 is broken — a failure that appears only
 *      at the very end, after both apps are packaged.
 *
 * Nothing is published: `--publish never` on every invocation.
 *
 * Usage:
 *   node scripts/release-mac.mjs                 distribution build (requires credentials)
 *   node scripts/release-mac.mjs --allow-unsigned  local artifact, clearly labelled
 */
import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import {
  detectSigningCredentials, detectNotarizationCredentials, parseIdentities,
  RELEASE_MATRIX, builderArgsFor, expectedArtifacts,
} from './macSigning.mjs';

const BANNER = '═'.repeat(72);
const allowUnsigned = process.argv.includes('--allow-unsigned');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const productName = pkg.build?.productName ?? pkg.productName ?? pkg.name;
const version = pkg.version;

function sh(cmd, args, env = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
}
function quiet(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return ''; }
}

// ── Preflight ───────────────────────────────────────────────────────────────
console.log(BANNER);
console.log(`Wavi Studio ${version} — macOS release build`);
console.log(BANNER);

const identities = parseIdentities(quiet('security', ['find-identity', '-v', '-p', 'codesigning']));
const signing = detectSigningCredentials({ identities, env: process.env });
const notary = detectNotarizationCredentials(process.env);

console.log(`  code signing:  ${signing.canSign ? `YES — ${signing.identity ?? signing.source}` : 'NO'}`);
if (!signing.canSign) console.log(`                 ${signing.reason}`);
console.log(`  notarization:  ${notary.canNotarize ? `YES — ${notary.method}` : 'NO'}`);
if (!notary.canNotarize) console.log(`                 ${notary.reason}`);

// The DMG target shells out to `python`. Checked here because it fails at the
// very END of packaging otherwise, after all the expensive work.
let python = quiet('which', ['python']).trim();
if (!python) {
  const clt = '/Library/Developer/CommandLineTools/usr/bin/python3';
  console.error('');
  console.error('  PREFLIGHT FAIL: no `python` on PATH, and the DMG target requires one.');
  if (existsSync(clt)) {
    console.error(`    A working interpreter exists at ${clt}.`);
    console.error('    Either repair the Xcode selection (needs your password):');
    console.error('      sudo xcode-select --switch /Library/Developer/CommandLineTools');
    console.error('    or put a `python` shim on PATH for this build:');
    console.error(`      mkdir -p /tmp/wavi-shim && ln -sf ${clt} /tmp/wavi-shim/python`);
    console.error('      PATH=/tmp/wavi-shim:$PATH node scripts/release-mac.mjs');
  }
  process.exit(2);
}
console.log(`  python:        ${python}`);

if (!allowUnsigned && (!signing.canSign || !notary.canNotarize)) {
  console.error('');
  console.error('  REFUSING to build a distribution release without full credentials.');
  console.error('  Nothing was built. Supply what is missing above, or re-run with');
  console.error('  --allow-unsigned to produce a clearly-labelled local artifact.');
  process.exit(2);
}
if (allowUnsigned) {
  console.log('');
  console.log('  MODE: local, unsigned. The result is NOT distributable.');
}

// ── Build ───────────────────────────────────────────────────────────────────
const buildEnv = allowUnsigned
  // Explicitly off rather than auto-discovered: a development certificate
  // would make the artifact LOOK signed while still failing Gatekeeper, which
  // is worse than an obviously unsigned build.
  ? { WAVI_ALLOW_UNSIGNED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  : {};

console.log('');
console.log('── compile ─────────────────────────────────────────────────────────────');
sh('npm', ['run', 'build'], buildEnv);

for (const cell of RELEASE_MATRIX) {
  console.log('');
  console.log(`── package ${cell.target} ${cell.arch} ──────────────────────────────────────────`);
  sh('npx', ['electron-builder', ...builderArgsFor(cell)], buildEnv);
}

// ── Confirm every cell actually produced a file ─────────────────────────────
console.log('');
console.log(BANNER);
const expected = expectedArtifacts(productName, version);
const missing = expected.filter((e) => !existsSync(`release/${e.file}`));
for (const e of expected) {
  console.log(`  ${existsSync(`release/${e.file}`) ? '✓' : '✗'} ${e.file}`);
}
if (missing.length) {
  console.error('');
  console.error(`  ${missing.length} expected artifact(s) missing despite a successful build.`);
  console.error('  This is the --mac <target> host-arch trap; check the per-cell logs above.');
  process.exit(1);
}
console.log('');
console.log('  All matrix cells produced an artifact. Verify with:');
console.log(`    node scripts/verify-release.mjs${allowUnsigned ? ' --local' : ''}`);
console.log(BANNER);
