#!/usr/bin/env node
/**
 * Build the macOS release. One command, both architectures, no ambiguity.
 *
 * Three things this exists to prevent, each of which actually happened:
 *
 *   1. `electron-builder --mac dmg` builds the HOST architecture only,
 *      discarding the `arch` list in the config, and exits 0. The v1.0.0
 *      public release shipped arm64 only, and the 1.1.0 release candidate lost
 *      its x64 DMG the same way. Every cell is therefore invoked with its own
 *      explicit `--<arch>`, and the run FAILS if any expected file is absent —
 *      a successful build that produced one architecture when two were asked
 *      for is a failure, not a partial success.
 *   2. A release discovering at the notarization step that it has no
 *      certificate, having already spent ten minutes producing something that
 *      looks signed. Preflight runs first and refuses.
 *   3. Notarization being skipped with a warning nobody reads. `mac.notarize`
 *      is set explicitly in the config, and this script verifies credentials
 *      are present before it starts.
 *
 * Nothing is published: `--publish never` on every invocation.
 *
 * Usage:
 *   node scripts/release-mac.mjs             signed + notarized (requires credentials)
 *   node scripts/release-mac.mjs --unsigned  local artifact, explicitly not distributable
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import {
  parseIdentities, detectSigningCredentials, detectNotarizationCredentials,
  notarizeConfigArgs, RELEASE_MATRIX, builderArgsFor, releaseArtifactNames,
} from './macSigning.mjs';

const unsigned = process.argv.includes('--unsigned');
const BAR = '═'.repeat(74);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;

const sh = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
const quiet = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return ''; }
};

console.log(BAR);
console.log(`Wavi Studio ${version} — macOS ${unsigned ? 'UNSIGNED (local only)' : 'DISTRIBUTION'} build`);
console.log(BAR);
console.log('');

// ── 1. Preflight, as its own process so its exit code is the gate ───────────
try {
  sh('node', ['scripts/release-preflight.mjs', ...(unsigned ? ['--unsigned'] : [])]);
} catch {
  console.error('');
  console.error('  Nothing was built. Fix the items above, or use --unsigned for a');
  console.error('  local-only artifact that is clearly labelled as not distributable.');
  process.exit(2);
}

const identities = parseIdentities(quiet('security', ['find-identity', '-v', '-p', 'codesigning']));
const signing = detectSigningCredentials({ identities, env: process.env });
const notary = detectNotarizationCredentials(process.env);

// Belt and braces: preflight already refused, and this refuses again, because
// the thing being prevented is an artifact that claims more than it is.
if (!unsigned && (!signing.canSign || !notary.canNotarize)) {
  console.error('BLOCKED_FOR_DISTRIBUTION — credentials incomplete. Nothing was built.');
  process.exit(2);
}

const buildEnv = unsigned
  // Explicitly off, not auto-discovered: an Apple Development certificate
  // would make the artifact LOOK signed while still failing Gatekeeper, which
  // is worse than an obviously unsigned build.
  ? { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  : {};
const extraArgs = unsigned
  ? ['-c.mac.notarize=false']
  : notarizeConfigArgs(notary, process.env);

// ── 2. Compile once ────────────────────────────────────────────────────────
console.log('');
console.log('── compile ───────────────────────────────────────────────────────────────');
sh('npm', ['run', 'build'], buildEnv);

// ── 3. Package every cell, architecture always explicit ────────────────────
for (const cell of RELEASE_MATRIX) {
  console.log('');
  console.log(`── package ${cell.target} ${cell.arch} ${'─'.repeat(44)}`);
  sh('npx', ['electron-builder', ...builderArgsFor(cell), ...extraArgs], buildEnv);
}

// ── 4. Staple each DMG ─────────────────────────────────────────────────────
// electron-builder's native notarization staples the .app before the DMG is
// built, so the app inside carries its ticket. The disk image itself does not,
// and the DMG is what a user downloads — so it gets its own staple.
const expected = releaseArtifactNames(version);
if (!unsigned) {
  for (const a of expected.filter((x) => x.target === 'dmg')) {
    const p = `release/${a.file}`;
    if (!existsSync(p)) continue;
    console.log('');
    console.log(`── staple ${a.file} ${'─'.repeat(30)}`);
    try { sh('xcrun', ['stapler', 'staple', p]); }
    catch {
      console.error(`  FAILED to staple ${a.file}.`);
      console.error('  The app inside is stapled, but the disk image is not — a first');
      console.error('  launch from this DMG will need the network. Not fatal, but the');
      console.error('  verifier will report it, and it must not be published as-is.');
    }
  }
}

// ── 5. Every expected artifact must exist ──────────────────────────────────
console.log('');
console.log(BAR);
const missing = expected.filter((e) => !existsSync(`release/${e.file}`));
for (const e of expected) {
  console.log(`  ${existsSync(`release/${e.file}`) ? '✓' : '✗'} ${e.file}`);
}
if (missing.length) {
  console.error('');
  console.error(`  FAILURE: ${missing.length} expected artifact(s) absent after a "successful" build.`);
  console.error('  One architecture when two were requested is a failure, not a partial');
  console.error('  success. Check the per-cell logs above.');
  process.exit(1);
}

// ── 6. Checksums, recorded now so verification has something to compare ────
const sums = expected.map((e) => {
  const p = `release/${e.file}`;
  const buf = readFileSync(p);
  return { ...e, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
});
writeFileSync('release/SHA256SUMS.txt',
  sums.map((s) => `${s.sha256}  ${s.file}\n`).join(''), 'utf8');

console.log('');
console.log('  SHA256SUMS.txt written.');
console.log('');
console.log('  Next — nothing is published or eligible until this passes:');
console.log(`    node scripts/verify-release.mjs${unsigned ? ' --unsigned' : ''}`);
console.log(BAR);
