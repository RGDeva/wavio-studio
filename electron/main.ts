import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import { initDatabase, getProjects, getProjectById, getFilesByProject, getAllFiles, searchFiles, getFileStats, getActivityLog, upsertStandaloneFile, upsertFile, logActivity, enqueueSyncItem, getPendingBounceCandidates, resolveBounceCandidate, getBounceCandidateById, createVersion, getVersionsByProject, versionExistsByChecksum, versionExistsByPath, getPendingAssociations, resolveAssociationQueue, confirmAssociation, undoAssociation, updateFileClassificationByPath } from './db';
import { classifyFile as classifyFileV1 } from './projectAssociation/fileClassifier';
import { confirmQueueItem } from './projectAssociation/projectAssociationEngine';
import { detectBpm } from './bpmDetector';
import { analyzeAudio } from './audioAnalyzer';
import { classifyFile } from './classifier';
import crypto from 'crypto';
import { WatcherManager, fileChecksum } from './watcher';
import { SyncAgent } from './syncAgent';
import { initCopilot, unregisterCopilot, toggleOverlay } from './copilot';
import { registerAbletonHandlers } from './ableton';
import { startBridgeServer, stopBridgeServer } from './bridgeServer';
import { initMuseSdk, finalizeMuseSdk, startMuseHubSession, checkAndIncrementUsage, getCachedEntitlement, isMuseHubSession, getMuseHubUserInfo } from './musehub';
import Store from 'electron-store';
import { API_BASE, logApiEnvironment } from './config';
// Sentry is loaded dynamically to avoid crash during module import
// (Sentry's normalize.js calls electron.app.getAppPath() on module load)
let SentryInstance: typeof import('@sentry/electron/main') | null = null;

async function initSentry() {
  try {
    if (process.env.SENTRY_DSN) {
      SentryInstance = await import('@sentry/electron/main');
      SentryInstance.init({ dsn: process.env.SENTRY_DSN });
    }
  } catch {
    // Sentry init failed - continue without error tracking
    SentryInstance = null;
  }
}

// Safe error capture helper
function captureException(err: any) {
  try {
    if (SentryInstance) {
      SentryInstance.captureException(err);
    }
  } catch {
    // Ignore Sentry errors
  }
}

// Main-process diagnostic log file - lazily initialized to avoid calling app.getPath()
// at module load time (app may not be ready yet during certain launch contexts)
let MAIN_LOG: string | null = null;
function getMainLogPath(): string {
  if (!MAIN_LOG) {
    MAIN_LOG = path.join(app.getPath('home'), '.wavi', 'main.log');
  }
  return MAIN_LOG;
}
// Log rotation: max 5MB per file, keep 1 backup
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
function mainLog(msg: string) {
  try {
    const logPath = getMainLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    // Check log size and rotate if needed
    try {
      const stats = fs.statSync(logPath);
      if (stats.size > MAX_LOG_SIZE) {
        // Rotate: move current to backup, start fresh
        const backupPath = logPath + '.old';
        try { fs.renameSync(logPath, backupPath); } catch { /* ignore */ }
      }
    } catch { /* file doesn't exist yet */ }

    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// Prevent any unhandled rejection or exception from crashing the main process
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err?.message ?? err);
  mainLog(`uncaughtException: ${err?.stack ?? err?.message ?? err}`);
  captureException(err);
});
process.on('unhandledRejection', (reason: any) => {
  console.error('[main] unhandledRejection:', reason);
  mainLog(`unhandledRejection: ${reason?.stack ?? reason?.message ?? reason}`);
  captureException(reason);
});

