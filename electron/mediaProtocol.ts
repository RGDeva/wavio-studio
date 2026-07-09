/**
 * wavi-media:// — secure local bounce playback for Project Detail.
 *
 * Design goals (WS-005):
 *  - Never expose a generic local-file endpoint. The renderer only ever sees an
 *    opaque URL of the form  wavi-media://asset/{projectId}/{assetId}  — no
 *    filesystem path is embedded or returned.
 *  - The main process resolves {assetId} through trusted local DB state, checks
 *    it belongs to {projectId}, canonicalizes the on-disk path, and refuses
 *    anything that escapes the user's approved (watched) folder roots.
 *  - Only approved audio MIME types are served. Byte-range requests are honored
 *    for seeking (206 / 416); unknown → 404; forbidden → 403.
 *
 * The authorization + range logic is pure and fs-injectable so it is unit
 * tested under plain-Node vitest without Electron.
 */
import * as path from 'path';

export const WAVI_MEDIA_SCHEME = 'wavi-media';

/** Approved audio extensions → MIME. Anything not listed is refused (403). */
export const AUDIO_MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
};

/** Trusted local record, as returned by the DB lookup. */
export interface AssetRow {
  id: string;
  project_id: string | null;
  file_path: string;
  file_name: string;
  local_status?: string | null;
}

export type AssetLookup = (assetId: string) => AssetRow | undefined;

export interface FsLike {
  realpathSync: (p: string) => string;
  statSync: (p: string) => { size: number; isFile: () => boolean };
}

export interface AuthzOk {
  ok: true;
  status: 200;
  filePath: string; // canonicalized, real path — main-process only
  mime: string;
  size: number;
}
export interface AuthzErr {
  ok: false;
  status: 403 | 404;
  reason: string;
}
export type AuthzResult = AuthzOk | AuthzErr;

/** Opaque ids: DB ids are uuid/nanoid-like. No separators, dots, or percent-encoding. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function idIsSafe(raw: string | undefined): raw is string {
  if (!raw) return false;
  // Reject encoded traversal: a well-formed id never changes under decode.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return false;
  }
  if (decoded !== raw) return false;
  return SAFE_ID.test(raw);
}

/** True if `real` is inside (or equal to) one of the canonicalized approved roots. */
export function isWithinApprovedRoots(real: string, approvedRealRoots: string[]): boolean {
  return approvedRealRoots.some((root) => real === root || real.startsWith(root + path.sep));
}

/**
 * Full authorization pipeline. Returns a canonicalized filePath only on success.
 * Denials never reveal a path. `approvedRoots` are user-approved folder roots;
 * they are canonicalized here so symlinked roots also match honestly.
 */
export function authorizeAsset(
  projectId: string | undefined,
  assetId: string | undefined,
  lookup: AssetLookup,
  approvedRoots: string[],
  fsLike: FsLike,
): AuthzResult {
  // 1. Structural validation — blocks path traversal / encoded traversal in the id.
  if (!idIsSafe(projectId) || !idIsSafe(assetId)) {
    return { ok: false, status: 403, reason: 'invalid-id' };
  }

  // 2. Resolve through trusted local state.
  const row = lookup(assetId);
  if (!row) return { ok: false, status: 404, reason: 'unknown-asset' };

  // 3. Must belong to the requested project (blocks cross-project + stale association).
  if (!row.project_id || row.project_id !== projectId) {
    return { ok: false, status: 403, reason: 'cross-project' };
  }

  // 4. Stale / deleted record.
  if (row.local_status && row.local_status !== 'present') {
    return { ok: false, status: 404, reason: 'stale-asset' };
  }

  // 5. Approved media type (by extension on the trusted record).
  const ext = path.extname(row.file_name || row.file_path).toLowerCase();
  const mime = AUDIO_MIME[ext];
  if (!mime) return { ok: false, status: 403, reason: 'unsupported-media' };

  // 6. Canonicalize the real path (resolves symlinks) — file must exist.
  let real: string;
  try {
    real = fsLike.realpathSync(row.file_path);
  } catch {
    return { ok: false, status: 404, reason: 'missing-file' };
  }

  // 7. Canonicalize approved roots and confirm the real file stays inside one.
  //    Rejects symlink escape and any arbitrary absolute path.
  const approvedReal: string[] = [];
  for (const r of approvedRoots) {
    try {
      approvedReal.push(fsLike.realpathSync(r));
    } catch {
      /* skip roots that no longer exist */
    }
  }
  if (!isWithinApprovedRoots(real, approvedReal)) {
    return { ok: false, status: 403, reason: 'path-escape' };
  }

  // 8. Must be a regular file.
  let stat: { size: number; isFile: () => boolean };
  try {
    stat = fsLike.statSync(real);
  } catch {
    return { ok: false, status: 404, reason: 'missing-file' };
  }
  if (!stat.isFile()) return { ok: false, status: 404, reason: 'not-a-file' };

  return { ok: true, status: 200, filePath: real, mime, size: stat.size };
}

export interface Range {
  start: number;
  end: number; // inclusive
}
export type RangeParse = Range | null | { invalid: true };

/**
 * Parse a single HTTP Range header against a known size.
 *  - null header → null (serve full, 200)
 *  - satisfiable → { start, end } (206)
 *  - unsatisfiable / malformed → { invalid: true } (416)
 * Multi-range (comma) is intentionally not supported → treated as invalid.
 */
export function parseRange(header: string | null | undefined, size: number): RangeParse {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { invalid: true };
  const [, rawStart, rawEnd] = m;

  if (rawStart === '' && rawEnd === '') return { invalid: true };

  let start: number;
  let end: number;
  if (rawStart === '') {
    // suffix: last N bytes
    const n = Number(rawEnd);
    if (n <= 0) return { invalid: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
  if (start > end || start >= size || start < 0) return { invalid: true };
  if (end >= size) end = size - 1;
  return { start, end };
}

/**
 * Build the opaque media URL handed to the renderer. Contains only ids — never
 * a filesystem path. Returns null when required ids are missing.
 */
export function buildMediaUrl(projectId: string | undefined, assetId: string | undefined): string | null {
  if (!idIsSafe(projectId) || !idIsSafe(assetId)) return null;
  return `${WAVI_MEDIA_SCHEME}://asset/${projectId}/${assetId}`;
}

/** Parse a wavi-media URL into ids. Returns null on any structural problem. */
export function parseMediaUrl(rawUrl: string): { projectId: string; assetId: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== `${WAVI_MEDIA_SCHEME}:`) return null;
  if (u.hostname !== 'asset') return null;
  const parts = u.pathname.split('/').filter((s) => s.length > 0);
  if (parts.length !== 2) return null;
  const [projectId, assetId] = parts;
  if (!idIsSafe(projectId) || !idIsSafe(assetId)) return null;
  return { projectId, assetId };
}
