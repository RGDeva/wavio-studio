#!/usr/bin/env node
/**
 * Release preflight — read-only.
 *
 * Nothing here changes the machine. It does not run sudo, does not touch
 * xcode-select, does not install anything, does not alter the keychain and
 * does not modify Python. It looks, reports, and exits non-zero when a
 * required tool or credential is missing.
 *
 * It exists because every failure it checks for surfaces at the WORST moment
 * otherwise: `which python` failing after both apps are packaged, or a missing
 * certificate discovered at the notarization step, ten minutes in, having
 * produced something that looks like a release.
 *
 * Usage:
 *   node scripts/release-preflight.mjs             distribution readiness
 *   node scripts/release-preflight.mjs --unsigned  only what unsigned packaging needs
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { arch as hostArch } from 'os';
import {
  parseIdentities, detectSigningCredentials, detectNotarizationCredentials,
  classifyToolFailure, IDENTITY_KINDS,
} from './macSigning.mjs';

const unsignedMode = process.argv.includes('--unsigned');
const PASS = 'PASS', FAIL = 'FAIL', NOT_RUN = 'NOT RUN', WARN = 'WARN';
const rows = [];
const add = (name, status, detail, required = true) => rows.push({ name, status, detail, required });

function probe(cmd, args = ['--version']) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim().split('\n')[0] };
  } catch (e) {
    const err = (e.stderr?.toString() ?? '') + (e.stdout?.toString() ?? '') + (e.message ?? '');
    return { ok: false, out: '', err };
  }
}

// ── Build toolchain ─────────────────────────────────────────────────────────
const node = probe('node');
add('node', node.ok ? PASS : FAIL, node.ok ? node.out : 'not runnable');

const npm = probe('npm');
add('npm', npm.ok ? PASS : FAIL, npm.ok ? npm.out : 'not runnable');

// electron-builder's DMG target shells out to `python`. macOS ships no
// `python`, and this machine's python3 is an Xcode shim pointing at a broken
// Xcode — so this is checked before anything expensive runs.
const CLT_PY = '/Library/Developer/CommandLineTools/usr/bin/python3';
const python = probe('which', ['python']);
if (python.ok && python.out) {
  add('python (DMG target)', PASS, python.out);
} else {
  const hint = existsSync(CLT_PY)
    ? `no \`python\` on PATH. A working interpreter exists at ${CLT_PY}. Either repair the Xcode selection yourself — \`sudo xcode-select --switch /Library/Developer/CommandLineTools\` — or put a PATH-scoped shim in front of this build: \`mkdir -p /tmp/wavi-shim && ln -sf ${CLT_PY} /tmp/wavi-shim/python && PATH=/tmp/wavi-shim:$PATH npm run release:mac\`. The shim is a workaround for one command, NOT a machine repair.`
    : 'no `python` on PATH and no Command Line Tools interpreter found. Install Command Line Tools.';
  add('python (DMG target)', FAIL, hint);
}

// ── Signing / notarization toolchain ────────────────────────────────────────
for (const [label, cmd, args] of [
  ['codesign', 'codesign', ['--version']],
  ['security', 'security', ['-h']],
  ['ditto', 'ditto', ['--version']],
  ['hdiutil', 'hdiutil', ['help']],
]) {
  const r = probe(cmd, args);
  const broken = classifyToolFailure(r.err ?? '');
  add(label, r.ok ? PASS : (broken.usable ? PASS : FAIL),
    r.ok ? (r.out || 'available') : (broken.usable ? 'available (non-zero exit on probe, which is normal)' : broken.reason),
    !unsignedMode);
}

// xcrun gates notarytool and stapler. Broken here, and that is worth saying
// precisely rather than as a generic failure.
const xcrun = probe('xcrun', ['--find', 'notarytool']);
const xcrunState = classifyToolFailure(xcrun.err ?? '');
add('xcrun / notarytool', xcrun.ok ? PASS : FAIL,
  xcrun.ok ? xcrun.out : (xcrunState.usable ? 'notarytool not found' : xcrunState.reason),
  !unsignedMode);

const stapler = probe('xcrun', ['--find', 'stapler']);
const staplerState = classifyToolFailure(stapler.err ?? '');
add('xcrun / stapler', stapler.ok ? PASS : FAIL,
  stapler.ok ? stapler.out : (staplerState.usable ? 'stapler not found' : staplerState.reason),
  !unsignedMode);

// ── Host architecture ───────────────────────────────────────────────────────
// Not a failure either way: an arm64 host cross-builds x64 fine. Recorded
// because it explains which of the two builds is the native one.
add('host architecture', PASS, `${hostArch()} (the other architecture is cross-built)`, false);

// ── Credentials ─────────────────────────────────────────────────────────────
const idProbe = probe('security', ['find-identity', '-v', '-p', 'codesigning']);
const identities = parseIdentities(idProbe.out ? idProbe.out : (() => {
  try { return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }); }
  catch { return ''; }
})());
const signing = detectSigningCredentials({ identities, env: process.env });

if (signing.canSign) {
  add('Developer ID Application', PASS, signing.identity ?? signing.source, !unsignedMode);
} else {
  const onlyDev = identities.some((i) => i.kind === IDENTITY_KINDS.APPLE_DEVELOPMENT);
  add('Developer ID Application', unsignedMode ? NOT_RUN : FAIL,
    unsignedMode ? 'not required for an unsigned build' : signing.reason, !unsignedMode);
  if (onlyDev) {
    add('— note', WARN,
      'An Apple Development certificate is present. It is NOT a distribution identity and will never qualify.', false);
  }
}

const notary = detectNotarizationCredentials(process.env);
add('notarization credentials', notary.canNotarize ? PASS : (unsignedMode ? NOT_RUN : FAIL),
  notary.canNotarize ? notary.reason : (unsignedMode ? 'not required for an unsigned build' : notary.reason),
  !unsignedMode);

// ── Config sanity ───────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
// `notarize` unset makes electron-builder skip notarization with only a
// warning, which is the silent-success this whole pipeline exists to prevent.
add('mac.notarize set explicitly', pkg.build?.mac?.notarize === true ? PASS : FAIL,
  pkg.build?.mac?.notarize === true
    ? 'true — electron-builder will notarize rather than silently skip'
    : 'NOT set. electron-builder skips notarization with only a warning when this is absent.');
add('hardenedRuntime', pkg.build?.mac?.hardenedRuntime === true ? PASS : FAIL,
  String(pkg.build?.mac?.hardenedRuntime));
add('entitlements file', existsSync(pkg.build?.mac?.entitlements ?? '') ? PASS : FAIL,
  pkg.build?.mac?.entitlements ?? '(not configured)');
add('artifactName has explicit arch', /\$\{arch\}/.test(pkg.build?.artifactName ?? '') ? PASS : FAIL,
  pkg.build?.artifactName ?? '(not configured)');

// ── Report ──────────────────────────────────────────────────────────────────
const width = Math.max(...rows.map((r) => r.name.length));
console.log(`release preflight — ${unsignedMode ? 'UNSIGNED packaging' : 'DISTRIBUTION'} mode`);
console.log('');
for (const r of rows) {
  console.log(`  ${r.status.padEnd(7)} ${r.name.padEnd(width)}  ${r.detail}`);
}
console.log('');

const blocking = rows.filter((r) => r.required && r.status === FAIL);
if (blocking.length) {
  console.error(unsignedMode
    ? `RESULT: BLOCKED — ${blocking.length} required item(s) missing for unsigned packaging.`
    : `RESULT: BLOCKED_FOR_DISTRIBUTION — ${blocking.length} required item(s) missing.`);
  process.exit(1);
}
console.log(unsignedMode
  ? 'RESULT: READY for unsigned packaging (the result is NOT distributable).'
  : 'RESULT: READY for a signed, notarized distribution build.');