// These will be initialized inside app.whenReady()
let store: Store;
let mainWindow: BrowserWindow | null = null;
let watcherManager: WatcherManager | null = null;
let syncAgent: SyncAgent | null = null;
let tray: Tray | null = null;
let _trayRebuildTimer: ReturnType<typeof setTimeout> | null = null;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../public/icon.png'),
  });

  // Content Security Policy for security — production only.
  // In dev, Vite needs ws:// for HMR and 'unsafe-eval' for module loading, so we skip CSP.
  if (!isDev) {
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://wavi.stream https://*.supabase.co wss://*.supabase.co; img-src 'self' data: https:; media-src 'self' https: blob:; font-src 'self' data:;"]
        }
      });
    });
  }

  // Debug: write renderer logs to file for diagnostics
  const logFile = path.join(app.getPath('userData'), 'renderer.log');
  try { fs.writeFileSync(logFile, `--- Wavi Studio launched ${new Date().toISOString()} ---\n`); } catch {}
  const appendLog = (msg: string) => { try { fs.appendFileSync(logFile, msg + '\n'); } catch {} };
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
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (isDev) {
      mainWindow.loadURL('http://localhost:5173').catch((e) => {
        appendLog(`[renderer] loadURL error: ${e?.message ?? e}`);
      });
    } else {
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html')).catch((e) => {
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
  if (isDev) {
    // Defer devTools to prevent initialization race conditions
    setTimeout(() => { try { mainWindow?.webContents.openDevTools(); } catch {} }, 1500);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Fix recurring "Network service crashed, restarting service" on macOS.
// Must be called before app.whenReady() but after Electron has initialized internals.
// We wrap in a try-catch in case app is not ready yet.
try {
  app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox');
  if (process.env.WAVI_NO_SANDBOX === '1') {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
  }
  if (process.env.WAVI_DEBUG_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.WAVI_DEBUG_PORT);
  }
} catch {
  // commandLine may not be available in all contexts - continue without
}

app.whenReady().then(async () => {
  mainLog('--- main process started ---');
  logApiEnvironment();

  // Initialize store now that app is ready
  store = new Store();

  // Register wavi:// deep-link protocol
  if (!app.isDefaultProtocolClient('wavi')) {
    app.setAsDefaultProtocolClient('wavi');
  }

  // Initialize Sentry error tracking (async to avoid blocking)
  initSentry().catch(() => {});

  // Show window immediately BEFORE any blocking initialization
  // This prevents the "loading spinner of death" from main thread blocking
  createTray();
  createWindow();

  // Defer heavy initialization to next tick so window can render
  await new Promise<void>(resolve => setImmediate(resolve));

  // Init database (this blocks the main thread - must happen after window show)
  mainLog('Initializing database...');
  const t0 = Date.now();
  const db = initDatabase();
  mainLog(`Database initialized in ${Date.now() - t0}ms`);

  // Notify renderer that DB is ready
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('main:ready');
  }

  // Init watcher manager with safe IPC sender
  watcherManager = new WatcherManager(db, (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('watcher:event', event);
      } catch (e) {
        // Window may be closing, ignore
      }
    }
  });

  // Init sync agent with safe IPC sender
  syncAgent = new SyncAgent(db, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('sync:progress', progress);
      } catch (e) {
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
  const loginSettings = app.getLoginItemSettings();
  store.set('autoStart', loginSettings.openAtLogin);

  // Restore auth token from encrypted store so sync agent can operate immediately
  const storedToken = store.get('authToken', null) as string | null;
  if (storedToken) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const token = safeStorage.decryptString(Buffer.from(storedToken, 'base64'));
        syncAgent.setAuthToken(token);
      } else {
        // In dev without encryption, still allow token
        syncAgent.setAuthToken(storedToken);
      }
    } catch (e) {
      console.error('[main] Token restore failed:', e);
      // Token corrupt — user will re-auth
    }
  }

  // Start services — all folder scanning deferred below
  syncAgent.start();
  initCopilot(store);
  registerAbletonHandlers();
  startBridgeServer();

  // MuseHub SDK — initialize if launched from MuseHub
  if (initMuseSdk()) {
    startMuseHubSession(store).then((result) => {
      if (result) {
        mainWindow?.webContents.send('musehub:session', result);
      } else {
        mainWindow?.webContents.send('musehub:error', 'Failed to start MuseHub session. Please log in to MuseHub, then reopen Wavi.');
      }
    }).catch((err) => {
      console.error('[main] MuseHub session error:', err);
    });
  }

  // Defer folder watching + scanning so the window opens without blocking on APFS disk I/O
  setTimeout(() => {
    // Restore watched folders from store
    const folders = store.get('watchedFolders', []) as string[];
    for (const folder of folders) {
      watcherManager!.addFolder(folder);
    }

    // Auto-discover specific DAW project subfolders on first launch.
    // NOTE: ~/Music, ~/Desktop, ~/Downloads are NOT added as root watch paths —
    // scanning those entire trees on machines with large libraries causes OOM → SIGKILL.
    if (!store.get('didAutoDiscover', false)) {
      store.set('didAutoDiscover', true);
      const discovered = discoverDawFolders();
      for (const folder of discovered) {
        const current = store.get('watchedFolders', []) as string[];
        if (!current.includes(folder)) {
          current.push(folder);
          store.set('watchedFolders', current);
          watcherManager!.addFolder(folder);
        }
      }
    }
  }, 3000); // 3 s delay — window is fully rendered before any disk scanning begins

  // Auto-updater disabled until latest-mac.yml is published in GitHub Releases
  // (enabling it without the yml causes an unhandled rejection that crashes the app)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Gracefully close watchers BEFORE Node/Electron tears down — prevents
