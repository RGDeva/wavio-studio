/**
 * wavi-media:// security + protocol tests (WS-005).
 *
 * Exercises the pure authorization/range/url logic against a real temp
 * filesystem (so symlink-escape and realpath canonicalization are genuinely
 * tested) with an in-memory asset lookup standing in for the local DB.
 *
 * Requires the Node-ABI test runtime (see native-sqlite harness) only for the
 * shared vitest environment — these tests themselves use fs, not sqlite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  authorizeAsset,
  parseRange,
  parseMediaUrl,
  buildMediaUrl,
  isWithinApprovedRoots,
  type AssetRow,
  type FsLike,
} from './mediaProtocol';

const realFs: FsLike = {
  realpathSync: (p) => fs.realpathSync(p),
  statSync: (p) => {
    const s = fs.statSync(p);
    return { size: s.size, isFile: () => s.isFile() };
  },
};

const PROJECT = 'proj-A';
const OTHER_PROJECT = 'proj-B';

let root: string; // approved watched-folder root
let outside: string; // NOT an approved root
let approvedRoots: string[];
let rows: Record<string, AssetRow>;
const lookup = (id: string): AssetRow | undefined => rows[id];

function writeAudio(dir: string, name: string, bytes = 2048): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
}

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wavi-media-test-'));
  fs.mkdirSync(path.join(base, 'Music'), { recursive: true });
  // realpath so macOS /var → /private/var canonicalization matches at check time.
  root = fs.realpathSync(path.join(base, 'Music'));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wavi-media-outside-')));
  approvedRoots = [root];

  const bounce = writeAudio(root, 'bounce.wav', 4096);
  const otherProjBounce = writeAudio(root, 'other.wav');
  const doc = writeAudio(root, 'notes.txt'); // wrong type, but present + in root
  const secret = writeAudio(outside, 'secret.wav'); // real audio, but outside roots + not indexed

  // A symlink inside the approved root that escapes to an outside file.
  const escapeLink = path.join(root, 'escape.wav');
  fs.symlinkSync(secret, escapeLink);

  rows = {
    'asset-bounce': { id: 'asset-bounce', project_id: PROJECT, file_path: bounce, file_name: 'bounce.wav', local_status: 'present' },
    'asset-other': { id: 'asset-other', project_id: OTHER_PROJECT, file_path: otherProjBounce, file_name: 'other.wav', local_status: 'present' },
    'asset-doc': { id: 'asset-doc', project_id: PROJECT, file_path: doc, file_name: 'notes.txt', local_status: 'present' },
    'asset-deleted': { id: 'asset-deleted', project_id: PROJECT, file_path: bounce, file_name: 'bounce.wav', local_status: 'missing' },
    'asset-symlink': { id: 'asset-symlink', project_id: PROJECT, file_path: escapeLink, file_name: 'escape.wav', local_status: 'present' },
    'asset-arbitrary': { id: 'asset-arbitrary', project_id: PROJECT, file_path: secret, file_name: 'secret.wav', local_status: 'present' },
    // Points at PROJECT's file but the record claims a foreign project (stale association).
    'asset-stale-assoc': { id: 'asset-stale-assoc', project_id: OTHER_PROJECT, file_path: bounce, file_name: 'bounce.wav', local_status: 'present' },
  };
});

afterAll(() => {
  try { fs.rmSync(path.dirname(root), { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('wavi-media authorization', () => {
  // 1
  it('valid indexed bounce is authorized with mime + size', () => {
    const r = authorizeAsset(PROJECT, 'asset-bounce', lookup, approvedRoots, realFs);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mime).toBe('audio/wav');
      expect(r.size).toBe(4096);
      expect(r.filePath).toContain('bounce.wav');
    }
  });

  // 4
  it('unknown asset id → 404', () => {
    const r = authorizeAsset(PROJECT, 'asset-does-not-exist', lookup, approvedRoots, realFs);
    expect(r).toMatchObject({ ok: false, status: 404, reason: 'unknown-asset' });
  });

  // 5
  it('asset belonging to another project → 403', () => {
    const r = authorizeAsset(PROJECT, 'asset-other', lookup, approvedRoots, realFs);
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'cross-project' });
  });

  // 6
  it('path traversal in id → 403', () => {
    const r = authorizeAsset(PROJECT, '../../etc/passwd', lookup, approvedRoots, realFs);
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'invalid-id' });
  });

  // 7
  it('encoded traversal in id → 403', () => {
    const r = authorizeAsset(PROJECT, '..%2f..%2fsecret', lookup, approvedRoots, realFs);
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'invalid-id' });
    const r2 = authorizeAsset('%2e%2e', 'asset-bounce', lookup, approvedRoots, realFs);
    expect(r2).toMatchObject({ ok: false, status: 403, reason: 'invalid-id' });
  });

  // 8
  it('symlink escaping the approved root → 403', () => {
    const r = authorizeAsset(PROJECT, 'asset-symlink', lookup, approvedRoots, realFs);
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'path-escape' });
  });

  // 9
  it('arbitrary absolute path outside approved roots → 403', () => {
    const r = authorizeAsset(PROJECT, 'asset-arbitrary', lookup, approvedRoots, realFs);
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'path-escape' });
  });

  // 10
  it('unsupported extension / MIME → 403', () => {
    const r = authorizeAsset(PROJECT, 'asset-doc', lookup, approvedRoots, realFs);
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'unsupported-media' });
  });

  // 11
  it('deleted / missing asset record → 404', () => {
    const r = authorizeAsset(PROJECT, 'asset-deleted', lookup, approvedRoots, realFs);
    expect(r).toMatchObject({ ok: false, status: 404, reason: 'stale-asset' });
  });

  // 12
  it('stale project association → 403', () => {
    // Requesting the stale record under PROJECT: its project_id is now OTHER.
    const r = authorizeAsset(PROJECT, 'asset-stale-assoc', lookup, approvedRoots, realFs);
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'cross-project' });
  });

  it('missing file on disk (record present but file gone) → 404', () => {
    rows['asset-ghost'] = { id: 'asset-ghost', project_id: PROJECT, file_path: path.join(root, 'ghost.wav'), file_name: 'ghost.wav', local_status: 'present' };
    const r = authorizeAsset(PROJECT, 'asset-ghost', lookup, approvedRoots, realFs);
    expect(r).toMatchObject({ ok: false, status: 404 });
    delete rows['asset-ghost'];
  });
});

describe('wavi-media range parsing', () => {
  // 2 + 3
  it('valid range → satisfiable window (206 input)', () => {
    expect(parseRange('bytes=0-1023', 4096)).toEqual({ start: 0, end: 1023 });
    expect(parseRange('bytes=1024-', 4096)).toEqual({ start: 1024, end: 4095 }); // seek forward
    expect(parseRange('bytes=-512', 4096)).toEqual({ start: 3584, end: 4095 }); // suffix
  });

  it('no range header → null (full 200)', () => {
    expect(parseRange(null, 4096)).toBeNull();
    expect(parseRange(undefined, 4096)).toBeNull();
  });

  // 13
  it('invalid / unsatisfiable range → 416', () => {
    expect(parseRange('bytes=5000-6000', 4096)).toEqual({ invalid: true }); // start past EOF
    expect(parseRange('bytes=100-50', 4096)).toEqual({ invalid: true }); // start > end
    expect(parseRange('bytes=abc', 4096)).toEqual({ invalid: true }); // malformed
    expect(parseRange('bytes=0-100, 200-300', 4096)).toEqual({ invalid: true }); // multi-range
  });

  it('clamps end past EOF to last byte', () => {
    expect(parseRange('bytes=4000-99999', 4096)).toEqual({ start: 4000, end: 4095 });
  });
});

describe('wavi-media opaque URLs (renderer never receives a raw path)', () => {
  // 14
  it('builds an id-only opaque URL with no filesystem path', () => {
    const url = buildMediaUrl(PROJECT, 'asset-bounce');
    expect(url).toBe('wavi-media://asset/proj-A/asset-bounce');
    expect(url).not.toMatch(/\.wav|\/Users|\/tmp|\/var|\/private/);
  });

  it('round-trips build → parse', () => {
    const url = buildMediaUrl(PROJECT, 'asset-bounce')!;
    expect(parseMediaUrl(url)).toEqual({ projectId: PROJECT, assetId: 'asset-bounce' });
  });

  it('rejects a URL embedding a raw local path', () => {
    expect(parseMediaUrl('wavi-media:///Users/rishig/Music/song.wav')).toBeNull();
    expect(parseMediaUrl('wavi-media://asset/proj/..%2f..%2fetc')).toBeNull();
    expect(parseMediaUrl('file:///Users/rishig/Music/song.wav')).toBeNull();
  });

  it('refuses to build a URL from unsafe ids', () => {
    expect(buildMediaUrl(PROJECT, '../secret')).toBeNull();
    expect(buildMediaUrl('', 'asset-bounce')).toBeNull();
  });
});

describe('approved-root containment helper', () => {
  it('accepts equal path and descendants; rejects prefix-siblings', () => {
    expect(isWithinApprovedRoots('/a/b', ['/a/b'])).toBe(true);
    expect(isWithinApprovedRoots('/a/b/c.wav', ['/a/b'])).toBe(true);
    expect(isWithinApprovedRoots('/a/bcd/c.wav', ['/a/b'])).toBe(false); // not /a/b + sep
    expect(isWithinApprovedRoots('/x/y.wav', ['/a/b'])).toBe(false);
  });
});
