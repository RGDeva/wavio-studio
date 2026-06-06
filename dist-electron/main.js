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
const fileClassifier_1 = require("./projectAssociation/fileClassifier");
const projectAssociationEngine_1 = require("./projectAssociation/projectAssociationEngine");
const bpmDetector_1 = require("./bpmDetector");
const audioAnalyzer_1 = require("./audioAnalyzer");
const classifier_1 = require("./classifier");
const crypto_1 = __importDefault(require("crypto"));
const watcher_1 = require("./watcher");
const syncAgent_1 = require("./syncAgent");
const copilot_1 = require("./copilot");
const bridgeServer_1 = require("./bridgeServer");
const musehub_1 = require("./musehub");
const electron_store_1 = __importDefault(require("electron-store"));
const Sentry = __importStar(require("@sentry/electron/main"));
Sentry.init({ dsn: process.env.SENTRY_DSN });
// Prevent any unhandled rejection or exception from crashing the main process
process.on('uncaughtException', (err) => {
    console.error('[main] uncaughtException:', err?.message ?? err);
    Sentry.captureException(err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandledRejection:', reason);
    Sentry.captureException(reason);
});
// Register wavi:// deep-link protocol
if (!electron_1.app.isDefaultProtocolClient('wavi')) {
    electron_1.app.setAsDefaultProtocolClient('wavi');
}
const store = new electron_store_1.default();
let mainWindow = null;
let watcherManager = null;
let syncAgent = null;
let tray = null;
let _trayRebuildTimer = null;
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
    // Debug: write renderer logs to file for diagnostics
    const logFile = path_1.default.join(electron_1.app.getPath('userData'), 'renderer.log');
    try {
        fs_1.default.writeFileSync(logFile, `--- Wavi Studio launched ${new Date().toISOString()} ---\n`);
    }
    catch { }
    const appendLog = (msg) => { try {
        fs_1.default.appendFileSync(logFile, msg + '\n');
    }
    catch { } };
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        const tag = ['LOG', 'WARN', 'ERR'][level] ?? 'LOG';
        appendLog(`[renderer:${tag}] ${message} (${sourceId}:${line})`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
        appendLog(`[renderer] CRASHED: ${details.reason} code=${details.exitCode}`);
    });
    mainWindow.webContents.on('unresponsive', () => {
        appendLog('[renderer] UNRESPONSIVE');
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
        appendLog(`[renderer] FAIL LOAD: ${code} ${desc}`);
    });
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
        // Throttle tray rebuilds — at most once per 3s to avoid SIGABRT from rapid native menu recreation
        if (!_trayRebuildTimer) {
            _trayRebuildTimer = setTimeout(() => {
                _trayRebuildTimer = null;
                rebuildTrayMenu();
            }, 3000);
        }
    });
    // Sync autoStart store value with actual macOS login item state
    const loginSettings = electron_1.app.getLoginItemSettings();
    store.set('autoStart', loginSettings.openAtLogin);
    // Restore auth token from encrypted store so sync agent can operate immediately
    const storedToken = store.get('authToken', null);
    if (storedToken) {
        try {
            const token = electron_1.safeStorage.isEncryptionAvailable()
                ? electron_1.safeStorage.decryptString(Buffer.from(storedToken, 'base64'))
                : storedToken;
            syncAgent.setAuthToken(token);
        }
        catch { /* token corrupt — user will re-auth */ }
    }
    // Show the window immediately — all folder scanning deferred below
    syncAgent.start();
    createTray();
    createWindow();
    (0, copilot_1.initCopilot)(store);
    (0, bridgeServer_1.startBridgeServer)();
    // MuseHub SDK — initialize if launched from MuseHub
    if ((0, musehub_1.initMuseSdk)()) {
        (0, musehub_1.startMuseHubSession)(store).then((result) => {
            if (result) {
                mainWindow?.webContents.send('musehub:session', result);
            }
            else {
                mainWindow?.webContents.send('musehub:error', 'Failed to start MuseHub session. Please log in to MuseHub, then reopen Wavi.');
            }
        }).catch((err) => {
            console.error('[main] MuseHub session error:', err);
        });
    }
    // Defer folder watching + scanning so the window opens without blocking on APFS disk I/O
    setTimeout(() => {
        // Restore watched folders from store
        const folders = store.get('watchedFolders', []);
        for (const folder of folders) {
            watcherManager.addFolder(folder);
        }
        // Auto-discover DAW + audio folders on very first launch
        if (!store.get('didAutoDiscover', false)) {
            store.set('didAutoDiscover', true);
            const discovered = discoverDawFolders();
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
        // Ensure common audio folders are watched (for existing users)
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
    }, 3000); // 3 s delay — window is fully rendered before any disk scanning begins
    // Auto-updater disabled until latest-mac.yml is published in GitHub Releases
    // (enabling it without the yml causes an unhandled rejection that crashes the app)
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
// Gracefully close watchers BEFORE Node/Electron tears down — prevents
// fsevents native module SIGABRT on mutex cleanup race.
electron_1.app.on('before-quit', async (e) => {
    if (watcherManager) {
        e.preventDefault();
        (0, copilot_1.unregisterCopilot)();
        (0, musehub_1.finalizeMuseSdk)();
        (0, bridgeServer_1.stopBridgeServer)();
        syncAgent?.stop();
        await watcherManager.stopAll();
        watcherManager = null;
        electron_1.app.quit(); // re-enter quit now that watchers are closed
    }
});
electron_1.app.on('window-all-closed', async () => {
    if (process.platform !== 'darwin') {
        syncAgent?.stop();
        await watcherManager?.stopAll();
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
            label: 'Wavi Copilot  ⌘⇧W',
            click: () => (0, copilot_1.toggleOverlay)(),
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
            click: async () => {
                syncAgent?.stop();
                await watcherManager?.stopAll();
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
    // Calculate SHA-256 checksum
    const checksum = await (0, watcher_1.fileChecksum)(filePath);
    // Insert immediately so it shows in Library
    const id = (0, db_1.upsertStandaloneFile)({
        id: fileId,
        file_path: filePath,
        file_name: fileName,
        file_type: ext.slice(1),
        file_size: stats.size,
        checksum,
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
        // Bitwig Studio
        path_1.default.join(docs, 'Bitwig Studio'),
        path_1.default.join(music, 'Bitwig Studio'),
        // Reason
        path_1.default.join(docs, 'Reason'),
        path_1.default.join(music, 'Reason'),
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
                        return ['.ptx', '.ptf', '.flp', '.als', '.logicx', '.rpp', '.cpr', '.band', '.sesx', '.song', '.reason', '.bwproject', '.npr'].includes(ext);
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
    return new Promise((resolve) => {
        setImmediate(() => resolve(discoverDawFolders()));
    });
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
electron_1.ipcMain.handle('projects:getDemoStatus', (_e, projectId) => {
    const db = require('./db').getDb();
    const project = (0, db_1.getProjectById)(projectId);
    if (!project)
        return null;
    const flpDetected = !!(project.file_path && project.file_path.endsWith('.flp'));
    // Has at least one export-folder audio file associated
    const bounceRow = db.prepare("SELECT * FROM bounce_candidates WHERE project_id = ? ORDER BY detected_at DESC LIMIT 1").get(projectId);
    // Latest confirmed version
    const latestVersion = db.prepare("SELECT * FROM versions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").get(projectId);
    // Latest sync queue item for this project
    const latestSync = db.prepare("SELECT * FROM sync_queue WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").get(projectId);
    // Export folder path (derive from bounce candidate or scan directory)
    const exportFolderDetected = !!bounceRow;
    const exportFolderPath = bounceRow ? require('path').dirname(bounceRow.file_path) : null;
    // Files in project with their sync status
    const syncedFiles = db.prepare("SELECT COUNT(*) as count FROM files WHERE project_id = ? AND sync_status = 'synced'").get(projectId);
    const totalFiles = db.prepare("SELECT COUNT(*) as count FROM files WHERE project_id = ?").get(projectId);
    return {
        project: {
            id: project.id,
            name: project.project_name,
            file_path: project.file_path,
            daw_type: project.daw_type,
            sync_status: project.sync_status,
            cloud_id: project.cloud_id,
            version_count: project.version_count,
        },
        checks: {
            folderLinked: true,
            flpDetected,
            exportFolderDetected,
            exportFolderPath,
            latestBounce: bounceRow ? {
                file_name: bounceRow.file_name,
                role: bounceRow.role,
                status: bounceRow.status,
                detected_at: bounceRow.detected_at,
                file_size: bounceRow.file_size,
            } : null,
            latestVersion: latestVersion ? {
                label: latestVersion.label ?? 'version',
                version_type: latestVersion.version_type,
                created_at: latestVersion.created_at,
                file_path: latestVersion.file_path,
                checksum: latestVersion.checksum,
            } : null,
            uploadStatus: latestSync
                ? latestSync.status
                : (totalFiles?.count > 0 ? 'pending' : 'none'),
            webSynced: project.sync_status === 'synced' && !!project.cloud_id,
            syncedFiles: syncedFiles?.count ?? 0,
            totalFiles: totalFiles?.count ?? 0,
        },
    };
});
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
        const allowed = ['wavi.stream', 'github.com', 'privy.io'];
        if (parsed.protocol !== 'https:' || !allowed.some(h => parsed.hostname.endsWith(h)))
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
electron_1.ipcMain.handle('settings:set', (_e, key, value) => {
    store.set(key, value);
    // Wire autoStart to macOS login item
    if (key === 'autoStart') {
        electron_1.app.setLoginItemSettings({ openAtLogin: !!value, openAsHidden: true });
    }
});
// Bounce candidates — version confirmation flow
electron_1.ipcMain.handle('bounces:getPending', () => (0, db_1.getPendingBounceCandidates)());
electron_1.ipcMain.handle('bounces:resolve', async (_e, id, action) => {
    // Resolve the candidate status first
    (0, db_1.resolveBounceCandidate)(id, action);
    if (action !== 'confirmed' && action !== 'master' && action !== 'stem')
        return;
    // Fetch candidate from DB (already resolved above)
    const c = (0, db_1.getBounceCandidateById)(id);
    if (!c)
        return;
    const label = action === 'master' ? 'master' : action === 'stem' ? 'stem' : 'bounce';
    const now = new Date().toISOString();
    // Ensure the file exists on disk
    if (!fs_1.default.existsSync(c.file_path)) {
        (0, db_1.logActivity)({ id: crypto_1.default.randomUUID(), type: 'sync_error',
            message: `Cannot create version: file not found: ${c.file_name}`,
            project_id: c.project_id ?? undefined });
        return;
    }
    // Ensure we have a files row for this bounce (needed for syncAgent.syncFile)
    const existingFiles = c.project_id ? (0, db_1.getFilesByProject)(c.project_id) : [];
    let fileRow = existingFiles.find((f) => f.file_path === c.file_path);
    if (!fileRow) {
        const fid = crypto_1.default.randomUUID();
        const ext = c.file_path.split('.').pop() ?? 'wav';
        (0, db_1.upsertFile)({
            id: fid,
            project_id: c.project_id ?? '__standalone__',
            file_path: c.file_path,
            file_name: c.file_name,
            file_type: ext,
            file_size: c.file_size ?? 0,
            checksum: c.checksum ?? undefined,
            role: c.role ?? label,
            created_at: now,
            modified_at: now,
        });
        fileRow = { id: fid };
    }
    // Version dedup: skip if same checksum or path already recorded
    const projectId = c.project_id;
    if (projectId) {
        if (c.checksum && (0, db_1.versionExistsByChecksum)(projectId, c.checksum)) {
            mainWindow?.webContents.send('watcher:event', { type: 'version_created', projectId });
            return;
        }
        if ((0, db_1.versionExistsByPath)(projectId, c.file_path)) {
            mainWindow?.webContents.send('watcher:event', { type: 'version_created', projectId });
            return;
        }
    }
    const versionId = crypto_1.default.randomUUID();
    if (projectId) {
        (0, db_1.createVersion)({
            id: versionId,
            project_id: projectId,
            file_path: c.file_path,
            file_size: c.file_size ?? 0,
            checksum: c.checksum ?? undefined,
            label,
            version_type: label,
            confirmed: 1,
            created_at: now,
        });
    }
    (0, db_1.enqueueSyncItem)({
        id: crypto_1.default.randomUUID(),
        project_id: projectId ?? '__standalone__',
        file_id: fileRow.id,
        file_name: c.file_name,
        type: 'dependency_upload',
        priority: 9,
        created_at: now,
    });
    (0, db_1.logActivity)({
        id: crypto_1.default.randomUUID(),
        type: 'version_created',
        message: `New ${label} version: ${c.file_name}`,
        project_id: projectId ?? undefined,
        metadata: { filePath: c.file_path, label, versionId },
    });
    // Kick the sync agent immediately
    syncAgent?.tick();
    mainWindow?.webContents.send('watcher:event', { type: 'version_created', projectId });
});
electron_1.ipcMain.handle('versions:getByProject', (_e, projectId) => (0, db_1.getVersionsByProject)(projectId));
// Association Engine IPC
electron_1.ipcMain.handle('association:getPending', () => {
    return (0, db_1.getPendingAssociations)(50);
});
electron_1.ipcMain.handle('association:confirm', (_e, queueId, projectName) => {
    // Fetch the queue item so we can write asset_associations for every file pair
    const db = require('./db').getDb();
    const row = db.prepare('SELECT file_ids, relationship, confidence FROM association_queue WHERE id = ?').get(queueId);
    (0, db_1.resolveAssociationQueue)(queueId, 'confirmed');
    if (row) {
        try {
            const fileIds = JSON.parse(row.file_ids);
            (0, projectAssociationEngine_1.confirmQueueItem)(db, queueId, fileIds, row.relationship, row.confidence);
        }
        catch { /* non-fatal — association rows are best-effort */ }
    }
    (0, db_1.logActivity)({
        id: crypto_1.default.randomUUID(),
        type: 'association_confirmed',
        message: `Confirmed association${projectName ? `: ${projectName}` : ''}`,
        metadata: { queueId, projectName },
    });
    return { ok: true };
});
electron_1.ipcMain.handle('association:reject', (_e, queueId) => {
    (0, db_1.resolveAssociationQueue)(queueId, 'rejected');
    (0, db_1.logActivity)({
        id: crypto_1.default.randomUUID(),
        type: 'association_rejected',
        message: `Rejected association: ${queueId}`,
        metadata: { queueId },
    });
    return { ok: true };
});
electron_1.ipcMain.handle('association:undo', (_e, associationId) => {
    (0, db_1.undoAssociation)(associationId);
    (0, db_1.logActivity)({
        id: crypto_1.default.randomUUID(),
        type: 'association_undone',
        message: `Undid association: ${associationId}`,
        metadata: { associationId },
    });
    return { ok: true };
});
electron_1.ipcMain.handle('association:classifyFile', (_e, filePath) => {
    try {
        const stat = fs_1.default.statSync(filePath);
        const result = (0, fileClassifier_1.classifyFile)(filePath, stat);
        (0, db_1.updateFileClassificationByPath)(filePath, {
            classifier_role: result.role,
            classifier_confidence: result.confidence,
            name_tokens: JSON.stringify(result.tokens),
        });
        return result;
    }
    catch (err) {
        return { error: String(err) };
    }
});
// Bridge status
electron_1.ipcMain.handle('bridge:getStatus', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tokenPath = path.join(os.homedir(), '.wavi', 'bridge-token');
    const tokenExists = fs.existsSync(tokenPath);
    let tokenPerm = '';
    try {
        tokenPerm = (fs.statSync(tokenPath).mode & 0o777).toString(8);
    }
    catch { /* ignore */ }
    const { BRIDGE_PORT, BRIDGE_HOST, getBridgeToken } = require('./bridgeServer');
    const token = getBridgeToken();
    return {
        port: BRIDGE_PORT,
        host: BRIDGE_HOST,
        tokenExists,
        tokenPerm,
        tokenHint: token.length > 8 ? token.slice(0, 8) + '…' : '',
        online: token.length > 0,
    };
});
// MuseHub
electron_1.ipcMain.handle('musehub:isSession', () => (0, musehub_1.isMuseHubSession)());
electron_1.ipcMain.handle('musehub:getUserInfo', () => (0, musehub_1.getMuseHubUserInfo)());
electron_1.ipcMain.handle('musehub:getEntitlement', () => (0, musehub_1.getCachedEntitlement)(store));
electron_1.ipcMain.handle('musehub:checkUsage', async () => {
    return (0, musehub_1.checkAndIncrementUsage)(store);
});
electron_1.ipcMain.handle('musehub:refreshSession', async () => {
    const result = await (0, musehub_1.startMuseHubSession)(store);
    return result;
});
// App
electron_1.ipcMain.handle('app:relaunch', () => {
    electron_1.app.relaunch();
    electron_1.app.exit(0);
});