// fsevents native module SIGABRT on mutex cleanup race.
app.on('before-quit', async (e) => {
  if (watcherManager) {
    e.preventDefault();
    unregisterCopilot();
    finalizeMuseSdk();
    stopBridgeServer();
    syncAgent?.stop();
    await watcherManager.stopAll();
    watcherManager = null as any;
    app.quit();          // re-enter quit now that watchers are closed
  }
});

app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin') {
    try {
      syncAgent?.stop();
      await watcherManager?.stopAll();
    } catch (e) {
      console.error('[main] Error during shutdown:', e);
    }
    app.quit();
  }
});

function createTray() {
  const iconPath = path.join(__dirname, '../public/icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Wavi Studio');
  rebuildTrayMenu();
  tray.on('double-click', () => {
    if (!mainWindow) createWindow();
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const status = syncAgent?.getStatus() ?? 'idle';
  const statusLabel = status === 'idle' ? 'Idle'
    : status === 'paused:auth' ? 'Paused (sign in required)'
    : status === 'paused:limit' ? 'Paused (plan limit)'
    : status.startsWith('uploading') ? `Syncing…`
    : status;

  const menu = Menu.buildFromTemplate([
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
      click: () => toggleOverlay(),
    },
    { type: 'separator' },
    {
      label: 'Open Wavi Studio',
      click: () => {
        if (!mainWindow) createWindow();
        else { mainWindow.show(); mainWindow.focus(); }
      },
    },
    {
      label: 'Open Vault',
      click: () => shell.openExternal('https://wavi.stream/vault'),
    },
    {
      label: 'Upgrade Plan',
      click: () => shell.openExternal('https://wavi.stream/pricing'),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: async () => {
        syncAgent?.stop();
        await watcherManager?.stopAll();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// Deep-link: wavi://auth?token=wv_...
// macOS: open-url fires when app is already running
app.on('open-url', (_event, url) => {
  void handleDeepLink(url);
});

// Windows/Linux: second-instance fires with argv containing the URL
app.on('second-instance', (_event, argv) => {
  const url = argv.find(arg => arg.startsWith('wavi://'));
  if (url) void handleDeepLink(url);
  // Focus existing window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Exchange a short-lived Privy JWT for a persistent wv_ desktop token.
// Returns the wv_ token on success, null on failure.
async function exchangePrivyJwt(privyJwt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/desktop/index`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${privyJwt}`,
          'X-Desktop-Action': 'create-desktop-token',
        },
        body: JSON.stringify({ deviceLabel: `Wavi Studio — ${require('os').hostname()}` }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      mainLog(`[auth] Token exchange HTTP ${res.status}`);
      return null;
    }
    const data: { token?: string; expiresAt?: string } = await res.json();
    if (!data?.token?.startsWith('wv_')) {
      mainLog('[auth] Token exchange: unexpected response shape');
      return null;
    }
    return data.token;
  } catch (e: any) {
    mainLog(`[auth] Token exchange error: ${e?.message ?? e}`);
    captureException(e);
    return null;
  }
}

async function handleDeepLink(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wavi:') return;
    if (parsed.hostname !== 'auth') return;

    const rawToken = parsed.searchParams.get('token');
    if (!rawToken || rawToken.length < 10) return;

    let finalToken: string;

    if (rawToken.startsWith('wv_')) {
      // Already a desktop token (future-proof for direct wv_ deep links)
      finalToken = rawToken;
    } else {
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
    const toStore = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(finalToken).toString('base64')
      : finalToken;
    store.set('authToken', toStore);
    syncAgent?.setAuthToken(finalToken);
    // Signal renderer that auth succeeded; send token so renderer can set authed=true.
    // The renderer does NOT store the token on disk — that is main process responsibility.
    mainWindow?.webContents.send('auth:token-received', finalToken);
    rebuildTrayMenu();
  } catch (e) {
    captureException(e);
    mainLog(`[auth] handleDeepLink error: ${(e as any)?.message ?? e}`);
  }
}

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.aiff', '.aif', '.flac', '.m4a', '.ogg', '.aac']);

/** Import a single audio file into the library (for drag-drop / manual add). */
async function importAudioFile(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) return null;

  let stats: fs.Stats;
  try { stats = fs.statSync(filePath); } catch { return null; }

  const now = new Date().toISOString();
  const fileId = crypto.randomUUID();
  const fileName = path.basename(filePath);
  const role = classifyFile(fileName);
  
  // Calculate SHA-256 checksum
  const checksum = await fileChecksum(filePath);

  // Insert immediately so it shows in Library
  const id = upsertStandaloneFile({
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
  enqueueSyncItem({
    id: crypto.randomUUID(),
    project_id: '__standalone__',
    file_id: id,
    file_name: fileName,
    type: 'dependency_upload',
    priority: 3,
    created_at: now,
  });

  // Async: analyze BPM + key
  Promise.all([
    detectBpm(filePath).catch(() => null),
    analyzeAudio(filePath).catch(() => null),
  ]).then(([bpm, analysis]) => {
    if (bpm || analysis?.key || analysis?.duration) {
      upsertStandaloneFile({
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
      const parts: string[] = [];
      if (bpm) parts.push(`${bpm} BPM`);
      if (analysis?.key) parts.push(analysis.key);
      if (role !== 'unknown') parts.push(role);
      logActivity({
        id: crypto.randomUUID(),
        type: 'file_analyzed',
        message: `${fileName}: ${parts.join(' · ')}`,
        metadata: { filePath, bpm, key: analysis?.key, duration: analysis?.duration, role },
      });
    }
  });

  logActivity({
    id: crypto.randomUUID(),
    type: 'file_imported',
    message: `Imported: ${fileName}`,
    metadata: { filePath, fileSize: stats.size },
  });

  return id;
}

/** Scan a directory for audio files (non-recursive, fast). */
function scanDirForAudioFiles(dirPath: string, maxFiles = 200): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTENSIONS.has(ext)) {
        results.push(path.join(dirPath, entry.name));
      }
    }
  } catch { /* unreadable dir */ }
  return results;
}

/** Scan well-known DAW default save locations and return those that exist. */
function discoverDawFolders(): string[] {
  const home = app.getPath('home');
  const music = app.getPath('music');
  const docs = app.getPath('documents');
  const desktop = app.getPath('desktop');
  const candidates = [
    // FL Studio — multiple known paths
    path.join(docs, 'Image-Line', 'FL Studio', 'Projects'),
    path.join(docs, 'Image-Line', 'FL Studio'),
    path.join(docs, 'Image-Line', 'FL Studio', 'Backup'),
    path.join(home, 'Image-Line', 'FL Studio', 'Projects'),
    // Pro Tools — session folders
    path.join(docs, 'Pro Tools'),
    path.join(home, 'Documents', 'Pro Tools'),
    path.join(music, 'Pro Tools'),
    path.join(desktop, 'Pro Tools'),
    // Ableton Live
    path.join(music, 'Ableton'),
    path.join(docs, 'Ableton'),
    path.join(music, 'Ableton', 'User Library'),
    // Logic Pro
    path.join(music, 'Logic'),
    path.join(docs, 'Logic'),
    path.join(music, 'Music', 'Logic'),
    // Reaper
    path.join(docs, 'REAPER Media'),
    path.join(docs, 'Reaper Projects'),
    // GarageBand
    path.join(music, 'GarageBand'),
    // Cubase / Nuendo
    path.join(docs, 'Cubase Projects'),
    path.join(docs, 'Nuendo Projects'),
    // Studio One
    path.join(docs, 'Studio One'),
    path.join(docs, 'PreSonus', 'Studio One'),
    // Adobe Audition
    path.join(docs, 'Adobe', 'Audition'),
    // Bitwig Studio
    path.join(docs, 'Bitwig Studio'),
    path.join(music, 'Bitwig Studio'),
    // Reason
    path.join(docs, 'Reason'),
    path.join(music, 'Reason'),
    // NOTE: `music` (~/Music root) is intentionally excluded — adding the entire
    // ~/Music tree as a watch path OOM-kills the process on large libraries.
    // Users can add specific folders via the folder picker in Settings.
  ];

  const found = candidates.filter(p => {
    try { return require('fs').statSync(p).isDirectory(); } catch { return false; }
  });

  // Also scan top-level Desktop and Music for folders containing .ptx/.ptf/.flp files
  // (many producers save sessions directly on desktop or in ~/Music)
  for (const scanDir of [desktop, music]) {
    try {
      const entries = require('fs').readdirSync(scanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const fullPath = path.join(scanDir, entry.name);
        if (found.includes(fullPath)) continue;
        // Check if folder contains any DAW project files at depth 1
        try {
          const subEntries = require('fs').readdirSync(fullPath);
          const hasDawFile = subEntries.some((f: string) => {
            const ext = path.extname(f).toLowerCase();
            return ['.ptx', '.ptf', '.flp', '.als', '.logicx', '.rpp', '.cpr', '.band', '.sesx', '.song', '.reason', '.bwproject', '.npr'].includes(ext);
          });
          if (hasDawFile) found.push(fullPath);
        } catch { /* skip unreadable dirs */ }
      }
    } catch { /* skip */ }
  }

  return found;
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

// Auth — token encrypted at rest via safeStorage
ipcMain.handle('auth:getToken', () => {
  const raw = store.get('authToken', null) as string | null;
  if (!raw) return null;
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
      : raw;
  } catch { return null; }
});
ipcMain.handle('auth:setToken', (_e, token: string) => {
  const toStore = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token).toString('base64')
    : token;
  store.set('authToken', toStore);
  syncAgent?.setAuthToken(token);
});
ipcMain.handle('auth:clearToken', () => {
  store.delete('authToken');
  syncAgent?.setAuthToken(null);
});

// Share links — create or retrieve a share link for a synced asset
ipcMain.handle('share:createLink', async (_e, opts: {
  assetId: string;
  allowDownload?: boolean;
  password?: string;
  expiresAt?: string;
}) => {
  // Read the decrypted token from the secure store (same as startup restoration)
  const storedRaw = store.get('authToken', null) as string | null;
  if (!storedRaw) return { error: 'Not authenticated' };
  let token: string;
  try {
    token = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(storedRaw, 'base64'))
      : storedRaw;
  } catch { return { error: 'Token decrypt failed' }; }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(`https://wavi.stream/api/desktop/index`, {
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
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as any;
      return { error: body?.error ?? `HTTP ${res.status}` };
    }
    const data = await res.json() as { shareUrl: string; trackingId: string; reused: boolean };
    logActivity({ id: crypto.randomUUID(), type: 'share_link_created', message: `Share link: ${data.shareUrl}` });
    return { shareUrl: data.shareUrl, trackingId: data.trackingId, reused: data.reused };
  } catch (e: any) {
    captureException(e);
    return { error: e?.message ?? 'Unknown error' };
  }
});

// Folders
ipcMain.handle('folders:getAll', () => {
  return store.get('watchedFolders', []);
});

ipcMain.handle('folders:discover', () => {
  return new Promise<string[]>((resolve) => {
    setImmediate(() => resolve(discoverDawFolders()));
  });
});

ipcMain.handle('folders:addPath', (_e, folderPath: string) => {
  const folders = store.get('watchedFolders', []) as string[];
  if (!folders.includes(folderPath)) {
    folders.push(folderPath);
    store.set('watchedFolders', folders);
    watcherManager?.addFolder(folderPath);
  }
  return folderPath;
});

ipcMain.handle('folders:add', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: 'Select DAW Project Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;

  const folderPath = result.filePaths[0];
  const folders = store.get('watchedFolders', []) as string[];
  if (!folders.includes(folderPath)) {
    folders.push(folderPath);
    store.set('watchedFolders', folders);
    watcherManager?.addFolder(folderPath);
  }
  return folderPath;
});

ipcMain.handle('folders:remove', (_e, folderPath: string) => {
  const folders = store.get('watchedFolders', []) as string[];
  const updated = folders.filter((f) => f !== folderPath);
  store.set('watchedFolders', updated);
  watcherManager?.removeFolder(folderPath);
});

// Projects
ipcMain.handle('projects:getAll', () => getProjects());
ipcMain.handle('projects:getById', (_e, id: string) => getProjectById(id));
ipcMain.handle('projects:getDemoStatus', (_e, projectId: string) => {
  const db = require('./db').getDb() as import('better-sqlite3').Database;
  const project = getProjectById(projectId) as any;
  if (!project) return null;

  const flpDetected = !!(project.file_path && project.file_path.endsWith('.flp'));

  // Has at least one export-folder audio file associated
  const bounceRow = db.prepare(
    "SELECT * FROM bounce_candidates WHERE project_id = ? ORDER BY detected_at DESC LIMIT 1"
  ).get(projectId) as any;

  // Latest confirmed version
  const latestVersion = db.prepare(
    "SELECT * FROM versions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(projectId) as any;

  // Latest sync queue item for this project
  const latestSync = db.prepare(
    "SELECT * FROM sync_queue WHERE project_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(projectId) as any;

  // Export folder path (derive from bounce candidate or scan directory)
  const exportFolderDetected = !!bounceRow;
  const exportFolderPath = bounceRow ? require('path').dirname(bounceRow.file_path) : null;

  // Files in project with their sync status
  const syncedFiles = db.prepare(
    "SELECT COUNT(*) as count FROM files WHERE project_id = ? AND sync_status = 'synced'"
  ).get(projectId) as any;
  const totalFiles = db.prepare(
    "SELECT COUNT(*) as count FROM files WHERE project_id = ?"
  ).get(projectId) as any;

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
ipcMain.handle('files:getByProject', (_e, projectId: string) => getFilesByProject(projectId));
ipcMain.handle('files:getAll', (_e, limit?: number, offset?: number) => getAllFiles(limit ?? 500, offset ?? 0));
ipcMain.handle('files:search', (_e, query: string) => searchFiles(query));
ipcMain.handle('files:stats', () => getFileStats());

// Files — import (drag-drop, manual add)
ipcMain.handle('files:import', async (_e, filePaths: string[]) => {
  const imported: string[] = [];
  for (const p of filePaths) {
    const id = await importAudioFile(p);
    if (id) imported.push(id);
  }
  mainWindow?.webContents.send('watcher:event', { type: 'files_imported', count: imported.length });
  return imported;
});

ipcMain.handle('files:addViaDialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'multiSelections'],
    title: 'Add Audio Files',
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'aiff', 'aif', 'flac', 'm4a', 'ogg', 'aac'] }],
  });
  if (result.canceled || !result.filePaths.length) return [];
  const imported: string[] = [];
  for (const p of result.filePaths) {
    const id = await importAudioFile(p);
    if (id) imported.push(id);
  }
  mainWindow?.webContents.send('watcher:event', { type: 'files_imported', count: imported.length });
  return imported;
});

