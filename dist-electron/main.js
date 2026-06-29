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
const child_process_1 = require("child_process");
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
const ableton_1 = require("./ableton");
const bridgeServer_1 = require("./bridgeServer");
const musehub_1 = require("./musehub");
const electron_store_1 = __importDefault(require("electron-store"));
const config_1 = require("./config");
const discovery_1 = require("./discovery");
// Sentry is loaded dynamically to avoid crash during module import
// (Sentry's normalize.js calls electron.app.getAppPath() on module load)
let SentryInstance = null;
async function initSentry() {
    try {
        if (process.env.SENTRY_DSN) {
            SentryInstance = await Promise.resolve().then(() => __importStar(require('@sentry/electron/main')));
            SentryInstance.init({ dsn: process.env.SENTRY_DSN });
        }
    }
    catch {
        // Sentry init failed - continue without error tracking
        SentryInstance = null;
    }
}
// Safe error capture helper
function captureException(err) {
    try {
        if (SentryInstance) {
            SentryInstance.captureException(err);
        }
    }
    catch {
        // Ignore Sentry errors
    }
}
// Main-process diagnostic log file - lazily initialized to avoid calling app.getPath()
// at module load time (app may not be ready yet during certain launch contexts)
let MAIN_LOG = null;
function getMainLogPath() {
    if (!MAIN_LOG) {
        MAIN_LOG = path_1.default.join(electron_1.app.getPath('home'), '.wavi', 'main.log');
    }
    return MAIN_LOG;
}
// Log rotation: max 5MB per file, keep 1 backup
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
function mainLog(msg) {
    try {
        const logPath = getMainLogPath();
        fs_1.default.mkdirSync(path_1.default.dirname(logPath), { recursive: true });
        // Check log size and rotate if needed
        try {
            const stats = fs_1.default.statSync(logPath);
            if (stats.size > MAX_LOG_SIZE) {
                // Rotate: move current to backup, start fresh
                const backupPath = logPath + '.old';
                try {
                    fs_1.default.renameSync(logPath, backupPath);
                }
                catch { /* ignore */ }
            }
        }
        catch { /* file doesn't exist yet */ }
        fs_1.default.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
    }
    catch { }
}
// Prevent any unhandled rejection or exception from crashing the main process
process.on('uncaughtException', (err) => {
    console.error('[main] uncaughtException:', err?.message ?? err);
    mainLog(`uncaughtException: ${err?.stack ?? err?.message ?? err}`);
    captureException(err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandledRejection:', reason);
    mainLog(`unhandledRejection: ${reason?.stack ?? reason?.message ?? reason}`);
    captureException(reason);
});
// These will be initialized inside app.whenReady()
let store;
let mainWindow = null;
let watcherManager = null;
let syncAgent = null;
let tray = null;
let _trayRebuildTimer = null;
const isDev = process.env.NODE_ENV === 'development' || !electron_1.app.isPackaged;
// ── Dev / prod data isolation ─────────────────────────────────────────────────
// MUST happen before app.whenReady() — Electron resolves userData from appName
// at first access. Changing the name here routes dev to a separate directory:
//   production: ~/Library/Application Support/wavio-studio
//   dev:        ~/Library/Application Support/wavio-studio-dev
//
// This prevents dev builds from polluting the production DB, watched folders,
// auth tokens, and settings — and prevents prod from seeing dev test data.
if (isDev) {
    // app.name must be set before any call to app.getPath('userData').
    // electron-store reads userData during construction, so this runs first.
    electron_1.app.setName('wavio-studio-dev');
}
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
    // Content Security Policy for security — production only.
    // In dev, Vite needs ws:// for HMR and 'unsafe-eval' for module loading, so we skip CSP.
    if (!isDev) {
        mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    // http://127.0.0.1:47821 = local bridge server (health checks from renderer)
                    'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://wavi.stream https://*.supabase.co wss://*.supabase.co http://127.0.0.1:47821; img-src 'self' data: https:; media-src 'self' https: blob:; font-src 'self' data:;"]
                }
            });
        });
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
        mainLog(`render-process-gone: ${details.reason} code=${details.exitCode}`);
    });
    mainWindow.webContents.on('unresponsive', () => {
        appendLog('[renderer] UNRESPONSIVE');
        mainLog('renderer unresponsive');
    });
    mainWindow.webContents.on('did-start-loading', () => appendLog('[renderer] did-start-loading'));
    mainWindow.webContents.on('did-finish-load', () => appendLog('[renderer] did-finish-load'));
    mainWindow.webContents.on('dom-ready', () => appendLog('[renderer] dom-ready'));
    const loadRenderer = (attempt = 0) => {
        if (!mainWindow || mainWindow.isDestroyed())
            return;
        if (isDev) {
            mainWindow.loadURL('http://localhost:5173').catch((e) => {
                appendLog(`[renderer] loadURL error: ${e?.message ?? e}`);
            });
        }
        else {
            mainWindow.loadFile(path_1.default.join(__dirname, '../dist/index.html')).catch((e) => {
                appendLog(`[renderer] loadFile error: ${e?.message ?? e}`);
            });
        }
    };
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
        appendLog(`[renderer] FAIL LOAD: ${code} ${desc} url=${url} mainFrame=${isMainFrame}`);
        // -3 = ABORTED (benign, navigation superseded). Retry real failures on the main frame.
        if (isMainFrame && code !== -3) {
            setTimeout(() => loadRenderer(), 1000);
        }
    });
    // Show the window explicitly once content is ready (defensive against blank windows)
    mainWindow.once('ready-to-show', () => {
        appendLog('[renderer] ready-to-show');
        mainWindow?.show();
    });
    loadRenderer();
    if (isDev && process.env.WAVI_DEVTOOLS === '1') {
        setTimeout(() => { try {
            mainWindow?.webContents.openDevTools();
        }
        catch { } }, 1500);
    }
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}
// Fix recurring "Network service crashed, restarting service" on macOS.
// Must be called before app.whenReady() but after Electron has initialized internals.
// We wrap in a try-catch in case app is not ready yet.
try {
    electron_1.app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox');
    if (process.env.WAVI_NO_SANDBOX === '1') {
        electron_1.app.commandLine.appendSwitch('no-sandbox');
        electron_1.app.commandLine.appendSwitch('disable-gpu-sandbox');
    }
    if (process.env.WAVI_DEBUG_PORT) {
        electron_1.app.commandLine.appendSwitch('remote-debugging-port', process.env.WAVI_DEBUG_PORT);
    }
}
catch {
    // commandLine may not be available in all contexts - continue without
}
electron_1.app.whenReady().then(async () => {
    mainLog('--- main process started ---');
    (0, config_1.logApiEnvironment)();
    // Initialize store now that app is ready
    store = new electron_store_1.default();
    // Register wavi:// deep-link protocol
    if (!electron_1.app.isDefaultProtocolClient('wavi')) {
        electron_1.app.setAsDefaultProtocolClient('wavi');
    }
    // Initialize Sentry error tracking (async to avoid blocking)
    initSentry().catch(() => { });
    // E2E isolation mode
    if (process.env.WAVI_E2E === '1') {
        console.warn('[E2E] Isolated test mode: DB=wavio-studio-e2e.db, watching only E2E folder');
    }
    // Step 1-3: Initialize DB + run all schema migrations synchronously.
    // better-sqlite3 is fast (<100ms on existing DBs) so we do this before showing
    // the window — that way any IPC calls the renderer fires at mount time are safe.
    mainLog('Initializing database...');
    const t0 = Date.now();
    const db = (0, db_1.initDatabase)({ dbName: process.env.WAVI_E2E === '1' ? 'wavio-studio-e2e.db' : 'wavio-studio.db' });
    mainLog(`Database initialized in ${Date.now() - t0}ms`);
    // Step 4: Initialize watcher manager with safe IPC sender
    watcherManager = new watcher_1.WatcherManager(db, (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.webContents.send('watcher:event', event);
            }
            catch (e) {
                // Window may be closing, ignore
            }
        }
    });
    // Init sync agent with safe IPC sender
    syncAgent = new syncAgent_1.SyncAgent(db, (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.webContents.send('sync:progress', progress);
            }
            catch (e) {
                // Window may be closing, ignore
            }
        }
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
            if (electron_1.safeStorage.isEncryptionAvailable()) {
                const token = electron_1.safeStorage.decryptString(Buffer.from(storedToken, 'base64'));
                syncAgent.setAuthToken(token);
            }
            else {
                // In dev without encryption, still allow token
                syncAgent.setAuthToken(storedToken);
            }
        }
        catch (e) {
            console.error('[main] Token restore failed:', e);
            // Token corrupt — user will re-auth
        }
    }
    // Step 4 (cont): Start services — all folder scanning deferred below
    syncAgent.start();
    (0, copilot_1.initCopilot)(store);
    (0, ableton_1.registerAbletonHandlers)();
    (0, bridgeServer_1.startBridgeServer)();
    // Steps 6-7: Create window after DB + services are ready — eliminates IPC race
    // where renderer fires projects:getAll before initDatabase() completed.
    createTray();
    createWindow();
    // Notify renderer once the page finishes loading (DB is already initialized above)
    mainWindow?.webContents.once('did-finish-load', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('main:ready');
        }
    });
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
        // E2E isolation: override watched folders so tests don't touch the user's real library
        if (process.env.WAVI_E2E === '1') {
            const e2eFolder = process.env.WAVI_E2E_FOLDER ?? '/tmp/wavi-e2e';
            watcherManager.addFolder(e2eFolder);
            return;
        }
        // Restore watched folders from store
        const folders = store.get('watchedFolders', []);
        for (const folder of folders) {
            watcherManager.addFolder(folder);
        }
        // Auto-discover specific DAW project subfolders on first launch.
        // NOTE: ~/Music, ~/Desktop, ~/Downloads are NOT added as root watch paths —
        // scanning those entire trees on machines with large libraries causes OOM → SIGKILL.
        if (!store.get('didAutoDiscover', false)) {
            store.set('didAutoDiscover', true);
            const discovered = discoverDawFolders();
            for (const folder of discovered) {
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
        try {
            syncAgent?.stop();
            await watcherManager?.stopAll();
        }
        catch (e) {
            console.error('[main] Error during shutdown:', e);
        }
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
    void handleDeepLink(url);
});
// Windows/Linux: second-instance fires with argv containing the URL
electron_1.app.on('second-instance', (_event, argv) => {
    const url = argv.find(arg => arg.startsWith('wavi://'));
    if (url)
        void handleDeepLink(url);
    // Focus existing window
    if (mainWindow) {
        if (mainWindow.isMinimized())
            mainWindow.restore();
        mainWindow.focus();
    }
});
// Exchange a short-lived Privy JWT for a persistent wv_ desktop token.
// Returns the wv_ token on success, null on failure.
async function exchangePrivyJwt(privyJwt) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let res;
        try {
            res = await fetch(`${config_1.API_BASE}/desktop/index`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${privyJwt}`,
                    'X-Desktop-Action': 'create-desktop-token',
                },
                body: JSON.stringify({ deviceLabel: `Wavi Studio — ${require('os').hostname()}` }),
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            mainLog(`[auth] Token exchange HTTP ${res.status}`);
            return null;
        }
        const data = await res.json();
        if (!data?.token?.startsWith('wv_')) {
            mainLog('[auth] Token exchange: unexpected response shape');
            return null;
        }
        return data.token;
    }
    catch (e) {
        mainLog(`[auth] Token exchange error: ${e?.message ?? e}`);
        captureException(e);
        return null;
    }
}
async function handleDeepLink(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'wavi:')
            return;
        if (parsed.hostname !== 'auth')
            return;
        const rawToken = parsed.searchParams.get('token');
        if (!rawToken || rawToken.length < 10)
            return;
        let finalToken;
        if (rawToken.startsWith('wv_')) {
            // Already a desktop token (future-proof for direct wv_ deep links)
            finalToken = rawToken;
        }
        else {
            // Privy JWT — exchange for a persistent 30-day desktop token.
            // The raw JWT is never stored; if exchange fails we do not fall back.
            mainWindow?.webContents.send('auth:exchanging');
            const exchanged = await exchangePrivyJwt(rawToken);
            if (!exchanged) {
                mainWindow?.webContents.send('auth:error', 'exchange-failed');
                return;
            }
            finalToken = exchanged;
        }
        // Store encrypted — never log the token value
        const toStore = electron_1.safeStorage.isEncryptionAvailable()
            ? electron_1.safeStorage.encryptString(finalToken).toString('base64')
            : finalToken;
        store.set('authToken', toStore);
        syncAgent?.setAuthToken(finalToken);
        // Signal renderer that auth succeeded; send token so renderer can set authed=true.
        // The renderer does NOT store the token on disk — that is main process responsibility.
        mainWindow?.webContents.send('auth:token-received', finalToken);
        rebuildTrayMenu();
    }
    catch (e) {
        captureException(e);
        mainLog(`[auth] handleDeepLink error: ${e?.message ?? e}`);
    }
}
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.aiff', '.aif', '.flac', '.m4a', '.ogg', '.aac']);
/** Returns the DB id if this file_path already exists in the library, else null. */
function checkFileExists(filePath) {
    return (0, db_1.getFileByPath)(filePath)?.id ?? null;
}
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
        // NOTE: `music` (~/Music root) is intentionally excluded — adding the entire
        // ~/Music tree as a watch path OOM-kills the process on large libraries.
        // Users can add specific folders via the folder picker in Settings.
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
// Share links — create or retrieve a share link for a synced asset
electron_1.ipcMain.handle('share:createLink', async (_e, opts) => {
    // Read the decrypted token from the secure store (same as startup restoration)
    const storedRaw = store.get('authToken', null);
    if (!storedRaw)
        return { error: 'Not authenticated' };
    let token;
    try {
        token = electron_1.safeStorage.isEncryptionAvailable()
            ? electron_1.safeStorage.decryptString(Buffer.from(storedRaw, 'base64'))
            : storedRaw;
    }
    catch {
        return { error: 'Token decrypt failed' };
    }
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let res;
        try {
            res = await fetch(`${config_1.API_BASE}/desktop/index`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                    'X-Desktop-Action': 'create-share-link',
                },
                body: JSON.stringify({
                    assetId: opts.assetId,
                    allowDownload: opts.allowDownload ?? true,
                    password: opts.password ?? null,
                    expiresAt: opts.expiresAt ?? null,
                }),
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            return { error: body?.error ?? `HTTP ${res.status}` };
        }
        const data = await res.json();
        (0, db_1.logActivity)({ id: crypto_1.default.randomUUID(), type: 'share_link_created', message: `Share link: ${data.shareUrl}` });
        if (opts.projectId) {
            const { updateProjectShareInfo } = require('./db');
            updateProjectShareInfo(opts.projectId, data.shareUrl, data.trackingId);
        }
        return { shareUrl: data.shareUrl, trackingId: data.trackingId, reused: data.reused };
    }
    catch (e) {
        captureException(e);
        return { error: e?.message ?? 'Unknown error' };
    }
});
electron_1.ipcMain.handle('share:revokeLink', async (_e, opts) => {
    const storedRaw = store.get('authToken', null);
    if (!storedRaw)
        return { error: 'Not authenticated' };
    let token;
    try {
        token = electron_1.safeStorage.isEncryptionAvailable()
            ? electron_1.safeStorage.decryptString(Buffer.from(storedRaw, 'base64'))
            : storedRaw;
    }
    catch {
        return { error: 'Token decrypt failed' };
    }
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let res;
        try {
            res = await fetch(`${config_1.API_BASE}/desktop/index`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                    'X-Desktop-Action': 'revoke-share-link',
                },
                body: JSON.stringify({ trackingId: opts.trackingId }),
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            return { error: body?.error ?? `HTTP ${res.status}` };
        }
        (0, db_1.logActivity)({ id: crypto_1.default.randomUUID(), type: 'share_link_revoked', message: `Revoked link: ${opts.trackingId}` });
        if (opts.projectId) {
            const { updateProjectShareInfo } = require('./db');
            updateProjectShareInfo(opts.projectId, null, null);
        }
        return { success: true };
    }
    catch (e) {
        captureException(e);
        return { error: e?.message ?? 'Unknown error' };
    }
});
// Folders
electron_1.ipcMain.handle('folders:getAll', () => {
    const folders = store.get('watchedFolders', []);
    // Filter out stale paths (e.g. deleted e2e test dirs) so UI stays clean
    const existing = folders.filter(f => { try {
        return fs_1.default.statSync(f).isDirectory();
    }
    catch {
        return false;
    } });
    if (existing.length !== folders.length)
        store.set('watchedFolders', existing);
    return existing;
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
    // Also remove from excluded paths for this folder
    const excluded = store.get('excludedPaths', []);
    store.set('excludedPaths', excluded.filter((e) => !e.startsWith(folderPath)));
    watcherManager?.removeFolder(folderPath);
});
// Per-folder rescan: run discoverAudioFiles scoped to a single root
electron_1.ipcMain.handle('folders:rescan', async (_e, folderPath) => {
    if (discoveryAbortSignal)
        discoveryAbortSignal.aborted = true;
    const signal = { aborted: false };
    discoveryAbortSignal = signal;
    const excluded = store.get('excludedPaths', []);
    const startMs = Date.now();
    let imported = 0;
    let duplicates = 0;
    const { paths, result } = await (0, discovery_1.discoverAudioFiles)({ roots: [folderPath], extraRoots: [], excludePaths: excluded, maxFiles: 50000, maxDurationMs: 120000, signal }, (progress) => { mainWindow?.webContents.send('discovery:progress', progress); });
    for (const p of paths) {
        if (signal.aborted)
            break;
        if (await checkFileExists(p)) {
            duplicates++;
        }
        else {
            if (await importAudioFile(p))
                imported++;
        }
    }
    discoveryAbortSignal = null;
    const durationMs = Date.now() - startMs;
    // Persist last-scanned timestamp and file count for this folder
    const scanMeta = store.get('folderScanMeta', {});
    scanMeta[folderPath] = { lastScanned: new Date().toISOString(), fileCount: result.found };
    store.set('folderScanMeta', scanMeta);
    mainWindow?.webContents.send('discovery:progress', { phase: 'done', found: result.found, imported, duplicates, scanned: result.scanned, permissionErrors: result.permissionErrors });
    return { found: result.found, imported, duplicates, scanned: result.scanned, permissionErrors: result.permissionErrors, durationMs, cancelled: signal.aborted };
});
// Folder scan metadata (last scanned, file count)
electron_1.ipcMain.handle('folders:scanMeta', () => {
    return store.get('folderScanMeta', {});
});
// Exclude a subfolder from future scans
electron_1.ipcMain.handle('folders:excludePath', (_e, subPath) => {
    const excluded = store.get('excludedPaths', []);
    if (!excluded.includes(subPath)) {
        excluded.push(subPath);
        store.set('excludedPaths', excluded);
    }
});
electron_1.ipcMain.handle('folders:getExcluded', () => store.get('excludedPaths', []));
electron_1.ipcMain.handle('folders:unexcludePath', (_e, subPath) => {
    const excluded = store.get('excludedPaths', []);
    store.set('excludedPaths', excluded.filter((e) => e !== subPath));
});
// File count per indexed folder (fast — counts from DB)
electron_1.ipcMain.handle('folders:fileCounts', () => {
    try {
        const db = require('./db').getDb();
        const folders = store.get('watchedFolders', []);
        const counts = {};
        for (const folder of folders) {
            const row = db.prepare("SELECT COUNT(*) as c FROM files WHERE file_path LIKE ?").get(folder + '%');
            counts[folder] = row?.c ?? 0;
        }
        return counts;
    }
    catch {
        return {};
    }
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
// Active discovery cancellation signal
let discoveryAbortSignal = null;
electron_1.ipcMain.handle('files:discoverAll', async (_e, opts) => {
    // Cancel any in-progress scan
    if (discoveryAbortSignal)
        discoveryAbortSignal.aborted = true;
    const signal = { aborted: false };
    discoveryAbortSignal = signal;
    const startMs = Date.now();
    let imported = 0;
    let duplicates = 0;
    const { paths, result } = await (0, discovery_1.discoverAudioFiles)({
        roots: opts?.roots ?? (0, discovery_1.defaultDiscoveryRoots)(),
        extraRoots: opts?.extraRoots ?? [],
        excludePaths: opts?.excludePaths ?? [],
        maxFiles: opts?.maxFiles ?? 50000,
        maxDurationMs: opts?.maxDurationMs ?? 120000,
        signal,
    }, (progress) => {
        // Send progress to renderer (non-blocking)
        mainWindow?.webContents.send('discovery:progress', progress);
    });
    if (signal.aborted) {
        mainWindow?.webContents.send('discovery:progress', { phase: 'cancelled', found: result.found, scanned: result.scanned });
        return { found: result.found, imported: 0, duplicates: 0, scanned: result.scanned, durationMs: Date.now() - startMs, cancelled: true };
    }
    // Import phase — idempotent per file_path
    mainWindow?.webContents.send('discovery:progress', { phase: 'importing', found: result.found, imported: 0 });
    for (const p of paths) {
        if (signal.aborted)
            break;
        // Check for existing record first (count as duplicate, don't re-import)
        const existingId = await checkFileExists(p);
        if (existingId) {
            duplicates++;
        }
        else {
            const id = await importAudioFile(p);
            if (id)
                imported++;
        }
    }
    discoveryAbortSignal = null;
    const durationMs = Date.now() - startMs;
    mainWindow?.webContents.send('discovery:progress', {
        phase: 'done', found: result.found, imported, duplicates,
        permissionErrors: result.permissionErrors, scanned: result.scanned,
    });
    mainWindow?.webContents.send('watcher:event', { type: 'files_imported', count: imported });
    return {
        found: result.found,
        imported,
        duplicates,
        scanned: result.scanned,
        permissionErrors: result.permissionErrors,
        durationMs,
        cancelled: false,
        limitReached: result.found >= (opts?.maxFiles ?? 50000),
    };
});
electron_1.ipcMain.handle('files:discoverCancel', () => {
    if (discoveryAbortSignal) {
        discoveryAbortSignal.aborted = true;
        discoveryAbortSignal = null;
    }
});
electron_1.ipcMain.handle('files:defaultDiscoveryRoots', () => (0, discovery_1.defaultDiscoveryRoots)());
// Sync
electron_1.ipcMain.handle('sync:getQueue', () => syncAgent?.getQueue() ?? []);
electron_1.ipcMain.handle('sync:retryAll', () => syncAgent?.retryFailed());
electron_1.ipcMain.handle('sync:getStatus', () => syncAgent?.getStatus() ?? 'idle');
electron_1.ipcMain.handle('sync:now', () => { syncAgent?.retryFailed(); syncAgent?.tick?.(); });
// Activity
electron_1.ipcMain.handle('activity:getAll', () => (0, db_1.getActivityLog)(100));
// Shell — open external URL (restricted to known hosts)
electron_1.ipcMain.handle('shell:openExternal', (_e, url) => {
    try {
        const parsed = new URL(url);
        const webBaseHost = new URL(config_1.WEB_BASE).hostname;
        const allowed = ['wavi.stream', 'github.com', 'privy.io', webBaseHost];
        if (parsed.protocol !== 'https:' || !allowed.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`)))
            return;
        electron_1.shell.openExternal(url);
    }
    catch { /* invalid URL */ }
});
// ── Shell helpers ─────────────────────────────────────────────────────────────
const USER_SAFE_PREFIXES = () => [
    electron_1.app.getPath('home'),
    electron_1.app.getPath('music'),
    electron_1.app.getPath('documents'),
    electron_1.app.getPath('desktop'),
];
/**
 * Validate that a path is:
 *  - A string (not a URL or shell command)
 *  - Resolves within user-safe directories
 *  - Actually exists on disk
 *  - Is a file (not a directory) when requireFile=true
 *  - Is indexed in the library when requireIndexed=true
 */
