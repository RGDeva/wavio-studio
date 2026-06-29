"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initCopilot = initCopilot;
exports.toggleOverlay = toggleOverlay;
exports.unregisterCopilot = unregisterCopilot;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("./db");
const agentLoop_1 = require("./agentLoop");
let overlayWindow = null;
let _store = null;
let _ipcRegistered = false;
const isDev = process.env.NODE_ENV === 'development' || !electron_1.app.isPackaged;
// ── Window management ─────────────────────────────────────────────────────────
function initCopilot(store) {
    _store = store;
    registerHotkey();
    registerIpcHandlers();
}
function createOverlayWindow() {
    const cursor = electron_1.screen.getCursorScreenPoint();
    const display = electron_1.screen.getDisplayNearestPoint(cursor);
    const { bounds } = display;
    const W = 400;
    const H = 680;
    // Position near cursor, clamped to display
    let x = Math.round(cursor.x + 20);
    let y = Math.round(cursor.y - H / 2);
    x = Math.max(bounds.x + 8, Math.min(x, bounds.x + bounds.width - W - 8));
    y = Math.max(bounds.y + 8, Math.min(y, bounds.y + bounds.height - H - 8));
    overlayWindow = new electron_1.BrowserWindow({
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
            preload: path_1.default.join(__dirname, 'copilot-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    if (isDev) {
        overlayWindow.loadURL('http://localhost:5173/overlay.html');
    }
    else {
        overlayWindow.loadFile(path_1.default.join(__dirname, '../dist/overlay.html'));
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
function toggleOverlay() {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
        createOverlayWindow();
        return;
    }
    if (overlayWindow.isVisible()) {
        overlayWindow.hide();
    }
    else {
        // Reposition near current cursor
        const cursor = electron_1.screen.getCursorScreenPoint();
        const display = electron_1.screen.getDisplayNearestPoint(cursor);
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
    const ok = electron_1.globalShortcut.register(shortcut, toggleOverlay);
    if (!ok) {
        console.warn('[copilot] Failed to register global shortcut:', shortcut);
    }
}
function unregisterCopilot() {
    electron_1.globalShortcut.unregisterAll();
    overlayWindow?.destroy();
    overlayWindow = null;
}
// ── Context builder ───────────────────────────────────────────────────────────
function getAuthToken() {
    if (!_store)
        return null;
    const raw = _store.get('authToken', null);
    if (!raw)
        return null;
    try {
        const { safeStorage } = require('electron');
        return safeStorage.isEncryptionAvailable()
            ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
            : raw;
    }
    catch {
        return null;
    }
}
async function buildProjectContext() {
    const projects = (0, db_1.getProjects)();
    const activeProject = projects[0] ?? null; // Most recently modified
    const baseCtx = {
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
        const rawFiles = (0, db_1.getFilesByProject)(activeProject.id);
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
                const data = await res.json();
                baseCtx.cloudProject = {
                    projectId: data.project?.id ?? activeProject.cloud_id,
                    name: data.project?.name ?? activeProject.project_name,
                    daw: data.project?.daw_source ?? activeProject.daw_type,
                    versions: (data.versions ?? []).map((v) => ({
                        id: v.id,
                        versionNumber: v.version_number,
                        syncedAt: v.synced_at ?? v.created_at,
                        fileSize: v.file_size ?? 0,
                    })),
                    assets: (data.assets ?? []).map((a) => ({
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
        }
        catch {
            // Cloud unavailable — local context only
        }
    }
    return baseCtx;
}
// ── IPC Handlers ──────────────────────────────────────────────────────────────
function registerIpcHandlers() {
    if (_ipcRegistered)
        return;
    _ipcRegistered = true;
    electron_1.ipcMain.handle('copilot:close', () => {
        overlayWindow?.hide();
    });
    electron_1.ipcMain.handle('copilot:getContext', async () => {
        return buildProjectContext();
    });
    electron_1.ipcMain.handle('copilot:runTool', async (_e, toolName, params) => {
        const tool = (0, agentLoop_1.getToolByName)(toolName);
        if (!tool) {
            return { status: 'error', error: `Unknown tool: ${toolName}` };
        }
        const ctx = await buildProjectContext();
        const result = await tool.handler(params, ctx);
        // Log to activity
        (0, db_1.logActivity)({
            id: crypto_1.default.randomUUID(),
            type: 'copilot_tool',
            message: `Copilot: ${toolName} → ${result.status === 'done' ? result.filePath?.split('/').pop() ?? 'done' : result.error}`,
            project_id: ctx.projectId ?? undefined,
            metadata: { toolName, params, result },
        });
        // Notify main window
        const { BrowserWindow: BW } = require('electron');
        const mainWin = BW.getAllWindows().find((w) => w !== overlayWindow);
        mainWin?.webContents.send('watcher:event', { type: 'copilot_tool', toolName, result });
        return result;
    });
    electron_1.ipcMain.handle('copilot:chat', async (_e, messages, context) => {
        const token = getAuthToken();
        return (0, agentLoop_1.runAgentChat)(messages, context, token);
    });
    electron_1.ipcMain.handle('copilot:toggle', () => {
        toggleOverlay();
    });
}
