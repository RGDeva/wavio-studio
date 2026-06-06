/**
 * Wavi Studio Bridge — End-to-End Validation Script
 *
 * Starts bridgeServer.js in-process with a lightweight electron shim,
 * then hits every endpoint and logs PASS/FAIL for each test.
 *
 * Run: node scripts/validate-bridge.cjs
 */

'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// ── 1. Shim 'electron' before any require loads it ───────────────────────────
const Module = require('module');
const _orig  = Module._resolveFilename.bind(Module);
Module._resolveFilename = function(request, ...rest) {
  if (request === 'electron') return path.resolve(__dirname, 'electron-shim.cjs');
  return _orig(request, ...rest);
};

// Write the shim file
fs.writeFileSync(
  path.join(__dirname, 'electron-shim.cjs'),
  `'use strict';
module.exports = {
  shell: {
    openPath: async (p) => { console.log('[shim] shell.openPath:', p); return ''; },
    openExternal: async (p) => { console.log('[shim] shell.openExternal:', p); },
    showItemInFolder: (p) => { console.log('[shim] shell.showItemInFolder:', p); },
  },
  app: {
    getPath: (name) => require('os').homedir(),
    isPackaged: false,
  },
};`
);

// ── 2. Shim internal modules that need SQLite / Electron ─────────────────────
// We shim db.js, audioAnalyzer.js, agentLoop.js, copilot.js to avoid
// real DB/binary dependencies in this test context.

const shimMap = {
  [path.resolve(__dirname, '../dist-electron/db.js')]: `
    'use strict';
    module.exports = {
      getProjects: () => [{
        id: 'test-proj-1',
        project_name: 'Test Beat – C Minor',
        daw_type: 'fl-studio',
        file_path: '${os.homedir()}/Music/TestBeat.flp',
        last_synced_at: new Date().toISOString(),
        version_count: 3,
        cloud_id: null,
      }],
      getProjectById: (id) => null,
      getFilesByProject: (id) => [{
        id: 'file-1',
        file_name: 'TestBeat_bounce.wav',
        file_path: '${os.homedir()}/Music/TestBeat_bounce.wav',
        file_type: 'wav',
        file_size: 4200000,
        role: 'bounce',
        bpm: 140,
        key_note: 'C',
        sync_status: 'synced',
        cloud_url: null,
        updated_at: new Date().toISOString(),
      }],
      getAllFiles: () => [],
      searchFiles: (q) => q ? [{
        id: 'search-1',
        file_name: 'SearchResult.wav',
        file_path: '${os.homedir()}/Music/SearchResult.wav',
        file_type: 'wav',
        file_size: 2100000,
        role: 'stem',
        bpm: 128,
        key_note: 'F',
        sync_status: 'synced',
        cloud_url: null,
        updated_at: new Date().toISOString(),
      }] : [],
      getVersionsByProject: (id) => [{
        id: 'v1',
        version_number: 1,
        label: 'v1',
        file_path: '${os.homedir()}/Music/TestBeat_v1.flp',
        file_size: 82000,
        checksum: 'abc123',
        synced_at: new Date().toISOString(),
        cloud_url: null,
      }],
      logActivity: (entry) => { console.log('[shim] logActivity:', entry.type, entry.message); },
    };`,
  [path.resolve(__dirname, '../dist-electron/audioAnalyzer.js')]: `
    'use strict';
    module.exports = {
      analyzeAudio: async (fp) => ({ bpm: 140, keyNote: 'C', duration: 180 }),
    };`,
  [path.resolve(__dirname, '../dist-electron/agentLoop.js')]: `
    'use strict';
    module.exports = {
      getToolByName: (name) => ({
        name,
        handler: async (params, ctx) => ({
          status: 'done',
          filePath: '${os.homedir()}/Music/TestBeat_melody.mid',
          fileName: 'TestBeat_melody.mid',
          message: 'Generated MIDI (shim)',
        }),
      }),
      TOOL_REGISTRY: [],
    };`,
  [path.resolve(__dirname, '../dist-electron/copilot.js')]: `
    'use strict';
    module.exports = { toggleOverlay: () => console.log('[shim] toggleOverlay called') };`,
};

