/**
 * Real Electron end-to-end for wavi-media:// — boots Electron, registers the
 * actual protocol handler (protocol.handle + fs streaming), and issues real
 * net.fetch requests to prove status codes, Content-Range, byte-range bodies,
 * and denials over the wire. Complements the pure unit tests.
 *
 * Run: npx electron scripts/e2e-media-protocol.cjs   (exits non-zero on failure)
 */
const { app, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  registerWaviMediaPrivileges,
  registerWaviMediaProtocol,
} = require('../dist-electron/mediaProtocolRegister.js');

registerWaviMediaPrivileges(); // must precede ready

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wavi-e2e-'));
const root = fs.realpathSync(base);
const bouncePath = path.join(root, 'bounce.wav');
fs.writeFileSync(bouncePath, Buffer.alloc(4096, 9));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wavi-e2e-out-')));
const secret = path.join(outside, 'secret.wav');
fs.writeFileSync(secret, Buffer.alloc(1024, 1));

const rows = {
  'a1': { id: 'a1', project_id: 'p1', file_path: bouncePath, file_name: 'bounce.wav', local_status: 'present' },
  'a2': { id: 'a2', project_id: 'p2', file_path: bouncePath, file_name: 'bounce.wav', local_status: 'present' },
  'a3': { id: 'a3', project_id: 'p1', file_path: secret, file_name: 'secret.wav', local_status: 'present' },
};
// Minimal db stub matching db.prepare(sql).get(id).
const db = { prepare: () => ({ get: (id) => rows[id] }) };

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

app.whenReady().then(async () => {
  registerWaviMediaProtocol({ db, getApprovedRoots: () => [root] });

  // 1. valid full load → 200 + full length
  let r = await net.fetch('wavi-media://asset/p1/a1');
  const body = Buffer.from(await r.arrayBuffer());
  check('valid bounce → 200', r.status === 200, `status=${r.status}`);
  check('full content-length 4096', body.length === 4096, `bytes=${body.length}`);
  check('content-type audio/wav', r.headers.get('content-type') === 'audio/wav');

  // 2/3. range request → 206 + Content-Range + exact window (seeking)
  r = await net.fetch('wavi-media://asset/p1/a1', { headers: { Range: 'bytes=100-199' } });
  const part = Buffer.from(await r.arrayBuffer());
  check('range → 206', r.status === 206, `status=${r.status}`);
  check('content-range header', r.headers.get('content-range') === 'bytes 100-199/4096', r.headers.get('content-range') || '');
  check('range body is 100 bytes (seek window)', part.length === 100, `bytes=${part.length}`);

  // 13. invalid range → 416
  r = await net.fetch('wavi-media://asset/p1/a1', { headers: { Range: 'bytes=99999-100000' } });
  check('unsatisfiable range → 416', r.status === 416, `status=${r.status}`);

  // 4. unknown → 404
  r = await net.fetch('wavi-media://asset/p1/nope');
  check('unknown asset → 404', r.status === 404, `status=${r.status}`);

  // 5. cross-project → 403
  r = await net.fetch('wavi-media://asset/p1/a2');
  check('cross-project → 403', r.status === 403, `status=${r.status}`);

  // 9. arbitrary/outside-root path → 403
  r = await net.fetch('wavi-media://asset/p1/a3');
  check('outside approved roots → 403', r.status === 403, `status=${r.status}`);

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length === 0 ? 0 : 1);
}).catch((e) => { console.error(e); app.exit(2); });
