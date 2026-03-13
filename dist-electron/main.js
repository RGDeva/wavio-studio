"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const db_1 = require("./db");
const bpmDetector_1 = require("./bpmDetector");
const audioAnalyzer_1 = require("./audioAnalyzer");
const classifier_1 = require("./classifier");
const crypto_1 = __importDefault(require("crypto"));
const watcher_1 = require("./watcher");
const syncAgent_1 = require("./syncAgent");
const electron_store_1 = __importDefault(require("electron-store"));
const Sentry = __importStar(require("@sentry/electron/main"));
Sentry.init({ dsn: process.env.SENTRY_DSN });
// Register wavi:// deep-link protocol
if (!electron_1.app.isDefaultProtocolClient('wavi')) {
    electron_1.app.setAsDefaultProtocolClient('wavi');
}
const store = new electron_store_1.default();
let mainWindow = null;
let watcherManager = null;
let syncAgent = null;
let tray = null;
const isDev = process.env.NODE_ENV === 'development' || !electron_1.app.isPackaged;
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#000000',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 16 },
        webPreferences: {
            preload: path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path_1.default.join(__dirname, '../public/icon.png'),
    });
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    }
    else {
        mainWindow.loadFile(path_1.default.join(__dirname, '../dist/index.html'));
    }
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}
electron_1.app.whenReady().then(async () => {
    // Init database
    const db = (0, db_1.initDatabase)();
    // Init watcher manager
    watcherManager = new watcher_1.WatcherManager(db, (event) => {
        mainWindow?.webContents.send('watcher:event', event);
    });
    // Init sync agent
    syncAgent = new syncAgent_1.SyncAgent(db, (progress) => {
        mainWindow?.webContents.send('sync:progress', progress);
        // Rebuild tray so status label stays current
        rebuildTrayMenu();
    });
    // Restore watched folders from store
    const folders = store.get('watchedFolders', []);
    for (const folder of folders) {
        watcherManager.addFolder(folder);
    }
    // Auto-discover DAW + audio folders on very first launch
    if (!store.get('didAutoDiscover', false)) {
        store.set('didAutoDiscover', true);
        const discovered = discoverDawFolders();
        // Also add common audio locations so loose audio files auto-populate
        const audioFolders = [
            electron_1.app.getPath('music'),
            electron_1.app.getPath('desktop'),
            path_1.default.join(electron_1.app.getPath('home'), 'Downloads'),
        ].filter(p => { try {
            return require('fs').statSync(p).isDirectory();
        }
        catch {
            return false;
        } });
        const allFolders = [...new Set([...discovered, ...audioFolders])];
        for (const folder of allFolders) {
            const current = store.get('watchedFolders', []);
            if (!current.includes(folder)) {
                current.push(folder);
                store.set('watchedFolders', current);
                watcherManager.addFolder(folder);
            }
        }
    }
    // Ensure common audio folders are watched (for existing users who already auto-discovered DAW-only)
    if (!store.get('didAudioFolderScan', false)) {
        store.set('didAudioFolderScan', true);
        const audioFolders = [
            electron_1.app.getPath('music'),
            electron_1.app.getPath('desktop'),
            path_1.default.join(electron_1.app.getPath('home'), 'Downloads'),
        ].filter(p => { try {
            return fs_1.default.statSync(p).isDirectory();
        }
        catch {
            return false;
        } });
        for (const folder of audioFolders) {
            const current = store.get('watchedFolders', []);
            if (!current.includes(folder)) {
                current.push(folder);
                store.set('watchedFolders', current);
                watcherManager.addFolder(folder);
            }
        }
    }
    // Start background sync agent
    syncAgent.start();
    // System tray
    createTray();
    createWindow();
    // Auto-updater — checks GitHub Releases (RGDeva/wavio) for new versions
    if (electron_1.app.isPackaged) {
        try {
            const { autoUpdater } = require('electron-updater');
            autoUpdater.autoDownload = true;
            autoUpdater.autoInstallOnAppQuit = true;
            autoUpdater.on('error', () => { }); // non-fatal — no network / no new release
            autoUpdater.on('update-downloaded', () => mainWindow?.webContents.send('update:ready'));
            autoUpdater.checkForUpdatesAndNotify().catch(() => { });
        }
        catch { /* skip if module unavailable */ }
    }
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        syncAgent?.stop();
        watcherManager?.stopAll();
        electron_1.app.quit();
    }
});
function createTray() {
    const iconPath = path_1.default.join(__dirname, '../public/icon.png');
    const icon = electron_1.nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    icon.setTemplateImage(true);
    tray = new electron_1.Tray(icon);
    tray.setToolTip('Wavi Studio');
    rebuildTrayMenu();
    tray.on('double-click', () => {
        if (!mainWindow)
            createWindow();
        else {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}
function rebuildTrayMenu() {
    if (!tray)
        return;
    const status = syncAgent?.getStatus() ?? 'idle';
    const statusLabel = status === 'idle' ? 'Idle'
        : status === 'paused:auth' ? 'Paused (sign in required)'
            : status === 'paused:limit' ? 'Paused (plan limit)'
                : status.startsWith('uploading') ? `Syncing…`
                    : status;
    const menu = electron_1.Menu.buildFromTemplate([
        { label: 'Wavi Studio', enabled: false },
        { type: 'separator' },
        { label: `Sync: ${statusLabel}`, enabled: false },
        {
            label: 'Sync now',
            click: () => { syncAgent?.retryFailed(); mainWindow?.webContents.send('tray:sync-now'); },
        },
        { type: 'separator' },
        {
            label: 'Open Wavi Studio',
            click: () => {
                if (!mainWindow)
                    createWindow();
                else {
                    mainWindow.show();
                    mainWindow.focus();
                }
            },
        },
        {
            label: 'Open Vault',
            click: () => electron_1.shell.openExternal('https://wavi.stream/vault'),
        },
        {
            label: 'Upgrade Plan',
            click: () => electron_1.shell.openExternal('https://wavi.stream/pricing'),
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                syncAgent?.stop();
                watcherManager?.stopAll();
                electron_1.app.quit();
            },
        },
    ]);
    tray.setContextMenu(menu);
}
// Deep-link: wavi://auth?token=wv_...
// macOS: open-url fires when app is already running
electron_1.app.on('open-url', (_event, url) => {
    handleDeepLink(url);
});
// Windows/Linux: second-instance fires with argv containing the URL
electron_1.app.on('second-instance', (_event, argv) => {
    const url = argv.find(arg => arg.startsWith('wavi://'));
    if (url)
        handleDeepLink(url);
    // Focus existing window
    if (mainWindow) {
        if (mainWindow.isMinimized())
            mainWindow.restore();
        mainWindow.focus();
    }
});
function handleDeepLink(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname === 'auth') {
            const token = parsed.searchParams.get('token');
            if (token && token.length > 10) {
                const toStore = electron_1.safeStorage.isEncryptionAvailable()
                    ? electron_1.safeStorage.encryptString(token).toString('base64')
                    : token;
                store.set('authToken', toStore);
                syncAgent?.setAuthToken(token);
                mainWindow?.webContents.send('auth:token-received', token);
                rebuildTrayMenu();
            }
        }
    }
    catch (e) {
        Sentry.captureException(e);
    }
}
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.aiff', '.aif', '.flac', '.m4a', '.ogg', '.aac']);
/** Import a single audio file into the library (for drag-drop / manual add). */
async function importAudioFile(filePath) {
    const ext = path_1.default.extname(filePath).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext))
        return null;
    let stats;
    try {
        stats = fs_1.default.statSync(filePath);
    }
    catch {
        return null;
    }
    const now = new Date().toISOString();
    const fileId = crypto_1.default.randomUUID();
    const fileName = path_1.default.basename(filePath);
    const role = (0, classifier_1.classifyFile)(fileName);
    // Insert immediately so it shows in Library
    const id = (0, db_1.upsertStandaloneFile)({
        id: fileId,
        file_path: filePath,
        file_name: fileName,
        file_type: ext.slice(1),
        file_size: stats.size,
        role,
        created_at: now,
        modified_at: stats.mtime.toISOString(),
    });
    // Enqueue for sync
    (0, db_1.enqueueSyncItem)({
        id: crypto_1.default.randomUUID(),
        project_id: '__standalone__',
        file_id: id,
        file_name: fileName,
        type: 'dependency_upload',
        priority: 3,
        created_at: now,
    });
    // Async: analyze BPM + key
    Promise.all([
        (0, bpmDetector_1.detectBpm)(filePath).catch(() => null),
        (0, audioAnalyzer_1.analyzeAudio)(filePath).catch(() => null),
    ]).then(([bpm, analysis]) => {
        if (bpm || analysis?.key || analysis?.duration) {
            (0, db_1.upsertStandaloneFile)({
                id: fileId,
                file_path: filePath,
                file_name: fileName,
                file_type: ext.slice(1),
                file_size: stats.size,
                bpm,
                key_note: analysis?.key ?? null,
                duration: analysis?.duration ?? null,
                role,
                created_at: now,
                modified_at: stats.mtime.toISOString(),
            });
            const parts = [];
            if (bpm)
                parts.push(`${bpm} BPM`);
            if (analysis?.key)
                parts.push(analysis.key);
            if (role !== 'unknown')
                parts.push(role);
            (0, db_1.logActivity)({
                id: crypto_1.default.randomUUID(),
                type: 'file_analyzed',
                message: `${fileName}: ${parts.join(' · ')}`,
                metadata: { filePath, bpm, key: analysis?.key, duration: analysis?.duration, role },
            });
        }
    });
    (0, db_1.logActivity)({
        id: crypto_1.default.randomUUID(),
        type: 'file_imported',
        message: `Imported: ${fileName}`,
        metadata: { filePath, fileSize: stats.size },
    });
    return id;
}
/** Scan a directory for audio files (non-recursive, fast). */
function scanDirForAudioFiles(dirPath, maxFiles = 200) {
    const results = [];
    try {
        const entries = fs_1.default.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= maxFiles)
                break;
            if (!entry.isFile() || entry.name.startsWith('.'))
                continue;
            const ext = path_1.default.extname(entry.name).toLowerCase();
            if (AUDIO_EXTENSIONS.has(ext)) {
                results.push(path_1.default.join(dirPath, entry.name));
            }
        }
    }
    catch { /* unreadable dir */ }
    return results;
}
/** Scan well-known DAW default save locations and return those that exist. */
function discoverDawFolders() {
    const home = electron_1.app.getPath('home');
    const music = electron_1.app.getPath('music');
    const docs = electron_1.app.getPath('documents');
    const desktop = electron_1.app.getPath('desktop');
    const candidates = [
        // FL Studio — multiple known paths
        path_1.default.join(docs, 'Image-Line', 'FL Studio', 'Projects'),
        path_1.default.join(docs, 'Image-Line', 'FL Studio'),
        path_1.default.join(docs, 'Image-Line', 'FL Studio', 'Backup'),
        path_1.default.join(home, 'Image-Line', 'FL Studio', 'Projects'),
        // Pro Tools — session folders
        path_1.default.join(docs, 'Pro Tools'),
        path_1.default.join(home, 'Documents', 'Pro Tools'),
        path_1.default.join(music, 'Pro Tools'),
        path_1.default.join(desktop, 'Pro Tools'),
        // Ableton Live
        path_1.default.join(music, 'Ableton'),
        path_1.default.join(docs, 'Ableton'),
        path_1.default.join(music, 'Ableton', 'User Library'),
        // Logic Pro
        path_1.default.join(music, 'Logic'),
        path_1.default.join(docs, 'Logic'),
        path_1.default.join(music, 'Music', 'Logic'),
        // Reaper
        path_1.default.join(docs, 'REAPER Media'),
        path_1.default.join(docs, 'Reaper Projects'),
        // GarageBand
        path_1.default.join(music, 'GarageBand'),
        // Cubase / Nuendo
        path_1.default.join(docs, 'Cubase Projects'),
        path_1.default.join(docs, 'Nuendo Projects'),
        // Studio One
        path_1.default.join(docs, 'Studio One'),
        path_1.default.join(docs, 'PreSonus', 'Studio One'),
        // Adobe Audition
        path_1.default.join(docs, 'Adobe', 'Audition'),
        // General music folders
        music,
    ];
    const found = candidates.filter(p => {
        try {
            return require('fs').statSync(p).isDirectory();
        }
        catch {
            return false;
        }
    });
    // Also scan top-level Desktop and Music for folders containing .ptx/.ptf/.flp files
    // (many producers save sessions directly on desktop or in ~/Music)
    for (const scanDir of [desktop, music]) {
        try {
            const entries = require('fs').readdirSync(scanDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith('.'))
                    continue;
                const fullPath = path_1.default.join(scanDir, entry.name);
                if (found.includes(fullPath))
                    continue;
                // Check if folder contains any DAW project files at depth 1
                try {
                    const subEntries = require('fs').readdirSync(fullPath);
                    const hasDawFile = subEntries.some((f) => {
                        const ext = path_1.default.extname(f).toLowerCase();
                        return ['.ptx', '.ptf', '.flp', '.als', '.logicx', '.rpp', '.cpr', '.band'].includes(ext);
                    });
                    if (hasDawFile)
                        found.push(fullPath);
                }
                catch { /* skip unreadable dirs */ }
            }
        }
        catch { /* skip */ }
    }
    return found;
}
// ── IPC Handlers ──────────────────────────────────────────────────────────────
// Auth — token encrypted at rest via safeStorage
electron_1.ipcMain.handle('auth:getToken', () => {
    const raw = store.get('authToken', null);
    if (!raw)
        return null;
    try {
        return electron_1.safeStorage.isEncryptionAvailable()
            ? electron_1.safeStorage.decryptString(Buffer.from(raw, 'base64'))
            : raw;
    }
    catch {
        return null;
    }
});
electron_1.ipcMain.handle('auth:setToken', (_e, token) => {
    const toStore = electron_1.safeStorage.isEncryptionAvailable()
        ? electron_1.safeStorage.encryptString(token).toString('base64')
        : token;
    store.set('authToken', toStore);
    syncAgent?.setAuthToken(token);
});
electron_1.ipcMain.handle('auth:clearToken', () => {
    store.delete('authToken');
    syncAgent?.setAuthToken(null);
});
// Folders
electron_1.ipcMain.handle('folders:getAll', () => {
    return store.get('watchedFolders', []);
});
electron_1.ipcMain.handle('folders:discover', () => {
    return discoverDawFolders();
});
electron_1.ipcMain.handle('folders:addPath', (_e, folderPath) => {
    const folders = store.get('watchedFolders', []);
    if (!folders.includes(folderPath)) {
        folders.push(folderPath);
        store.set('watchedFolders', folders);
        watcherManager?.addFolder(folderPath);
    }
    return folderPath;
});
electron_1.ipcMain.handle('folders:add', async () => {
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select DAW Project Folder',
    });
    if (result.canceled || !result.filePaths.length)
        return null;
    const folderPath = result.filePaths[0];
    const folders = store.get('watchedFolders', []);
    if (!folders.includes(folderPath)) {
        folders.push(folderPath);
        store.set('watchedFolders', folders);
        watcherManager?.addFolder(folderPath);
    }
    return folderPath;
});
electron_1.ipcMain.handle('folders:remove', (_e, folderPath) => {
    const folders = store.get('watchedFolders', []);
    const updated = folders.filter((f) => f !== folderPath);
    store.set('watchedFolders', updated);
    watcherManager?.removeFolder(folderPath);
});
// Projects
electron_1.ipcMain.handle('projects:getAll', () => (0, db_1.getProjects)());
electron_1.ipcMain.handle('projects:getById', (_e, id) => (0, db_1.getProjectById)(id));
// Files
electron_1.ipcMain.handle('files:getByProject', (_e, projectId) => (0, db_1.getFilesByProject)(projectId));
electron_1.ipcMain.handle('files:getAll', (_e, limit, offset) => (0, db_1.getAllFiles)(limit ?? 500, offset ?? 0));
electron_1.ipcMain.handle('files:search', (_e, query) => (0, db_1.searchFiles)(query));
electron_1.ipcMain.handle('files:stats', () => (0, db_1.getFileStats)());
// Files — import (drag-drop, manual add)
electron_1.ipcMain.handle('files:import', async (_e, filePaths) => {
    const imported = [];
    for (const p of filePaths) {
        const id = await importAudioFile(p);
        if (id)
            imported.push(id);
    }
    mainWindow?.webContents.send('watcher:event', { type: 'files_imported', count: imported.length });
    return imported;
});
electron_1.ipcMain.handle('files:addViaDialog', async () => {
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        title: 'Add Audio Files',
        filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'aiff', 'aif', 'flac', 'm4a', 'ogg', 'aac'] }],
    });
    if (result.canceled || !result.filePaths.length)
        return [];
    const imported = [];
    for (const p of result.filePaths) {
        const id = await importAudioFile(p);
        if (id)
            imported.push(id);
    }
    mainWindow?.webContents.send('watcher:event', { type: 'files_imported', count: imported.length });
    return imported;
});
// Sync
electron_1.ipcMain.handle('sync:getQueue', () => syncAgent?.getQueue() ?? []);
electron_1.ipcMain.handle('sync:retryAll', () => syncAgent?.retryFailed());
electron_1.ipcMain.handle('sync:getStatus', () => syncAgent?.getStatus() ?? 'idle');
electron_1.ipcMain.handle('sync:now', () => { syncAgent?.retryFailed(); syncAgent?.tick?.(); });
// Activity
electron_1.ipcMain.handle('activity:getAll', () => (0, db_1.getActivityLog)(100));
// Shell — open external URL (restricted to wavi.stream)
electron_1.ipcMain.handle('shell:openExternal', (_e, url) => {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('wavi.stream'))
            return;
        electron_1.shell.openExternal(url);
    }
    catch { /* invalid URL */ }
});
// Shell — only allow opening paths under common safe locations
electron_1.ipcMain.handle('shell:openPath', (_e, p) => {
    const safePrefixes = [electron_1.app.getPath('home'), electron_1.app.getPath('music'), electron_1.app.getPath('documents')];
    const resolved = path_1.default.resolve(p);
    if (!safePrefixes.some(prefix => resolved.startsWith(prefix)))
        return;
    return electron_1.shell.openPath(resolved);
});
// Settings
electron_1.ipcMain.handle('settings:get', (_e, key) => store.get(key));
electron_1.ipcMain.handle('settings:set', (_e, key, value) => store.set(key, value));
// App
electron_1.ipcMain.handle('app:relaunch', () => {
    electron_1.app.relaunch();
    electron_1.app.exit(0);
});
