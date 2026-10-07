#!/usr/bin/env node
/**
 * Verify the release artifacts, and decide whether they may be linked publicly.
 *
 * `verify-package.mjs` checks what is INSIDE the bundle. This checks what the
 * bundle IS — signed by whom, hardened, notarized, stapled, built for the
 * architecture its filename claims — and then emits the release manifest the
 * website workflow consumes.
 *
 * Every check reports PASS, FAIL or NOT RUN. The third state is the important
 * one: a check that could not be performed is never counted as a pass, because
 * "we could not tell" and "it is fine" are the two things a release gate must
 * never confuse. On this machine several Xcode tools are broken, so NOT RUN is
 * a real and frequent outcome rather than a theoretical one.
 *
 * Nothing here infers anything from a build log.
 *
 * Usage:
 *   node scripts/verify-release.mjs             distribution gate
 *   node scripts/verify-release.mjs --unsigned  structural only; signing reported NOT RUN
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import {
  parseCodesign, parseSpctl, parseStapler, parseMachoArchs, machoNameFor,
  classifyToolFailure, ticketFileEvidence, releaseArtifactNames,
  buildReleaseManifest, auditManifest, assessPublicEligibility,
  IDENTITY_KINDS,
} from './macSigning.mjs';

const unsigned = process.argv.includes('--unsigned');
const PASS = 'PASS', FAIL = 'FAIL', NOT_RUN = 'NOT RUN';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const productName = pkg.build?.productName ?? pkg.name;

/** The commit the artifacts were built from, recorded for the manifest. */
function sourceCommit() {
  try {
    return execFileSync('/Library/Developer/CommandLineTools/usr/bin/git', ['rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

function tool(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '' };
  } catch (e) {
    return { ok: false, out: e.stdout?.toString() ?? '', err: e.stderr?.toString() ?? String(e.message ?? '') };
  }
}

const checks = [];
/** @param status one of PASS | FAIL | NOT RUN */
const add = (scope, name, status, detail) => checks.push({ scope, name, status, detail });

const APP_DIRS = { arm64: 'release/mac-arm64', x64: 'release/mac' };
const expected = releaseArtifactNames(version);

// ── Per-architecture application checks ─────────────────────────────────────
/** Findings per arch, folded into the manifest and the eligibility gate. */
const archFindings = {};

for (const arch of ['arm64', 'x64']) {
  const dir = APP_DIRS[arch];
  const app = `${dir}/${productName}.app`;
  const f = {
    archMatches: false, hardenedRuntime: false, developerIdSigned: false,
    notarized: false, stapled: false, signingIdentity: null,
  };
  archFindings[arch] = f;

  if (!existsSync(app)) {
    add(arch, 'app bundle', FAIL, `missing ${app}`);
    continue;
  }

  // Architecture, read from the Mach-O header. `lipo` is an Xcode shim and is
  // broken on this machine, so relying on it would make "wrong architecture"
  // indistinguishable from "my toolchain is broken".
  const want = machoNameFor(arch);
  const readArch = (p) => { try { return parseMachoArchs(readFileSync(p)).join(', '); } catch { return null; } };
  const binArch = readArch(`${app}/Contents/MacOS/${productName}`);
  const binOk = binArch === want;
  add(arch, 'binary architecture', binOk ? PASS : FAIL, binArch ? `${binArch} (want ${want})` : 'unreadable');

  // The cross-arch trap: a native module built for the wrong architecture
  // produces an app that launches and then dies the moment it touches the
  // database, and nothing earlier in the build would say so.
  const nodeMod = `${app}/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`;
  const modArch = existsSync(nodeMod) ? readArch(nodeMod) : null;
  const modOk = modArch === want;
  add(arch, 'better_sqlite3 architecture', modOk ? PASS : FAIL,
    modArch ? `${modArch} (want ${want})` : 'native module not unpacked — the app will fail on first database access');
  f.archMatches = binOk && modOk;

  if (unsigned) {
    for (const n of ['codesign --verify', 'Developer ID identity', 'hardened runtime', 'Gatekeeper assessment', 'stapled ticket']) {
      add(arch, n, NOT_RUN, 'unsigned mode — not checked, and not claimed');
    }
    continue;
  }

  // Deep + strict: a signature on the outer bundle says nothing about nested
  // helpers and native modules, and notarization checks all of them.
  const verify = tool('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const vState = classifyToolFailure(verify.err);
  add(arch, 'codesign --verify', !vState.usable ? NOT_RUN : verify.ok ? PASS : FAIL,
    !vState.usable ? vState.reason : verify.ok ? 'valid on disk' : (verify.err.trim().split('\n')[0] || 'failed'));

  const show = tool('codesign', ['-dvvv', app]);
  const cs = parseCodesign(show.err || show.out);
  f.signingIdentity = cs.leaf;
  f.developerIdSigned = cs.leafKind === IDENTITY_KINDS.DEVELOPER_ID;
  add(arch, 'Developer ID identity', f.developerIdSigned ? PASS : FAIL,
    cs.unsigned ? 'not signed at all'
      : cs.adhoc ? 'ad-hoc signature — not a real identity'
      : cs.leaf ? `${cs.leaf} [${cs.leafKind}]`
      : 'no signing authority');

  f.hardenedRuntime = cs.hardenedRuntime;
  add(arch, 'hardened runtime', cs.hardenedRuntime ? PASS : FAIL,
    cs.hardenedRuntime ? 'runtime flag present in the signed CodeDirectory'
      : 'runtime flag NOT set in the signed binary (the config asking for it is a different claim)');

  const assess = tool('spctl', ['--assess', '--type', 'execute', '-vv', app]);
  const aState = classifyToolFailure(assess.err);
  const sp = parseSpctl((assess.out || '') + (assess.err || ''));
  f.notarized = sp.notarizedDeveloperId;
  add(arch, 'Gatekeeper assessment', !aState.usable ? NOT_RUN : sp.notarizedDeveloperId ? PASS : FAIL,
    !aState.usable ? aState.reason
      : sp.anomaly ? sp.anomaly
      : sp.rejected ? `rejected (source=${sp.source ?? 'unknown'})`
      : sp.accepted ? `accepted but source=${sp.source ?? 'unknown'} — only "Notarized Developer ID" proves notarization`
      : 'no verdict');

  const staple = tool('xcrun', ['stapler', 'validate', app]);
  const st = parseStapler((staple.out || '') + (staple.err || ''));
  if (st.usable === false) {
    // stapler cannot run here. Corroborate with the ticket file, explicitly
    // labelled, and report NOT RUN — evidence is not proof.
    let entries = [];
    try { entries = readdirSync(`${app}/Contents`); } catch { /* unreadable */ }
    const ev = ticketFileEvidence(entries);
    add(arch, 'stapled ticket', NOT_RUN,
      `${st.reason}; ticket file ${ev.present ? 'IS' : 'is NOT'} present (heuristic, not proof)`);
    f.stapled = false;
  } else {
    f.stapled = st.stapled;
    add(arch, 'stapled ticket', st.stapled ? PASS : FAIL, st.stapled ? 'ticket present' : st.reason);
  }
}

// ── Artifact-level checks ──────────────────────────────────────────────────
const artifacts = [];
for (const e of expected) {
  const p = join('release', e.file);
  if (!existsSync(p)) {
    add('artifacts', e.file, FAIL, 'missing — one architecture when two were requested is a failure');
    continue;
  }
  const buf = readFileSync(p);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  add('artifacts', e.file, PASS, `${(buf.length / 1048576).toFixed(0)} MB  ${sha256.slice(0, 16)}…`);

  let stapled = false;
  if (!unsigned && e.target === 'dmg') {
    const staple = tool('xcrun', ['stapler', 'validate', p]);
    const st = parseStapler((staple.out || '') + (staple.err || ''));
    // No heuristic exists for a disk image, so an unusable stapler is simply
    // unknown here.
    stapled = st.stapled;
    add('artifacts', `${e.file} stapled`, st.usable === false ? NOT_RUN : st.stapled ? PASS : FAIL, st.reason ?? 'ticket present');
  } else if (unsigned) {
    add('artifacts', `${e.file} stapled`, NOT_RUN, 'unsigned mode');
  }

  const af = archFindings[e.arch] ?? {};
  artifacts.push({
    arch: e.arch, filename: e.file, bytes: buf.length, sha256,
    signed: af.developerIdSigned === true,
    signingIdentity: af.signingIdentity ?? null,
    notarized: af.notarized === true,
    stapled: e.target === 'dmg' ? stapled : af.stapled === true,
    archMatches: af.archMatches === true,
    hardenedRuntime: af.hardenedRuntime === true,
  });
}

// ── Production package verification (reused, not reimplemented) ─────────────
const vp = tool('node', ['scripts/verify-package.mjs']);
const packageVerified = vp.ok;
add('package', 'verify-package', packageVerified ? PASS : FAIL,
  packageVerified ? 'production runtime only' : 'see verify-package output');

// ── Source commit ──────────────────────────────────────────────────────────
const commit = sourceCommit();
add('provenance', 'source commit', commit ? PASS : NOT_RUN, commit ?? 'could not read git HEAD');

// ── The public eligibility gate ────────────────────────────────────────────
// One gate, no override. Every mandatory requirement must be explicitly true.
const manifestArtifacts = artifacts.map((a) => {
  const el = assessPublicEligibility({
    archMatches: a.archMatches,
    packageVerified,
    developerIdSigned: a.signed,
    hardenedRuntime: a.hardenedRuntime,
    notarized: a.notarized,
    stapled: a.stapled,
    noSecretsOrDevPaths: packageVerified,   // verify-package is exactly that scan
    sourceCommitMatches: !!commit,
  });
  return { ...a, packageVerified, publicDownloadEligible: el.publicDownloadEligible, unmet: el.unmet };
});

const manifest = buildReleaseManifest({
  version, sourceCommit: commit, generatedAt: new Date().toISOString(),
  artifacts: manifestArtifacts,
});
const leak = auditManifest(manifest);
add('manifest', 'no local paths or secrets', leak.ok ? PASS : FAIL,
  leak.ok ? 'clean' : `would leak: ${leak.leaks.join(', ')}`);

if (existsSync('release')) {
  writeFileSync('release/release-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`verify-release: ${productName} ${version} — ${unsigned ? 'UNSIGNED' : 'DISTRIBUTION'} mode`);
console.log('');
let scope = null;
for (const c of checks) {
  if (c.scope !== scope) { scope = c.scope; console.log(`  [${scope}]`); }
  console.log(`    ${c.status.padEnd(7)} ${c.name}: ${c.detail}`);
}
console.log('');
console.log('  public download eligibility');
for (const a of manifestArtifacts) {
  console.log(`    ${a.publicDownloadEligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'}  ${a.filename}`);
  if (!a.publicDownloadEligible) console.log(`        unmet: ${a.unmet.join(', ')}`);
}
console.log('');
if (existsSync('release')) console.log('  release/release-manifest.json written.');
console.log('');

const failed = checks.filter((c) => c.status === FAIL);
const notRun = checks.filter((c) => c.status === NOT_RUN);
const anyEligible = manifestArtifacts.some((a) => a.publicDownloadEligible);

if (failed.length) {
  console.error(`RESULT: FAIL — ${failed.length} check(s) failed, ${notRun.length} not run.`);
  console.error('  NOT PUBLISHABLE.');
  process.exit(1);
}
if (unsigned) {
  console.log(`RESULT: PASS (structural) — ${notRun.length} signing check(s) NOT RUN.`);
  console.log('  LOCAL RELEASE-CANDIDATE / NOT FOR PUBLIC DISTRIBUTION.');
  process.exit(0);
}
if (!anyEligible) {
  console.error(`RESULT: BLOCKED_FOR_DISTRIBUTION — no artifact is publicly eligible (${notRun.length} check(s) not run).`);
  process.exit(1);
}
console.log('RESULT: PASS — signed with a Developer ID, hardened runtime on, notarized, stapled.');