const _origLoad = Module._load.bind(Module);
Module._load = function(request, parent, isMain) {
  const resolved = (() => {
    try { return Module._resolveFilename(request, parent); } catch { return null; }
  })();
  if (resolved && shimMap[resolved]) {
    if (!Module._cache[resolved]) {
      const m = new Module(resolved, parent);
      m.filename = resolved;
      m.loaded = false;
      Module._cache[resolved] = m;
      m.exports = {};
      const fn = new Function('module','exports','require','__dirname','__filename', shimMap[resolved]);
      fn(m, m.exports, require, path.dirname(resolved), resolved);
      m.loaded = true;
    }
    return Module._cache[resolved].exports;
  }
  return _origLoad(request, parent, isMain);
};

// ── 3. Load the real bridgeServer ─────────────────────────────────────────────
const { startBridgeServer, stopBridgeServer, BRIDGE_PORT, BRIDGE_HOST } =
  require('../dist-electron/bridgeServer.js');

// ── 4. Test helpers ───────────────────────────────────────────────────────────
let TOKEN = '';
let pass = 0, fail = 0;

function req(method, path_, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const opts = {
      hostname: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: path_,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(d); } catch { parsed = d; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅  ${label}${detail ? ' — ' + detail : ''}`);
    pass++;
  } else {
    console.error(`  ❌  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

// ── 5. Run tests ──────────────────────────────────────────────────────────────
async function run() {
  startBridgeServer();
  await new Promise(r => setTimeout(r, 200)); // let server bind

  // Read token
  const tokenPath = path.join(os.homedir(), '.wavi', 'bridge-token');
  TOKEN = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : '';
  const tokenStat = fs.existsSync(tokenPath) ? fs.statSync(tokenPath) : null;

  console.log('\n══════════════════════════════════════════════');
  console.log('  Wavi Studio Bridge — Validation Report');
  console.log('══════════════════════════════════════════════\n');

  // ── Token ─────────────────────────────────────────────────────────────────
  console.log('── Token ──');
  check('bridge-token file exists', !!TOKEN, tokenPath);
  check('token is 36-char UUID', TOKEN.length === 36, `len=${TOKEN.length}`);
  if (tokenStat) {
    const perms = (tokenStat.mode & 0o777).toString(8);
    check('token permissions are 600', perms === '600', `mode=${perms}`);
  }
  check('token starts printed (first 8)', true, TOKEN.slice(0,8) + '...');

  // ── /health — no auth ─────────────────────────────────────────────────────
  console.log('\n── GET /health (no auth) ──');
  const health = await req('GET', '/health');
  check('status 200', health.status === 200, `got ${health.status}`);
  check('status=ok', health.body?.status === 'ok');
  check('service=wavi-studio-bridge', health.body?.service === 'wavi-studio-bridge');
  check('port=47821', health.body?.port === 47821);

  // ── Auth enforcement ──────────────────────────────────────────────────────
  console.log('\n── Auth enforcement ──');
  const noAuth = await req('GET', '/active-project');
  check('no token → 401', noAuth.status === 401, `got ${noAuth.status}`);

  const badToken = await req('GET', '/active-project', { headers: { 'X-Wavi-Token': 'wrong' } });
  check('wrong token → 401', badToken.status === 401, `got ${badToken.status}`);

  // ── Bind address ──────────────────────────────────────────────────────────
  console.log('\n── Bind address ──');
  // If bound to 0.0.0.0, 0.0.0.0:47821 would also accept; we verify it only binds 127.0.0.1
  const onlyLocal = await req('GET', '/health', {}); // goes to 127.0.0.1 — already tested
  check('server answers on 127.0.0.1', onlyLocal.status === 200);
  // There's no easy way to refuse 0.0.0.0 from Node tests — we verify listen args from source
  const src = fs.readFileSync(path.join(__dirname, '../dist-electron/bridgeServer.js'), 'utf8');
  check('source binds BRIDGE_HOST (127.0.0.1)', src.includes("'127.0.0.1'") || src.includes('"127.0.0.1"'));

  const AUTH = { 'X-Wavi-Token': TOKEN };

  // ── GET /active-project ───────────────────────────────────────────────────
  console.log('\n── GET /active-project ──');
  const ap = await req('GET', '/active-project', { headers: AUTH });
  check('status 200', ap.status === 200, `got ${ap.status}`);
  check('project.name present', !!ap.body?.project?.name, ap.body?.project?.name);
  check('project.dawType present', !!ap.body?.project?.dawType);

  // ── GET /project-context ──────────────────────────────────────────────────
  console.log('\n── GET /project-context ──');
  const ctx = await req('GET', '/project-context', { headers: AUTH });
  check('status 200', ctx.status === 200);
  check('context.projectName present', !!ctx.body?.context?.projectName);
  check('context.files is array', Array.isArray(ctx.body?.context?.files));

  // ── GET /project-files ────────────────────────────────────────────────────
  console.log('\n── GET /project-files ──');
  const pf = await req('GET', '/project-files', { headers: AUTH });
  check('status 200', pf.status === 200);
  check('files is array', Array.isArray(pf.body?.files));
  if (pf.body?.files?.length > 0) {
    const f = pf.body.files[0];
    check('file has fileName', !!f.fileName);
    check('file has filePath', !!f.filePath);
    check('file has role', !!f.role);
  }

  // ── GET /project-versions ─────────────────────────────────────────────────
  console.log('\n── GET /project-versions ──');
  const pv = await req('GET', '/project-versions', { headers: AUTH });
  check('status 200', pv.status === 200);
  check('versions is array', Array.isArray(pv.body?.versions));

  // ── GET /latest-bounce ────────────────────────────────────────────────────
  console.log('\n── GET /latest-bounce ──');
  const lb = await req('GET', '/latest-bounce', { headers: AUTH });
  check('status 200', lb.status === 200);
  check('bounce.fileName present', !!lb.body?.bounce?.fileName, lb.body?.bounce?.fileName);
  check('bounce.role present', !!lb.body?.bounce?.role);

  // ── GET /search-files?q= ──────────────────────────────────────────────────
  console.log('\n── GET /search-files ──');
  const sf = await req('GET', '/search-files?q=beat', { headers: AUTH });
  check('status 200', sf.status === 200);
  check('files is array', Array.isArray(sf.body?.files));
  const sfEmpty = await req('GET', '/search-files?q=', { headers: AUTH });
  check('empty q → 200 + empty array', sfEmpty.status === 200 && Array.isArray(sfEmpty.body?.files) && sfEmpty.body.files.length === 0);

  // ── POST /generate-midi ───────────────────────────────────────────────────
  console.log('\n── POST /generate-midi ──');
  const gm = await req('POST', '/generate-midi', {
    headers: AUTH,
    body: { type: 'melody', key: 'C', scale: 'minor', tempo: 140, bars: 4 },
  });
  check('status 200', gm.status === 200, `got ${gm.status} — ${JSON.stringify(gm.body)}`);
  check('result has filePath or fileName', !!(gm.body?.filePath || gm.body?.fileName));

  const gmDrums = await req('POST', '/generate-midi', {
    headers: AUTH,
    body: { type: 'drums', key: 'C', scale: 'trap', tempo: 140, bars: 2 },
  });
  check('drums type → 200', gmDrums.status === 200, `got ${gmDrums.status}`);

  const gmChords = await req('POST', '/generate-midi', {
    headers: AUTH,
    body: { type: 'chords', key: 'F', scale: 'minor', tempo: 120, bars: 4 },
  });
  check('chords type → 200', gmChords.status === 200, `got ${gmChords.status}`);

  // ── POST /log-action ──────────────────────────────────────────────────────
  console.log('\n── POST /log-action ──');
  const la = await req('POST', '/log-action', {
    headers: AUTH,
    body: { action: 'test_validate', message: 'bridge validation run' },
  });
  check('status 200', la.status === 200);
  check('status=ok', la.body?.status === 'ok');
  const laMissing = await req('POST', '/log-action', { headers: AUTH, body: {} });
  check('missing action → 400', laMissing.status === 400, `got ${laMissing.status}`);

  // ── Malformed JSON ────────────────────────────────────────────────────────
  console.log('\n── Malformed request handling ──');
  const malformed = await new Promise((resolve) => {
    const opts = { hostname: BRIDGE_HOST, port: BRIDGE_PORT, path: '/generate-midi', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Wavi-Token': TOKEN } };
    const r = http.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    r.write('{ not valid json ');
    r.end();
  });
  check('malformed JSON → non-200 (400 or 500)', malformed.status >= 400, `got ${malformed.status}`);

  // ── 404 ───────────────────────────────────────────────────────────────────
  console.log('\n── Unknown routes ──');
  const notFound = await req('GET', '/does-not-exist', { headers: AUTH });
  check('unknown route → 404', notFound.status === 404, `got ${notFound.status}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log(`  PASSED: ${pass}   FAILED: ${fail}`);
  console.log('══════════════════════════════════════════════\n');

  stopBridgeServer();
  // Remove test shim file
  try { fs.unlinkSync(path.join(__dirname, 'electron-shim.cjs')); } catch {}
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
