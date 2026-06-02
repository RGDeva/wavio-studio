/**
 * Wavi Studio Local Bridge Server
 *
 * Exposes a lightweight HTTP API on 127.0.0.1:47821 so the
 * Wavi Agent (native macOS Swift companion app)
 * can read project context, trigger tool execution, and log actions
 * without having direct filesystem access.
 *
 * Security:
 *   - Binds to 127.0.0.1 only (never 0.0.0.0)
 *   - Every request must include X-Wavi-Token matching ~/.wavi/bridge-token
 *   - Token is a random UUID written at startup with chmod 600
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { shell } from 'electron';
import {
  getProjects,
  getProjectById,
  getFilesByProject,
  getAllFiles,
  searchFiles,
  getVersionsByProject,
  logActivity,
  getPendingAssociations,
  resolveAssociationQueue,
  confirmAssociation,
  undoAssociation,
} from './db';
import { classifyFile as classifyFileV1 } from './projectAssociation/fileClassifier';
import { analyzeAudio } from './audioAnalyzer';
import { getToolByName } from './agentLoop';
import type { ProjectContext } from './copilotTypes';

// ── Constants ─────────────────────────────────────────────────────────────────

export const BRIDGE_PORT = 47821;
export const BRIDGE_HOST = '127.0.0.1';
const TOKEN_DIR  = path.join(os.homedir(), '.wavi');
const TOKEN_PATH = path.join(TOKEN_DIR, 'bridge-token');

let _bridgeToken = '';
let _server: http.Server | null = null;

// ── Token management ──────────────────────────────────────────────────────────

function ensureToken(): string {
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    // If file exists and is valid, reuse it
    if (fs.existsSync(TOKEN_PATH)) {
      const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
      if (existing.length === 36) return existing; // UUID length
    }
    // Generate fresh token
    const token = crypto.randomUUID();
    fs.writeFileSync(TOKEN_PATH, token, { encoding: 'utf8', mode: 0o600 });
    return token;
  } catch (err) {
    console.error('[bridge] Failed to write bridge-token:', err);
    // Fall back to in-memory only — companion won't work but Studio won't crash
    return crypto.randomUUID();
  }
}

// ── Request helpers ───────────────────────────────────────────────────────────

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function auth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const token = req.headers['x-wavi-token'] as string | undefined;
  if (token !== _bridgeToken) {
    send(res, 401, { error: 'Unauthorized — invalid or missing X-Wavi-Token' });
    return false;
  }
  return true;
}

// ── Project context builder (shared with copilot.ts) ─────────────────────────

function buildProjectContext(activeProject: any): ProjectContext {
  const files = activeProject
    ? (getFilesByProject(activeProject.id) as any[]).map(f => ({
        id: f.id,
        fileName: f.file_name,
        fileType: f.file_type,
        fileSize: f.file_size,
        role: f.role ?? 'unknown',
        bpm: f.bpm ?? null,
        keyNote: f.key_note ?? null,
        syncStatus: f.sync_status,
        cloudUrl: f.cloud_url ?? null,
      }))
    : [];

  return {
    projectId: activeProject?.id ?? null,
    projectName: activeProject?.project_name ?? null,
    dawType: activeProject?.daw_type ?? null,
    filePath: activeProject?.file_path ?? null,
    versionCount: activeProject?.version_count ?? 0,
    lastSyncedAt: activeProject?.last_synced_at ?? null,
    files,
    cloudProject: null,
  };
}

function getActiveProject(): any | null {
  const projects = getProjects() as any[];
  return projects[0] ?? null;
}

function findLatestBounce(activeProject: any | null): any | null {
  if (!activeProject) return null;
  const files = getFilesByProject(activeProject.id) as any[];
  // Prefer files with role 'bounce', 'master', or 'export'; fall back to most recent audio
  const bounceRoles = ['bounce', 'master', 'export', 'mix'];
  const bounces = files.filter(f => bounceRoles.includes(f.role ?? ''));
  const audioFiles = files.filter(f => /\.(wav|mp3|flac|aiff|m4a)$/i.test(f.file_name));
  const candidates = bounces.length > 0 ? bounces : audioFiles;
  if (!candidates.length) return null;
  return candidates.sort((a, b) =>
    new Date(b.updated_at ?? b.created_at ?? 0).getTime() -
    new Date(a.updated_at ?? a.created_at ?? 0).getTime()
  )[0];
}

// ── Route handler ─────────────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const start = Date.now();
  console.log(`[bridge] → ${req.method} ${req.url}`);
  const origEnd = res.end.bind(res);
  (res as any).end = (...args: any[]) => {
    console.log(`[bridge] ← ${res.statusCode} ${req.url} (${Date.now() - start}ms)`);
    return origEnd(...args);
  };

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Wavi-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${BRIDGE_HOST}`);
  const route = url.pathname;

  // ── GET /health — no auth required (used for polling) ─────────────────────
  if (req.method === 'GET' && route === '/health') {
    send(res, 200, {
      status: 'ok',
      service: 'wavi-studio-bridge',
      version: '1.0.0',
      port: BRIDGE_PORT,
    });
    return;
  }

  // All other routes require auth
  if (!auth(req, res)) return;

  // ── GET /active-project ───────────────────────────────────────────────────
  if (req.method === 'GET' && route === '/active-project') {
    const p = getActiveProject();
    if (!p) { send(res, 200, { project: null }); return; }
    send(res, 200, {
      project: {
        id: p.id,
        name: p.project_name,
        dawType: p.daw_type,
        filePath: p.file_path,
        lastModified: p.last_synced_at,
        versionCount: p.version_count ?? 0,
        cloudId: p.cloud_id ?? null,
      },
    });
    return;
  }

  // ── GET /project-context ──────────────────────────────────────────────────
  if (req.method === 'GET' && route === '/project-context') {
    const p = getActiveProject();
    const ctx = buildProjectContext(p);
    send(res, 200, { context: ctx });
    return;
  }

  // ── GET /project-files ────────────────────────────────────────────────────
  if (req.method === 'GET' && route === '/project-files') {
    const p = getActiveProject();
    if (!p) { send(res, 200, { files: [] }); return; }
    const files = getFilesByProject(p.id) as any[];
    send(res, 200, {
      files: files.map(f => ({
        id: f.id,
        fileName: f.file_name,
        filePath: f.file_path,
        fileType: f.file_type,
        fileSize: f.file_size,
        role: f.role ?? 'unknown',
        bpm: f.bpm ?? null,
        keyNote: f.key_note ?? null,
        syncStatus: f.sync_status,
        cloudUrl: f.cloud_url ?? null,
        updatedAt: f.updated_at,
      })),
    });
    return;
  }

  // ── GET /project-versions ─────────────────────────────────────────────────
  if (req.method === 'GET' && route === '/project-versions') {
    const p = getActiveProject();
    if (!p) { send(res, 200, { versions: [] }); return; }
    const versions = getVersionsByProject(p.id) as any[];
    send(res, 200, {
      versions: versions.map(v => ({
        id: v.id,
        versionNumber: v.version_number,
        label: v.label ?? null,
        filePath: v.file_path,
        fileSize: v.file_size,
        checksum: v.checksum,
        syncedAt: v.synced_at ?? v.created_at,
        cloudUrl: v.cloud_url ?? null,
      })),
    });
    return;
  }

  // ── GET /latest-bounce ────────────────────────────────────────────────────
  if (req.method === 'GET' && route === '/latest-bounce') {
    const p = getActiveProject();
    const bounce = findLatestBounce(p);
    if (!bounce) { send(res, 200, { bounce: null }); return; }
    send(res, 200, {
      bounce: {
        id: bounce.id,
        fileName: bounce.file_name,
        filePath: bounce.file_path,
        role: bounce.role ?? 'unknown',
        bpm: bounce.bpm ?? null,
        keyNote: bounce.key_note ?? null,
        fileSize: bounce.file_size,
        updatedAt: bounce.updated_at,
      },
    });
    return;
  }

  // ── GET /search-files?q= ─────────────────────────────────────────────────
  if (req.method === 'GET' && route === '/search-files') {
    const q = url.searchParams.get('q') ?? '';
    if (!q.trim()) { send(res, 200, { files: [] }); return; }
    const results = searchFiles(q) as any[];
    send(res, 200, {
      files: results.slice(0, 20).map(f => ({
        id: f.id,
        fileName: f.file_name,
        filePath: f.file_path,
        projectName: f.project_name ?? null,
        role: f.role ?? 'unknown',
        bpm: f.bpm ?? null,
        keyNote: f.key_note ?? null,
      })),
    });
    return;
  }

  // ── POST /open-file ───────────────────────────────────────────────────────
  if (req.method === 'POST' && route === '/open-file') {
    try {
      const body = await parseBody(req);
      const filePath = body.filePath as string | undefined;
      if (!filePath) { send(res, 400, { error: 'filePath required' }); return; }
      if (!fs.existsSync(filePath)) { send(res, 404, { error: 'File not found', filePath }); return; }
      await shell.openPath(filePath);
      logActivity({ id: crypto.randomUUID(), type: 'bridge_open_file', message: `Opened: ${path.basename(filePath)}`, metadata: { filePath } });
      send(res, 200, { status: 'ok', filePath });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
    return;
  }

  // ── POST /open-folder ─────────────────────────────────────────────────────
  if (req.method === 'POST' && route === '/open-folder') {
    try {
      const body = await parseBody(req);
      const folderPath = body.folderPath as string | undefined;
      if (!folderPath) { send(res, 400, { error: 'folderPath required' }); return; }
      await shell.openPath(folderPath);
      logActivity({ id: crypto.randomUUID(), type: 'bridge_open_folder', message: `Opened folder: ${folderPath}`, metadata: { folderPath } });
      send(res, 200, { status: 'ok', folderPath });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
    return;
  }

  // ── POST /reveal-file ─────────────────────────────────────────────────────
  if (req.method === 'POST' && route === '/reveal-file') {
    try {
      const body = await parseBody(req);
      const filePath = body.filePath as string | undefined;
      if (!filePath) { send(res, 400, { error: 'filePath required' }); return; }
      if (!fs.existsSync(filePath)) { send(res, 404, { error: 'File not found', filePath }); return; }
      shell.showItemInFolder(filePath);
      logActivity({ id: crypto.randomUUID(), type: 'bridge_reveal_file', message: `Revealed: ${path.basename(filePath)}`, metadata: { filePath } });
      send(res, 200, { status: 'ok', filePath });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
    return;
  }

  // ── POST /generate-midi ───────────────────────────────────────────────────
  if (req.method === 'POST' && route === '/generate-midi') {
    try {
      const body = await parseBody(req);
      const {
        type = 'melody',
        key = 'C',
        scale = 'minor',
        tempo = 140,
        bars = 4,
      } = body as Record<string, unknown>;

      const p = getActiveProject();
      const projectFolder = p?.file_path ? path.dirname(p.file_path) : null;

      // Dispatch to the appropriate tool in TOOL_REGISTRY
      const toolName = type === 'drums'
        ? 'generate_drum_pattern'
        : type === 'chords'
          ? 'generate_chord_progression'
          : 'generate_midi_melody';

      const tool = getToolByName(toolName);
      if (!tool) { send(res, 500, { error: `Tool not found: ${toolName}` }); return; }

      const ctx = buildProjectContext(p);
      const params: Record<string, unknown> = {
        key, scale, tempo, bars,
        ...(type === 'drums' ? { pattern_type: scale } : {}),
        projectFolder,
      };

      const result = await tool.handler(params, ctx);

      logActivity({
        id: crypto.randomUUID(),
        type: 'bridge_generate_midi',
        message: `Generated MIDI (${toolName}): ${result.filePath ? path.basename(result.filePath) : 'no file'}`,
        project_id: p?.id,
        metadata: { toolName, params, result },
      });

      send(res, result.status === 'done' ? 200 : 500, result);
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
    return;
  }

  // ── POST /analyze-latest-bounce ───────────────────────────────────────────
  if (req.method === 'POST' && route === '/analyze-latest-bounce') {
    try {
      const body = await parseBody(req);
      const p = getActiveProject();

      // Allow caller to provide explicit filePath, or auto-detect latest bounce
      let filePath = body.filePath as string | undefined;
      if (!filePath) {
        const bounce = findLatestBounce(p);
        filePath = bounce?.file_path;
      }

      if (!filePath || !fs.existsSync(filePath)) {
        send(res, 404, { error: 'No bounce file found', hint: 'Provide filePath or ensure project has bounces' });
        return;
      }

      const analysis = await analyzeAudio(filePath);
      logActivity({
        id: crypto.randomUUID(),
        type: 'bridge_analyze_bounce',
        message: `Analyzed bounce: ${path.basename(filePath)}`,
        project_id: p?.id,
        metadata: { filePath, analysis },
      });
      send(res, 200, { filePath, fileName: path.basename(filePath), analysis });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
    return;
  }

  // ── POST /log-action ──────────────────────────────────────────────────────
  if (req.method === 'POST' && route === '/log-action') {
    try {
      const body = await parseBody(req);
      const action = body.action as string | undefined;
      if (!action) { send(res, 400, { error: 'action required' }); return; }
      const p = getActiveProject();
      logActivity({
        id: crypto.randomUUID(),
        type: `bridge_${action}`,
        message: String(body.message ?? action),
        project_id: (body.projectId as string | undefined) ?? p?.id,
        metadata: (body.metadata ?? {}) as Record<string, unknown>,
      });
      send(res, 200, { status: 'ok' });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
    return;
  }

  // ── POST /open-copilot-panel ──────────────────────────────────────────────
  if (req.method === 'POST' && route === '/open-copilot-panel') {
    try {
      // Import toggleOverlay lazily to avoid circular dependency
      const { toggleOverlay } = await import('./copilot');
      toggleOverlay();
      logActivity({ id: crypto.randomUUID(), type: 'bridge_open_copilot', message: 'Opened Wavi Copilot panel via bridge', metadata: {} });
      send(res, 200, { status: 'ok' });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
    return;
  }

  // ── GET /pending-associations ──────────────────────────────────────────
  if (req.method === 'GET' && route === '/pending-associations') {
    try {
      const items = getPendingAssociations(50);
      send(res, 200, { items, count: items.length });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
    return;
  }

  // ── POST /confirm-association ─────────────────────────────────────────
  if (req.method === 'POST' && route === '/confirm-association') {
    try {
      const body = await parseBody(req);
      const { queueId, associationId, action, projectName } = body as {
        queueId?: string;
        associationId?: string;
        action?: string;
        projectName?: string;
      };

      if (!queueId && !associationId) {
        send(res, 400, { error: 'queueId or associationId required' });
        return;
      }

      const normalizedAction = action ?? 'confirmed';
      if (!['confirmed', 'rejected', 'deferred', 'undo'].includes(normalizedAction)) {
        send(res, 400, { error: `Invalid action: ${normalizedAction}` });
        return;
      }

      if (queueId) {
        const queueStatus = normalizedAction === 'undo' ? 'deferred'
          : normalizedAction as 'confirmed' | 'rejected' | 'deferred';
        resolveAssociationQueue(queueId, queueStatus);
      }

      if (associationId) {
        if (normalizedAction === 'undo') {
          undoAssociation(associationId);
        } else if (normalizedAction === 'confirmed') {
          confirmAssociation(associationId, 'user');
        }
      }

      logActivity({
        id: crypto.randomUUID(),
        type: 'bridge_association_action',
        message: `Association ${normalizedAction}: ${queueId ?? associationId}${projectName ? ` (${projectName})` : ''}`,
        metadata: { queueId, associationId, action: normalizedAction, projectName },
      });

      send(res, 200, { status: 'ok', action: normalizedAction });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
    return;
  }

  // ── POST /classify-file ───────────────────────────────────────────────
  if (req.method === 'POST' && route === '/classify-file') {
    try {
      const body = await parseBody(req);
      const filePath = body.filePath as string | undefined;
      if (!filePath) { send(res, 400, { error: 'filePath required' }); return; }

      // Security: path must be inside a watched folder
      const Store = (await import('electron-store')).default;
      const store = new Store();
      const watchedFolders = store.get('watchedFolders', []) as string[];
      const isAllowed = watchedFolders.some(f => filePath.startsWith(f));
      if (!isAllowed) {
        send(res, 403, { error: 'filePath is outside all watched folders' });
        return;
      }

      if (!fs.existsSync(filePath)) {
        send(res, 404, { error: 'File not found', filePath });
        return;
      }

      const stat = fs.statSync(filePath);
      const result = classifyFileV1(filePath, stat);

      logActivity({
        id: crypto.randomUUID(),
        type: 'bridge_classify_file',
        message: `Classified: ${path.basename(filePath)} → ${result.role} (${Math.round(result.confidence * 100)}%)`,
        metadata: { filePath, role: result.role, confidence: result.confidence },
      });

      send(res, 200, {
        filePath,
        fileName:   path.basename(filePath),
        role:       result.role,
        confidence: result.confidence,
        tokens:     result.tokens,
        signals:    result.signals,
      });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  send(res, 404, { error: `Unknown route: ${req.method} ${route}` });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startBridgeServer(): void {
  _bridgeToken = ensureToken();

  _server = http.createServer(async (req, res) => {
    // Hard 8-second timeout per request — prevents DB hangs from leaving connections open
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        console.error('[bridge] Request timeout:', req.method, req.url);
        try { send(res, 504, { error: 'Bridge handler timed out' }); } catch {}
      }
    }, 8000);

    try {
      await handleRequest(req, res);
    } catch (err) {
      console.error('[bridge] Unhandled error:', err);
      try { send(res, 500, { error: 'Internal server error' }); } catch {}
    } finally {
      clearTimeout(timeout);
    }
  });

  _server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    console.log(`[bridge] Wavi Studio bridge running on http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
    console.log(`[bridge] Token written to ${TOKEN_PATH}`);
  });

  _server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[bridge] Port ${BRIDGE_PORT} in use — bridge server not started`);
    } else {
      console.error('[bridge] Server error:', err);
    }
  });
}

export function stopBridgeServer(): void {
  _server?.close();
  _server = null;
}

export function getBridgeToken(): string {
  return _bridgeToken;
}