function validateSafePath(p, opts = {}) {
    if (typeof p !== 'string' || p.trim() === '')
        return { ok: false, error: 'Path must be a non-empty string' };
    if (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('file://')) {
        return { ok: false, error: 'URLs are not allowed' };
    }
    if (p.includes(';') || p.includes('&') || p.includes('|') || p.includes('`') || p.includes('$(')) {
        return { ok: false, error: 'Shell metacharacters are not allowed in path' };
    }
    const resolved = path_1.default.resolve(p);
    const safe = USER_SAFE_PREFIXES();
    if (!safe.some(prefix => resolved.startsWith(prefix + path_1.default.sep) || resolved === prefix)) {
        return { ok: false, error: `Path outside safe roots: ${resolved}` };
    }
    let stat;
    try {
        stat = fs_1.default.statSync(resolved);
    }
    catch {
        return { ok: false, error: `File not found or inaccessible: ${resolved}` };
    }
    if (opts.requireFile && stat.isDirectory()) {
        return { ok: false, error: 'Expected a file, not a directory' };
    }
    if (opts.requireIndexed) {
        const indexed = (0, db_1.getFileByPath)(resolved);
        if (!indexed) {
            return { ok: false, error: `File is not in the Wavi library. Add it first before opening.` };
        }
    }
    return { ok: true, resolved };
}
// Shell — open in default OS handler (requires indexed file)
electron_1.ipcMain.handle('shell:openPath', (_e, p) => {
    const v = validateSafePath(p, { requireFile: true });
    if (!v.ok) {
        console.warn('[shell:openPath]', v.error);
        return;
    }
    (0, db_1.logActivity)({ id: crypto_1.default.randomUUID(), type: 'file_opened', message: `Opened: ${path_1.default.basename(v.resolved)}`, metadata: { action: 'openPath' } });
    return electron_1.shell.openPath(v.resolved);
});
// Reveal in Finder/Explorer (requires path in safe location, file or folder)
electron_1.ipcMain.handle('shell:revealInFinder', (_e, p) => {
    const v = validateSafePath(p);
    if (!v.ok) {
        console.warn('[shell:revealInFinder]', v.error);
        return;
    }
    electron_1.shell.showItemInFolder(v.resolved);
});
// Open a file with a specific application (DAW).
// appPath must be a .app bundle (macOS) or .exe (Windows).
// filePath must be indexed in the library.
electron_1.ipcMain.handle('shell:openWithApp', (_e, filePath, appPath) => {
    const fv = validateSafePath(filePath, { requireFile: true, requireIndexed: true });
    if (!fv.ok)
        throw new Error(fv.error);
    // appPath: must exist and be an .app bundle or executable — no shell injection
    if (typeof appPath !== 'string' || appPath.trim() === '')
        throw new Error('appPath must be a non-empty string');
    if (appPath.includes(';') || appPath.includes('&') || appPath.includes('|') || appPath.includes('`')) {
        throw new Error('Shell metacharacters not allowed in appPath');
    }
    try {
        fs_1.default.statSync(appPath);
    }
    catch {
        throw new Error(`DAW application not found: ${appPath}. Update the path in Settings → DAW Applications.`);
    }
    (0, db_1.logActivity)({
        id: crypto_1.default.randomUUID(), type: 'file_opened',
        message: `Opened in DAW: ${path_1.default.basename(fv.resolved)}`,
        metadata: { action: 'openWithApp', daw: path_1.default.basename(appPath) },
    });
    if (process.platform === 'darwin') {
        return new Promise((resolve, reject) => {
            (0, child_process_1.execFile)('open', ['-a', appPath, fv.resolved], (err) => {
                if (err)
                    reject(new Error(`Failed to open in ${path_1.default.basename(appPath)}: ${err.message}`));
                else
                    resolve();
            });
        });
    }
    else {
        return new Promise((resolve, reject) => {
            (0, child_process_1.execFile)(appPath, [fv.resolved], (err) => {
                if (err)
                    reject(new Error(`Failed to launch ${path_1.default.basename(appPath)}: ${err.message}`));
                else
                    resolve();
            });
        });
    }
});
// Pick a DAW application via native file dialog
electron_1.ipcMain.handle('shell:pickApp', async () => {
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: 'Select DAW Application',
        properties: ['openFile'],
        filters: process.platform === 'darwin'
            ? [{ name: 'Applications', extensions: ['app'] }]
            : [{ name: 'Executables', extensions: ['exe'] }],
        defaultPath: process.platform === 'darwin' ? '/Applications' : 'C:\\Program Files',
    });
    return result.canceled ? null : result.filePaths[0];
});
// Diagnostics
electron_1.ipcMain.handle('diagnostics:get', () => {
    const { getDiagnostics } = require('./db');
    const diag = getDiagnostics();
    const config = store.store; // electron-store's full plain-object copy
    // Sanitize: remove auth tokens, full paths in dawPaths (show basename only)
    const dawPaths = config.dawPaths ?? {};
    const sanitizedDawPaths = {};
    for (const [k, v] of Object.entries(dawPaths)) {
        sanitizedDawPaths[k] = typeof v === 'string' ? path_1.default.basename(v) : '';
    }
    return {
        appVersion: electron_1.app.getVersion(),
        arch: process.arch,
        platform: process.platform,
        environment: isDev ? 'development' : 'production',
        userDataPath: electron_1.app.getPath('userData').replace(electron_1.app.getPath('home'), '~'),
        ...diag,
        dbSizeMB: (diag.dbSizeBytes / (1024 * 1024)).toFixed(2),
        indexedRoots: (config.watchedFolders ?? []).map((f) => f.replace(electron_1.app.getPath('home'), '~')),
        sanitizedDawPaths,
        lastSync: config.lastSync ?? null,
        buildDate: new Date().toISOString().slice(0, 10),
    };
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
// Memory — lightweight key-value store for Copilot context/preferences
electron_1.ipcMain.handle('memory:list', () => {
    const entries = store.get('memory', {});
    return Object.entries(entries).map(([key, v]) => ({
        key,
        value: typeof v === 'object' ? v.value : v,
        category: typeof v === 'object' ? (v.category ?? 'note') : 'note',
        createdAt: typeof v === 'object' ? (v.createdAt ?? new Date().toISOString()) : new Date().toISOString(),
        updatedAt: typeof v === 'object' ? (v.updatedAt ?? new Date().toISOString()) : new Date().toISOString(),
    }));
});
electron_1.ipcMain.handle('memory:get', (_e, key) => {
    const entries = store.get('memory', {});
    const v = entries[key];
    return v ? (typeof v === 'object' ? v.value : v) : null;
});
electron_1.ipcMain.handle('memory:set', (_e, key, value, category = 'note') => {
    const entries = store.get('memory', {});
    const existing = entries[key];
    entries[key] = {
        value,
        category,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    store.set('memory', entries);
});
electron_1.ipcMain.handle('memory:delete', (_e, key) => {
    const entries = store.get('memory', {});
    delete entries[key];
    store.set('memory', entries);
});
// App
electron_1.ipcMain.handle('app:relaunch', () => {
    electron_1.app.relaunch();
    electron_1.app.exit(0);
});
