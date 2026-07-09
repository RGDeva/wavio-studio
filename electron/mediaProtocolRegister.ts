/**
 * Electron wiring for wavi-media://. Kept separate from mediaProtocol.ts so the
 * pure authorization/range logic stays importable under plain-Node vitest.
 *
 * - registerWaviMediaPrivileges() MUST be called at module load, before the app
 *   'ready' event (Electron requires privileged schemes to be declared early).
 * - registerWaviMediaProtocol() is called inside app.whenReady(), after the DB
 *   is initialized, and installs the request handler for dev and packaged builds.
 */
import { protocol } from 'electron';
import * as fs from 'fs';
import { Readable } from 'stream';
import type Database from 'better-sqlite3';
import {
  WAVI_MEDIA_SCHEME,
  authorizeAsset,
  parseRange,
  parseMediaUrl,
  type AssetRow,
  type FsLike,
} from './mediaProtocol';

/** Declare the scheme as privileged. Call at top-level, before app is ready. */
export function registerWaviMediaPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WAVI_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // No CORS and no CSP bypass: this is only for our own renderer's <audio>.
        corsEnabled: false,
        bypassCSP: false,
      },
    },
  ]);
}

const realFs: FsLike = {
  realpathSync: (p) => fs.realpathSync(p),
  statSync: (p) => {
    const s = fs.statSync(p);
    return { size: s.size, isFile: () => s.isFile() };
  },
};

/** Redacted structured log — ids and status only, never a filesystem path. */
type MediaLog = (event: string, data: Record<string, unknown>) => void;

export interface MediaProtocolDeps {
  db: Database.Database;
  /** Returns the user's approved (watched) folder roots. */
  getApprovedRoots: () => string[];
  log?: MediaLog;
}

export function registerWaviMediaProtocol(deps: MediaProtocolDeps): void {
  const { db, getApprovedRoots } = deps;
  const log = deps.log ?? (() => {});

  const lookup = (assetId: string): AssetRow | undefined => {
    try {
      return db
        .prepare(
          'SELECT id, project_id, file_path, file_name, local_status FROM files WHERE id = ?',
        )
        .get(assetId) as AssetRow | undefined;
    } catch {
      return undefined;
    }
  };

  protocol.handle(WAVI_MEDIA_SCHEME, async (request) => {
    const parsed = parseMediaUrl(request.url);
    if (!parsed) {
      log('media-denied', { reason: 'bad-url', status: 400 });
      return new Response(null, { status: 400 });
    }
    const { projectId, assetId } = parsed;

    const authz = authorizeAsset(projectId, assetId, lookup, getApprovedRoots(), realFs);
    if (!authz.ok) {
      log('media-denied', { projectId, assetId, status: authz.status, reason: authz.reason });
      return new Response(null, { status: authz.status });
    }

    const range = parseRange(request.headers.get('range'), authz.size);
    if (range && 'invalid' in range) {
      log('media-range-invalid', { projectId, assetId, status: 416 });
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${authz.size}`, 'Accept-Ranges': 'bytes' },
      });
    }

    const commonHeaders: Record<string, string> = {
      'Content-Type': authz.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };

    if (range) {
      const { start, end } = range;
      const length = end - start + 1;
      const stream = fs.createReadStream(authz.filePath, { start, end });
      log('media-served', { projectId, assetId, status: 206, start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          ...commonHeaders,
          'Content-Range': `bytes ${start}-${end}/${authz.size}`,
          'Content-Length': String(length),
        },
      });
    }

    const stream = fs.createReadStream(authz.filePath);
    log('media-served', { projectId, assetId, status: 200, size: authz.size });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: { ...commonHeaders, 'Content-Length': String(authz.size) },
    });
  });
}
