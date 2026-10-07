#!/usr/bin/env node
/**
 * Verify the macOS release artifacts — the artifacts, not the config.
 *
 * `verify-package.mjs` already checks what is INSIDE the bundle. This checks
 * what the bundle IS: signed by whom, hardened or not, notarized, stapled, and
 * built for the architecture its filename claims.
 *
 * The principle throughout: a check that could not be performed is never
 * counted as a pass. If `spctl` cannot be run, the result is "unknown" and the
 * run fails in distribution mode — because "we could not tell" and "it is
 * fine" are the two things a release gate must never confuse.
 *
 * Usage:
 *   node scripts/verify-release.mjs           distribution: signing+notarization REQUIRED
 *   node scripts/verify-release.mjs --local   structural only; reports signing as unverified
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import {
  parseCodesign, parseSpctl, parseStapler, summarizeVerification,
  expectedArtifacts, IDENTITY_KINDS, parseMachoArchs, machoNameFor, classifyToolFailure,
  ticketFileEvidence,
} from './macSigning.mjs';

const distribution = !process.argv.includes('--local');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const productName = pkg.build?.productName ?? pkg.name;
const version = pkg.version;

const checks = [];
const add = (name, ok, detail, kind = 'signing') => checks.push({ name, ok, detail, kind });

/** Run a tool, capturing both streams; never throws. */
function tool(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: stdout, err: '' };
  } catch (e) {
    return { ok: false, out: e.stdout?.toString() ?? '', err: e.stderr?.toString() ?? String(e.message ?? '') };
  }
}

console.log(`verify-release: ${productName} ${version} (${distribution ? 'DISTRIBUTION' : 'local'} mode)`);
console.log('');

// ── 1. Structural: every matrix cell produced a file ────────────────────────
const expected = expectedArtifacts(productName, version);
for (const e of expected) {
  const p = join('release', e.file);
  add(`artifact ${e.target}/${e.arch}`, existsSync(p), existsSync(p) ? e.file : `missing ${e.file}`, 'structural');
}

// ── 2. Structural: architectures match their build ─────────────────────────
const APPS = [
  { dir: 'release/mac-arm64', arch: 'arm64' },
  { dir: 'release/mac', arch: 'x64' },
];
// Read the Mach-O header ourselves. `lipo` is an Xcode shim and fails
// outright on a machine with a broken Xcode — which is this one — so relying
// on it would make "wrong architecture" indistinguishable from "my toolchain
// is broken".
const archOf = (f) => {
  try { return parseMachoArchs(readFileSync(f)).join(', ') || null; } catch { return null; }
};
for (const { dir, arch } of APPS) {
  const app = `${dir}/${productName}.app`;
  if (!existsSync(app)) { add(`app ${arch}`, false, `missing ${app}`, 'structural'); continue; }
  const want = machoNameFor(arch);

  const bin = `${app}/Contents/MacOS/${productName}`;
  const binArch = archOf(bin);
  add(`binary arch ${arch}`, binArch === want, binArch ? `${binArch} (expected ${want})` : 'could not read', 'structural');

  // The cross-arch trap: a native module built for the wrong architecture
  // produces an app that launches and then dies the moment it touches the
  // database. Nothing earlier in the build would say so.
  const nodeMod = `${app}/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`;
  if (existsSync(nodeMod)) {
    const modArch = archOf(nodeMod);
    add(`better_sqlite3 arch ${arch}`, modArch === want, modArch ? `${modArch} (expected ${want})` : 'could not read', 'structural');
  } else {
    add(`better_sqlite3 arch ${arch}`, false, 'native module not unpacked — the app will fail on first database access', 'structural');
  }
}