// Sync
ipcMain.handle('sync:getQueue', () => syncAgent?.getQueue() ?? []);
ipcMain.handle('sync:retryAll', () => syncAgent?.retryFailed());
ipcMain.handle('sync:getStatus', () => syncAgent?.getStatus() ?? 'idle');
ipcMain.handle('sync:now', () => { syncAgent?.retryFailed(); syncAgent?.tick?.(); });

// Activity
ipcMain.handle('activity:getAll', () => getActivityLog(100));

// Shell — open external URL (restricted to wavi.stream)
ipcMain.handle('shell:openExternal', (_e, url: string) => {
  try {
    const parsed = new URL(url);
    const allowed = ['wavi.stream', 'github.com', 'privy.io'];
    if (parsed.protocol !== 'https:' || !allowed.some(h => parsed.hostname.endsWith(h))) return;
    shell.openExternal(url);
  } catch { /* invalid URL */ }
});

// Shell — only allow opening paths under common safe locations
ipcMain.handle('shell:openPath', (_e, p: string) => {
  const safePrefixes = [app.getPath('home'), app.getPath('music'), app.getPath('documents')];
  const resolved = path.resolve(p);
  if (!safePrefixes.some(prefix => resolved.startsWith(prefix))) return;
  return shell.openPath(resolved);
});

