import { BrowserWindow, globalShortcut, ipcMain, screen, app } from 'electron';
import path from 'path';
import crypto from 'crypto';
import { getProjects, getFilesByProject, logActivity } from './db';
import { getToolByName, runAgentChat } from './agentLoop';
import type { ProjectContext } from './copilotTypes';

let overlayWindow: BrowserWindow | null = null;
let _store: any = null;
let _ipcRegistered = false;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// ── Window management ─────────────────────────────────────────────────────────

export function initCopilot(store: any) {
  _store = store;
  registerHotkey();
  registerIpcHandlers();
}

function createOverlayWindow() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { bounds } = display;

  const W = 400;
  const H = 680;

  // Position near cursor, clamped to display
  let x = Math.round(cursor.x + 20);
  let y = Math.round(cursor.y - H / 2);
  x = Math.max(bounds.x + 8, Math.min(x, bounds.x + bounds.width - W - 8));
  y = Math.max(bounds.y + 8, Math.min(y, bounds.y + bounds.height - H - 8));

  overlayWindow = new BrowserWindow({
    x,
    y,
    width: W,
    height: H,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    vibrancy: undefined,
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'copilot-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    overlayWindow.loadURL('http://localhost:5173/overlay.html');
  } else {
    overlayWindow.loadFile(path.join(__dirname, '../dist/overlay.html'));
  }

  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlayWindow.on('blur', () => {
    // Hide on blur unless dev tools open
    if (!isDev) {
      overlayWindow?.hide();
    }
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

export function toggleOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
    return;
  }
  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    // Reposition near current cursor
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { bounds } = display;
    const [W, H] = [400, 680];
    let x = Math.round(cursor.x + 20);
    let y = Math.round(cursor.y - H / 2);
    x = Math.max(bounds.x + 8, Math.min(x, bounds.x + bounds.width - W - 8));
    y = Math.max(bounds.y + 8, Math.min(y, bounds.y + bounds.height - H - 8));
    overlayWindow.setPosition(x, y);
    overlayWindow.show();
    overlayWindow.focus();
  }
}

function registerHotkey() {
  const shortcut = process.platform === 'darwin' ? 'Command+Shift+W' : 'Control+Shift+W';
  const ok = globalShortcut.register(shortcut, toggleOverlay);
  if (!ok) {
    console.warn('[copilot] Failed to register global shortcut:', shortcut);
  }
}

export function unregisterCopilot() {
  globalShortcut.unregisterAll();
  overlayWindow?.destroy();
  overlayWindow = null;
}

// ── Context builder ───────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  if (!_store) return null;
  const raw = _store.get('authToken', null) as string | null;
  if (!raw) return null;
  try {
    const { safeStorage } = require('electron');
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
      : raw;
  } catch { return null; }
}

async function buildProjectContext(): Promise<ProjectContext> {
  const projects = getProjects() as any[];
  const activeProject = projects[0] ?? null; // Most recently modified

  const baseCtx: ProjectContext = {
    projectId: activeProject?.id ?? null,
    projectName: activeProject?.project_name ?? null,
    dawType: activeProject?.daw_type ?? null,
    filePath: activeProject?.file_path ?? null,
    versionCount: activeProject?.version_count ?? 0,
    lastSyncedAt: activeProject?.last_synced_at ?? null,
    files: [],
    cloudProject: null,
  };

  if (activeProject) {
    const rawFiles = getFilesByProject(activeProject.id) as any[];
    baseCtx.files = rawFiles.map((f) => ({
      id: f.id,
      fileName: f.file_name,
      fileType: f.file_type,
      fileSize: f.file_size,
      role: f.role ?? 'unknown',
      bpm: f.bpm ?? null,
      keyNote: f.key_note ?? null,
      syncStatus: f.sync_status,
      cloudUrl: f.cloud_url ?? null,
    }));
  }

  // Try to fetch cloud context if authenticated and cloud_id exists
  const token = getAuthToken();
  if (token && activeProject?.cloud_id) {
    try {
      const res = await fetch(`https://wavi.stream/api/assistant/context?projectId=${activeProject.cloud_id}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        baseCtx.cloudProject = {
          projectId: data.project?.id ?? activeProject.cloud_id,
          name: data.project?.name ?? activeProject.project_name,
          daw: data.project?.daw_source ?? activeProject.daw_type,
          versions: (data.versions ?? []).map((v: any) => ({
            id: v.id,
            versionNumber: v.version_number,
            syncedAt: v.synced_at ?? v.created_at,
            fileSize: v.file_size ?? 0,
          })),
          assets: (data.assets ?? []).map((a: any) => ({
            id: a.id,
            name: a.name,
            fileUrl: a.file_url,
            format: a.format ?? '',
            createdAt: a.created_at,
            role: a.role ?? null,
          })),
          collaborators: data.collaborators ?? [],
          latestExport: data.latestExport ? {
            id: data.latestExport.id,
            name: data.latestExport.name,
            fileUrl: data.latestExport.file_url,
            format: data.latestExport.format ?? '',
            createdAt: data.latestExport.created_at,
            role: data.latestExport.role ?? null,
          } : null,
        };
      }
    } catch {
      // Cloud unavailable — local context only
    }
  }

  return baseCtx;
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

function registerIpcHandlers() {
  if (_ipcRegistered) return;
  _ipcRegistered = true;
  ipcMain.handle('copilot:close', () => {
    overlayWindow?.hide();
  });

  ipcMain.handle('copilot:getContext', async () => {
    return buildProjectContext();
  });

  ipcMain.handle('copilot:runTool', async (_e, toolName: string, params: Record<string, unknown>) => {
    const tool = getToolByName(toolName);
    if (!tool) {
      return { status: 'error', error: `Unknown tool: ${toolName}` };
    }

    const ctx = await buildProjectContext();
    const result = await tool.handler(params, ctx);

    // Log to activity
    logActivity({
      id: crypto.randomUUID(),
      type: 'copilot_tool',
      message: `Copilot: ${toolName} → ${result.status === 'done' ? result.filePath?.split('/').pop() ?? 'done' : result.error}`,
      project_id: ctx.projectId ?? undefined,
      metadata: { toolName, params, result },
    });

    // Notify main window
    const { BrowserWindow: BW } = require('electron');
    const mainWin = BW.getAllWindows().find((w: BrowserWindow) => w !== overlayWindow);
    mainWin?.webContents.send('watcher:event', { type: 'copilot_tool', toolName, result });

    return result;
  });

  ipcMain.handle('copilot:chat', async (_e, messages: Array<{ role: string; content: string }>, context: ProjectContext | null) => {
    const token = getAuthToken();
    return runAgentChat(messages, context, token);
  });

  ipcMain.handle('copilot:toggle', () => {
    toggleOverlay();
  });
}
