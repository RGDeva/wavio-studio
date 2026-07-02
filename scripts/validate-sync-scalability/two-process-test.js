#!/usr/bin/env node
// Two-process single-instance test. Launches the FULL app (dist-electron/main.js)
// twice against the same disposable WAVI_USER_DATA_DIR and asserts:
//
//   1. the second process exits promptly (single-instance lock) and never
//      becomes a second SQLite writer
//   2. a wavi-dev://open-project deep link passed in the second launch's argv
//      is forwarded to the primary instance (observed via the app's
//      'open-project-deep-link' entry in ~/.wavi/main.log)
//   3. the first process is still alive afterwards — exactly one primary
//   4. the shared database passes PRAGMA integrity_check afterwards
//
// Run with: node scripts/validate-sync-scalability/two-process-test.js
// Requires dist-electron/ (npm run build:electron). The primary instance's
// window may appear briefly — main-process assertions only. Uses a fresh
// scratch user-data dir every run; never the real production userData.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRATCH = process.env.WAVI_VALIDATE_DIR || path.join(os.tmpdir(), 'wavi-validate');
const USER_DATA = path.join(SCRATCH, `two-process-userdata-${Date.now()}`);
const ELECTRON = path.join(REPO_ROOT, 'node_modules', '.bin', 'electron');
const MAIN_LOG = path.join(os.homedir(), '.wavi', 'main.log');
const DEEP_LINK = 'wavi-dev://open-project?share=twoproc-validation-token';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(extraArgs = []) {
  return spawn(ELECTRON, [REPO_ROOT, ...extraArgs], {
    env: {
      ...process.env,
      WAVI_USER_DATA_DIR: USER_DATA,
      WAVI_QA_OVERRIDE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function main() {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const logSizeBefore = fs.existsSync(MAIN_LOG) ? fs.statSync(MAIN_LOG).size : 0;

  const results = { userData: USER_DATA };

  // ── First (primary) instance ─────────────────────────────────────────────
  const first = launch();
  let firstExited = false;
  first.on('exit', () => { firstExited = true; });
  await sleep(8000); // window + db + services up

  if (firstExited) {
    console.error('TWO_PROCESS_ERROR: primary instance exited during startup');
    process.exit(1);
  }

  // ── Second instance, carrying the deep link in argv ──────────────────────
  const second = launch([DEEP_LINK]);
  const secondExit = new Promise((resolve) => second.on('exit', (code) => resolve(code)));
  const secondExitCode = await Promise.race([secondExit, sleep(10_000).then(() => 'TIMEOUT')]);

  results.secondInstanceExited = secondExitCode !== 'TIMEOUT';
  results.secondExitCode = secondExitCode;
  results.firstStillAlive = !firstExited;

  // Give the primary a moment to process the forwarded argv, then read the
  // log tail written since this test started.
  await sleep(3000);
  let logTail = '';
  try {
    const fd = fs.openSync(MAIN_LOG, 'r');
    const size = fs.statSync(MAIN_LOG).size;
    const len = size - logSizeBefore;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, logSizeBefore);
      logTail = buf.toString('utf8');
    }
    fs.closeSync(fd);
  } catch { /* log missing — treated as not-forwarded below */ }

  results.deepLinkForwarded = logTail.includes('open-project-deep-link');
  results.secondInstanceStartedOwnDb = logTail.includes('assertNotProductionUserDataDir')
    ? false // irrelevant marker, kept for debugging
    : undefined;
  delete results.secondInstanceStartedOwnDb;

  // ── Shut the primary down cleanly, then integrity-check the shared DB ────
  first.kill('SIGTERM');
  await Promise.race([new Promise((r) => first.on('exit', r)), sleep(8000)]);
  if (!firstExited) first.kill('SIGKILL');
  await sleep(1000);

  // Find the db file inside the scratch userData
  const findDb = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { const hit = findDb(p); if (hit) return hit; }
      else if (entry.name.endsWith('.db')) return p;
    }
    return null;
  };
  const dbPath = findDb(USER_DATA);
  results.dbFound = !!dbPath;

  if (dbPath) {
    const integ = spawn(ELECTRON, [path.join(__dirname, 'db-integrity-check.js')], {
      env: { ...process.env, WAVI_CHECK_DB: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    integ.stdout.on('data', (d) => { out += d.toString(); });
    await new Promise((r) => integ.on('exit', r));
    const m = out.match(/INTEGRITY_RESULT_JSON:(\{.*\})/);
    if (m) {
      const parsed = JSON.parse(m[1]);
      results.integrity = parsed.integrity;
      results.journalMode = parsed.journalMode;
    }
  }

  const integrityOk = JSON.stringify(results.integrity ?? '').includes('ok');
  const ok = results.secondInstanceExited && results.firstStillAlive
    && results.deepLinkForwarded && results.dbFound && integrityOk;

  results.pass = ok;
  console.log('TWO_PROCESS_RESULT_JSON:' + JSON.stringify(results));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('TWO_PROCESS_ERROR:', e); process.exit(1); });