// Settings
ipcMain.handle('settings:get', (_e, key: string) => store.get(key));
ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
  store.set(key, value);
  // Wire autoStart to macOS login item
  if (key === 'autoStart') {
    app.setLoginItemSettings({ openAtLogin: !!value, openAsHidden: true });
  }
});

// Bounce candidates — version confirmation flow
ipcMain.handle('bounces:getPending', () => getPendingBounceCandidates());
ipcMain.handle('bounces:resolve', async (_e, id: string, action: string) => {
  // Resolve the candidate status first
  resolveBounceCandidate(id, action as any);

  if (action !== 'confirmed' && action !== 'master' && action !== 'stem') return;

  // Fetch candidate from DB (already resolved above)
  const c = getBounceCandidateById(id);
  if (!c) return;

  const label = action === 'master' ? 'master' : action === 'stem' ? 'stem' : 'bounce';
  const now = new Date().toISOString();

  // Ensure the file exists on disk
  if (!fs.existsSync(c.file_path)) {
    logActivity({ id: crypto.randomUUID(), type: 'sync_error',
      message: `Cannot create version: file not found: ${c.file_name}`,
      project_id: c.project_id ?? undefined });
    return;
  }

  // Ensure we have a files row for this bounce (needed for syncAgent.syncFile)
  const existingFiles = c.project_id ? (getFilesByProject(c.project_id) as any[]) : [];
  let fileRow = existingFiles.find((f: any) => f.file_path === c.file_path);
  if (!fileRow) {
    const fid = crypto.randomUUID();
    const ext = c.file_path.split('.').pop() ?? 'wav';
    upsertFile({
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
  const projectId = c.project_id as string | null;
  if (projectId) {
    if (c.checksum && versionExistsByChecksum(projectId, c.checksum)) {
      mainWindow?.webContents.send('watcher:event', { type: 'version_created', projectId });
      return;
    }
    if (versionExistsByPath(projectId, c.file_path)) {
      mainWindow?.webContents.send('watcher:event', { type: 'version_created', projectId });
      return;
    }
  }

  const versionId = crypto.randomUUID();
  if (projectId) {
    createVersion({
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

  enqueueSyncItem({
    id: crypto.randomUUID(),
    project_id: projectId ?? '__standalone__',
    file_id: fileRow.id,
    file_name: c.file_name,
    type: 'dependency_upload',
    priority: 9,
    created_at: now,
  });

  logActivity({
    id: crypto.randomUUID(),
    type: 'version_created',
    message: `New ${label} version: ${c.file_name}`,
    project_id: projectId ?? undefined,
    metadata: { filePath: c.file_path, label, versionId },
  });

  // Kick the sync agent immediately
  syncAgent?.tick();

  mainWindow?.webContents.send('watcher:event', { type: 'version_created', projectId });
});
ipcMain.handle('versions:getByProject', (_e, projectId: string) => getVersionsByProject(projectId));

// Association Engine IPC
ipcMain.handle('association:getPending', () => {
  return getPendingAssociations(50);
});

ipcMain.handle('association:confirm', (_e, queueId: string, projectName?: string) => {
  // Fetch the queue item so we can write asset_associations for every file pair
  const db = require('./db').getDb() as import('better-sqlite3').Database;
  const row = db.prepare('SELECT file_ids, relationship, confidence FROM association_queue WHERE id = ?').get(queueId) as
    { file_ids: string; relationship: string; confidence: number } | undefined;

  resolveAssociationQueue(queueId, 'confirmed');

  if (row) {
    try {
      const fileIds = JSON.parse(row.file_ids) as string[];
      confirmQueueItem(db, queueId, fileIds, row.relationship as any, row.confidence);
    } catch { /* non-fatal — association rows are best-effort */ }
  }

  logActivity({
    id: crypto.randomUUID(),
    type: 'association_confirmed',
    message: `Confirmed association${projectName ? `: ${projectName}` : ''}`,
    metadata: { queueId, projectName },
  });
  return { ok: true };
});

ipcMain.handle('association:reject', (_e, queueId: string) => {
  resolveAssociationQueue(queueId, 'rejected');
  logActivity({
    id: crypto.randomUUID(),
    type: 'association_rejected',
    message: `Rejected association: ${queueId}`,
    metadata: { queueId },
  });
  return { ok: true };
});

ipcMain.handle('association:undo', (_e, associationId: string) => {
  undoAssociation(associationId);
  logActivity({
    id: crypto.randomUUID(),
    type: 'association_undone',
    message: `Undid association: ${associationId}`,
    metadata: { associationId },
  });
  return { ok: true };
});

ipcMain.handle('association:classifyFile', (_e, filePath: string) => {
  try {
    const stat = fs.statSync(filePath);
    const result = classifyFileV1(filePath, stat);
    updateFileClassificationByPath(filePath, {
      classifier_role:       result.role,
      classifier_confidence: result.confidence,
      name_tokens:           JSON.stringify(result.tokens),
    });
    return result;
  } catch (err) {
    return { error: String(err) };
  }
});

// Bridge status
ipcMain.handle('bridge:getStatus', () => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const tokenPath = path.join(os.homedir(), '.wavi', 'bridge-token');
  const tokenExists = fs.existsSync(tokenPath);
  let tokenPerm = '';
  try {
    tokenPerm = (fs.statSync(tokenPath).mode & 0o777).toString(8);
  } catch { /* ignore */ }
  const { BRIDGE_PORT, BRIDGE_HOST, getBridgeToken } = require('./bridgeServer') as typeof import('./bridgeServer');
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
ipcMain.handle('musehub:isSession', () => isMuseHubSession());
ipcMain.handle('musehub:getUserInfo', () => getMuseHubUserInfo());
ipcMain.handle('musehub:getEntitlement', () => getCachedEntitlement(store));
ipcMain.handle('musehub:checkUsage', async () => {
  return checkAndIncrementUsage(store);
});
ipcMain.handle('musehub:refreshSession', async () => {
  const result = await startMuseHubSession(store);
  return result;
});

// Memory — lightweight key-value store for Copilot context/preferences
ipcMain.handle('memory:list', () => {
  const entries = store.get('memory', {}) as Record<string, any>;
  return Object.entries(entries).map(([key, v]) => ({
    key,
    value: typeof v === 'object' ? v.value : v,
    category: typeof v === 'object' ? (v.category ?? 'note') : 'note',
    createdAt: typeof v === 'object' ? (v.createdAt ?? new Date().toISOString()) : new Date().toISOString(),
    updatedAt: typeof v === 'object' ? (v.updatedAt ?? new Date().toISOString()) : new Date().toISOString(),
  }));
});
ipcMain.handle('memory:get', (_e, key: string) => {
  const entries = store.get('memory', {}) as Record<string, any>;
  const v = entries[key];
  return v ? (typeof v === 'object' ? v.value : v) : null;
});
ipcMain.handle('memory:set', (_e, key: string, value: string, category = 'note') => {
  const entries = store.get('memory', {}) as Record<string, any>;
  const existing = entries[key];
  entries[key] = {
    value,
    category,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.set('memory', entries);
});
ipcMain.handle('memory:delete', (_e, key: string) => {
  const entries = store.get('memory', {}) as Record<string, any>;
  delete entries[key];
  store.set('memory', entries);
});

// App
ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});