// ── 3. Signing, hardened runtime, notarization, stapling ───────────────────
for (const { dir, arch } of APPS) {
  const app = `${dir}/${productName}.app`;
  if (!existsSync(app)) continue;

  // Deep + strict: a signature on the outer bundle says nothing about the
  // nested helpers and native modules, and notarization checks all of them.
  const verify = tool('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const verifyTool = classifyToolFailure(verify.err);
  add(`codesign --verify ${arch}`, verify.ok,
    !verifyTool.usable ? `CANNOT VERIFY — ${verifyTool.reason}`
      : verify.ok ? 'valid on disk'
      : (verify.err.trim().split('\n')[0] || 'failed'));

  const show = tool('codesign', ['-dvvv', app]);
  const cs = parseCodesign(show.err || show.out);
  add(`Developer ID ${arch}`,
    cs.leafKind === IDENTITY_KINDS.DEVELOPER_ID,
    cs.unsigned ? 'not signed at all'
      : cs.adhoc ? 'ad-hoc signature (not a real identity)'
      : cs.leaf ? `signed by: ${cs.leaf} [${cs.leafKind}]`
      : 'no signing authority found');
  add(`hardened runtime ${arch}`, cs.hardenedRuntime,
    cs.hardenedRuntime ? 'runtime flag set in CodeDirectory' : 'runtime flag NOT set in the signed binary');

  const assess = tool('spctl', ['--assess', '--type', 'execute', '-vv', app]);
  const assessTool = classifyToolFailure(assess.err);
  const sp = parseSpctl((assess.out || '') + (assess.err || ''));
  add(`Gatekeeper ${arch}`, sp.notarizedDeveloperId,
    !assessTool.usable ? `CANNOT VERIFY — ${assessTool.reason}`
      : sp.anomaly ? sp.anomaly
      : sp.rejected ? `rejected (source=${sp.source ?? 'unknown'})`
      : sp.accepted ? `accepted but source=${sp.source ?? 'unknown'} — only "Notarized Developer ID" means notarized`
      : 'spctl gave no verdict');

  // Stapling. When `stapler` itself cannot run — true on this machine — fall
  // back to looking for the ticket file, clearly labelled as a heuristic. An
  // unverifiable check is never reported as a pass.
  const staple = tool('xcrun', ['stapler', 'validate', app]);
  const st = parseStapler((staple.out || '') + (staple.err || ''));
  if (st.usable === false) {
    let entries = [];
    try { entries = readdirSync(`${app}/Contents`); } catch { /* unreadable */ }
    const ev = ticketFileEvidence(entries);
    add(`stapled ticket ${arch}`, false,
      `${st.reason}; ticket file ${ev.present ? 'IS' : 'is NOT'} present (heuristic only, not proof)`);
  } else {
    add(`stapled ticket ${arch}`, st.stapled, st.stapled ? 'ticket present' : st.reason);
  }
}

// Each DMG needs its own ticket: stapling the .app does not staple the disk
// image the user actually downloads.
for (const e of expected.filter((x) => x.target === 'dmg')) {
  const p = join('release', e.file);
  if (!existsSync(p)) continue;
  const staple = tool('xcrun', ['stapler', 'validate', p]);
  const st = parseStapler((staple.out || '') + (staple.err || ''));
  // No heuristic exists for a disk image, so an unusable stapler means
  // genuinely unknown here.
  add(`stapled ${e.file}`, st.stapled, st.stapled ? 'ticket present' : st.reason);
}

// ── 4. Checksums, for whatever is actually there ───────────────────────────
const manifest = [];
if (existsSync('release')) {
  for (const f of readdirSync('release').filter((f) => /\.(dmg|zip)$/.test(f)).sort()) {
    const buf = readFileSync(join('release', f));
    manifest.push({ file: f, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
const structural = checks.filter((c) => c.kind === 'structural');
const signing = checks.filter((c) => c.kind === 'signing');
const print = (label, list) => {
  console.log(label);
  for (const c of list) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  console.log('');
};
print('structural', structural);
print('signing / notarization', signing);

if (manifest.length) {
  console.log('artifacts');
  for (const m of manifest) console.log(`  ${(m.bytes / 1048576).toFixed(0)} MB  ${m.sha256}  ${m.file}`);
  console.log('');
}

const verdict = summarizeVerification(checks, { distribution });
if (verdict.warnings.length) {
  console.log('NOT VERIFIED (local mode — these would fail a distribution build)');
  for (const w of verdict.warnings) console.log(`  · ${w}`);
  console.log('');
}
if (!verdict.ok) {
  console.error(`RESULT: FAIL — ${verdict.claim}`);
  for (const f of verdict.failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`RESULT: PASS — ${verdict.claim}`);
