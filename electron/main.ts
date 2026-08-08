import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { initDatabase, getProjects, getProjectById, getFilesByProject, getAllFiles, searchFiles, getFileStats, getActivityLog, upsertStandaloneFile, upsertFile, logActivity, enqueueSyncItem, getPendingBounceCandidates, resolveBounceCandidate, getBounceCandidateById, createVersion, getVersionsByProject, versionExistsByChecksum, versionExistsByPath, getPendingAssociations, resolveAssociationQueue, confirmAssociation, undoAssociation, updateFileClassificationByPath, getFileByPath, insertRestoredProject, getRestoredProjectByShare, touchRestoredProject, classifyFailedRowsForProject } from './db';
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
import { API_BASE, WEB_BASE, logApiEnvironment, CHANNEL, PROTOCOL_SCHEME, BUNDLE_ID } from './config';
import { validateDeepLink, checkAndRecordReplay, isQaBuildFromPackageJson, APP_NAMES, assertNotProductionUserDataDir } from './deepLinkValidator';
import { getAdapterForProject } from './adapters';
import { safeRelativePath, classifyFileRole, findPreviewCandidate, ManifestEntry } from './adapters/common';
import { discoverAudioFiles, defaultDiscoveryRoots, AUDIO_EXTS as DISCOVERY_AUDIO_EXTS, classifyFolderForImport, FolderClassification } from './discovery';
import { registerWaviMediaPrivileges, registerWaviMediaProtocol } from './mediaProtocolRegister';
import {
  listProjectLinksAll, createProjectLinkFlow, revokeProjectLinkFlow, planReconciliation,
  buildDesktopEndpoint, toRendererAccountHandle, createLinkOpsCoordinator, normalizeCreateKey,
  type DesktopResponse, type ProjectLinkServiceDeps,
} from './projectLinkService';

// Server-authoritative account DID (Privy) for the active session; scopes the
// Project Link cache. Set on any authenticated PL response, cleared on logout.
let currentAccountId: string | null = null;
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

// Is this a QA-channel build? Determined from the package.json baked into
// THIS build (electron-builder.qa.json's extraMetadata.waviQaDefaults) —
// available synchronously, independent of any env var or app.whenReady()
// timing. This must NOT depend on WAVI_USER_DATA_DIR/WAVI_QA_OVERRIDE env
// vars: a real macOS-routed cold launch (double-click, or routing a
// wavi-qa:// callback to a non-running app) does not inherit terminal env
// vars, so relying on them here previously caused a QA build to silently
// fall through to the PRODUCTION userData directory and overwrite the real
// app's stored auth token. See incident note in deepLinkValidator.ts.
const isQaBuild = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return isQaBuildFromPackageJson(require('../package.json'));
  } catch {
    return false;
  }
})();

// ── Dev / QA / prod data isolation ───────────────────────────────────────────
// MUST happen before app.whenReady() — Electron resolves userData from appName
// at first access. Changing the name here routes each build to its own
// directory:
//   production: ~/Library/Application Support/wavio-studio
//   QA:         ~/Library/Application Support/wavio-studio-qa
//   dev:        ~/Library/Application Support/wavio-studio-dev
//
// This prevents QA/dev builds from ever writing into the production DB,
// watched folders, or auth token — and prevents prod from seeing test data —
// regardless of how the process was launched (terminal with env vars, or a
// real OS-routed cold launch with none).
if (isDev) {
  // app.name must be set before any call to app.getPath('userData').
  // electron-store reads userData during construction, so this runs first.
  app.setName(APP_NAMES.development);
} else if (isQaBuild) {
  app.setName(APP_NAMES.qa);
}

// ── QA user-data override ────────────────────────────────────────────────────
// Lets a packaged build run against a disposable userData directory for E2E
// testing without touching a real install's projects/auth/settings.
// Gated on BOTH env vars so a normal double-click launch (no inherited shell
// env) can never trigger this — it only fires when explicitly launched from a
// terminal with both vars set, e.g.:
//   WAVI_USER_DATA_DIR=/tmp/wavi-studio-beta-e2e WAVI_QA_OVERRIDE=1 \
//     "/path/to/Wavi Studio.app/Contents/MacOS/Wavi Studio"
if (process.env.WAVI_USER_DATA_DIR && (isDev || process.env.WAVI_QA_OVERRIDE === '1')) {
  app.setPath('userData', process.env.WAVI_USER_DATA_DIR);
}

// ── Last-resort production-data-isolation safety net ────────────────────────
// app.setName() above should already guarantee a non-production build never
// resolves to the production userData directory — but after the incident
// where that protection was missing for QA builds, this is a hard, fatal
// assertion as defense in depth: if a non-production build's resolved
// userData directory EVER equals the production directory, refuse to start
// rather than risk reading or writing real user data.
{
  const resolvedChannel: 'production' | 'qa' | 'development' = isDev ? 'development' : isQaBuild ? 'qa' : 'production';
  const productionUserDataDir = path.join(app.getPath('appData'), APP_NAMES.production);
  const isolationError = assertNotProductionUserDataDir({
    channel: resolvedChannel,
    resolvedUserDataDir: app.getPath('userData'),
    productionUserDataDir,
  });
  if (isolationError) {
    mainLog(isolationError);
    console.error(isolationError);
    dialog.showErrorBox('Wavi Studio — startup aborted', isolationError);
    app.quit();
    process.exit(1);
  }
}

// ── Single-instance lock ─────────────────────────────────────────────────────
// Without this, every launch (including the OS routing a wavi:// callback)
// can spawn a brand-new process instead of focusing the already-running one.
// That was a root cause of deep links silently going nowhere: macOS would
// hand the callback to a fresh, windowless instance whose 'open-url' handler
// fired before mainWindow existed, then that instance exited.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // app.quit() schedules an async quit — it does NOT halt synchronous
  // execution. Without exiting immediately, this losing process's module
  // continues running: app.whenReady().then(...) below still gets
  // registered, and 'ready' can fire before quit() actually terminates the
  // process. That raced a second _initDatabaseAtPath() open against the
  // SAME db file as the real (lock-holding) instance, intermittently
  // causing pending migrations to silently lose to SQLITE_BUSY (swallowed
  // by the try/catch as "already exists") — observed as a recurring
  // "no such column: local_status" error. Exit synchronously, before any
  // further module code (including the whenReady registration) can run.
  app.quit();
  process.exit(0);
}

// ── Sanitized auth logging ───────────────────────────────────────────────────
// Never log ANY characters from a token/JWT/cookie/auth header — not even a
// short prefix. Only event names, the resolved channel, token type/length,
// and other non-reversible metadata may be logged.
function describeToken(token: string | null | undefined): { tokenType: string; tokenLength: number } | { tokenType: 'none' } {
  if (!token) return { tokenType: 'none' };
  return { tokenType: token.startsWith('wv_') ? 'desktop' : 'privy-jwt', tokenLength: token.length };
}
function authLog(event: string, fields: Record<string, unknown> = {}) {
  mainLog(`[auth] ${event} ${JSON.stringify({ channel: CHANNEL, ...fields })}`);
}

// ── Cold-launch deep link queuing ────────────────────────────────────────────
// On macOS, 'open-url' can fire before app.whenReady() resolves and before
// mainWindow exists (cold launch via custom protocol). Previously the handler
// just did `mainWindow?.webContents.send(...)`, which silently no-ops with no
// window — the callback was dropped. Now we queue it and drain exactly once
// after DB + window + IPC are all ready.
let pendingDeepLinkUrl: string | null = null;
let appFullyReady = false;
const processedDeepLinkUrls = new Set<string>(); // replay guard

function queueOrHandleDeepLink(url: string) {
  // Route project deep links directly — they don't need the auth queue.
  // Supports both wavi://open-project/:token and wavi://open-project?share=:token
  if (url.includes('://open-project')) {
    queueOrHandleOpenProject(url);
    return;
  }
  authLog('deep-link-received', { appFullyReady });
  if (!appFullyReady) {
    pendingDeepLinkUrl = url;
    return;
  }
  void handleDeepLink(url);
}

// Cold launch on macOS via custom protocol.
app.on('open-url', (event, url) => {
  event.preventDefault();
  queueOrHandleDeepLink(url);
});

// Windows/Linux cold launch passes the URL as an argv entry.
const argvDeepLink = process.argv.find((arg) => arg.includes('://auth/callback') || arg.includes('://auth?'));
if (argvDeepLink) {
  pendingDeepLinkUrl = argvDeepLink;
}

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
      // Preload runs in a restricted sandbox where require('../package.json')
      // does not reliably resolve the same way it does in the main process
      // (this previously caused preload to silently compute channel=
      // "production" even when main correctly resolved "qa" — see git
      // history). Pass main's already-correct values explicitly instead of
      // having preload re-derive them independently.
      additionalArguments: [`--wavi-channel=${CHANNEL}`, `--wavi-api-base=${API_BASE}`],
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
          // http://127.0.0.1:47821 = local bridge server (health checks from renderer)
          'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://wavi.stream https://*.supabase.co wss://*.supabase.co http://127.0.0.1:47821; img-src 'self' data: https:; media-src 'self' https: blob:; font-src 'self' data:;"]
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
  if (isDev && process.env.WAVI_DEVTOOLS === '1') {
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

// wavi-media:// must be declared privileged before the app becomes ready.
// (Module scope executes before app.whenReady() resolves.) The request handler
// itself is installed after the DB is initialized, inside whenReady below.
registerWaviMediaPrivileges();

app.whenReady().then(async () => {
  mainLog('--- main process started ---');
  logApiEnvironment();

  // Initialize store now that app is ready
  store = new Store();

  // Register this build's channel-specific deep-link protocol scheme.
  // production -> wavi://, qa -> wavi-qa://, development -> wavi-dev://.
  // Each channel is a distinct macOS bundle id (see config.ts BUNDLE_ID), so
  // registering only PROTOCOL_SCHEME here means a QA build never claims the
  // production wavi:// scheme and vice versa.
  if (!app.isDefaultProtocolClient(PROTOCOL_SCHEME)) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }
  authLog('protocol-registered', { scheme: PROTOCOL_SCHEME, bundleId: BUNDLE_ID });

  // Initialize Sentry error tracking (async to avoid blocking)
  initSentry().catch(() => {});

  // E2E isolation mode
  if (process.env.WAVI_E2E === '1') {
    console.warn('[E2E] Isolated test mode: DB=wavio-studio-e2e.db, watching only E2E folder');
  }

  // Step 1-3: Initialize DB + run all schema migrations synchronously.
  // better-sqlite3 is fast (<100ms on existing DBs) so we do this before showing
  // the window — that way any IPC calls the renderer fires at mount time are safe.
  mainLog('Initializing database...');
  const t0 = Date.now();
  const db = initDatabase({ dbName: process.env.WAVI_E2E === '1' ? 'wavio-studio-e2e.db' : 'wavio-studio.db' });
  mainLog(`Database initialized in ${Date.now() - t0}ms`);

  // Secure local bounce playback (wavi-media://asset/{projectId}/{assetId}).
  // Authorization source is the local files table; approved roots are the
  // user's watched folders. Works in dev and packaged builds.
  registerWaviMediaProtocol({
    db,
    getApprovedRoots: () => (store.get('watchedFolders', []) as string[]),
    log: (event, data) => authLog(event, data),
  });

  // Step 4: Initialize watcher manager with safe IPC sender
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

  // Step 4 (cont): Start services — all folder scanning deferred below
  const storedMaxConcurrent = store.get('maxConcurrent', 2) as number;
  syncAgent.setMaxConcurrent(storedMaxConcurrent);
  // D2: restore a persisted user pause BEFORE start() so no upload slips
  // through between startup and the pause taking effect. Applies only the
  // user pause — auth/limit pauses are re-derived from live state.
  if (store.get('syncPausedByUser', false)) {
    syncAgent.pauseUser();
    mainLog('[sync] restored user pause from settings');
  }
  syncAgent.start();
  // Phase H: Copilot project tools — deps injected here to avoid circular
  // imports; every invocation is audit-logged to activity_log.
  {
    const { buildProjectTools } = require('./copilotTools');
    const { registerProjectTools } = require('./agentLoop');
    const dbMod = require('./db');
    registerProjectTools(buildProjectTools({
      isAuthenticated: () => !!getDecryptedToken(),
      logAudit: (entry: { tool: string; params: Record<string, unknown>; outcome: string }) => {
        try {
          logActivity({
            id: crypto.randomUUID(), type: 'copilot_tool',
            message: `Copilot tool ${entry.tool}: ${entry.outcome}`,
            metadata: { tool: entry.tool, params: entry.params, outcome: entry.outcome },
          });
        } catch { /* audit must never break the tool */ }
      },
      searchFiles: (q: string, limit: number) => dbMod.searchFiles(q, limit) as any[],
      openPath: (p: string) => { void shell.openPath(p); },
      fileExists: (p: string) => fs.existsSync(p),
      getSyncStatus: () => syncAgent?.getStatus() ?? 'idle',
      getQueueCounts: () => dbMod.getSyncQueueCounts(),
      prioritizeProject: (projectId: string, force?: boolean) => {
        // Same contract as the sync:prioritizeProject IPC handler: large
        // failed-retry batches need explicit confirmation before running.
        if (!syncAgent) return { needsConfirmation: false as const, bumped: 0, requeued: 0, blockedPermanent: 0, skippedMissing: 0 };
        if (!force) {
          const { retryable } = classifyFailedRowsForProject(projectId);
          if (retryable.length > RETRY_CONFIRM_THRESHOLD) return { needsConfirmation: true as const, retryCount: retryable.length };
        }
        return { needsConfirmation: false as const, ...syncAgent.prioritizeProject(projectId) };
      },
      publishVersion: async (localProjectId: string) => (await doPublishVersion({ localProjectId })) as any,
      // P3-3 deterministic inspection deps. All read-only or main-process-resolved;
      // reveal is confirmation-gated in the envelope. The full filesystem path is
      // resolved and used ONLY here — never returned to the tool or the model.
      revealFileById: (projectId: string, fileId: string) => {
        try {
          const rows = getFilesByProject(projectId) as any[];
          const row = rows.find((f) => f.id === fileId);
          if (!row?.file_path) return { revealed: false, notFound: true };
          if (!fs.existsSync(row.file_path)) return { revealed: false, missingOnDisk: true };
          shell.showItemInFolder(row.file_path);
          return { revealed: true };
        } catch { return { revealed: false }; }
      },
      openFileById: (projectId: string, fileId: string) => {
        try {
          const rows = getFilesByProject(projectId) as any[];
          const row = rows.find((f) => f.id === fileId);
          if (!row?.file_path) return { opened: false, notFound: true };
          if (!fs.existsSync(row.file_path)) return { opened: false, missingOnDisk: true };
          void shell.openPath(row.file_path);
          return { opened: true };
        } catch { return { opened: false }; }
      },
      getVersions: (projectId: string) => dbMod.getVersionsByProject(projectId) as any[],
      getCapabilities: (dawType: string | null, filePath: string | null) => {
        try {
          const adapter = getAdapterForProject(dawType, filePath);
          const caps = adapter.capabilities();
          const notes: string[] = [];
          if (caps.crossDawReconstruct === false) notes.push('Cross-DAW reconstruction is not supported.');
          if (caps.scanPlugins === false) notes.push('Plugin scanning is not available.');
          return {
            dawType: adapter.displayName ?? dawType ?? 'unknown',
            canRestore: !!caps.restore,
            canOpen: !!caps.sameDawOpen,
            notes,
          };
        } catch { return null; }
      },
      classifyErrors: (projectId: string) => classifyFailedRowsForProject(projectId),
    }));
  }
  initCopilot(store);
  registerAbletonHandlers();
  startBridgeServer();

  // Steps 6-7: Create window after DB + services are ready — eliminates IPC race
  // where renderer fires projects:getAll before initDatabase() completed.
  createTray();
  createWindow();
  // Notify renderer once the page finishes loading (DB is already initialized above)
  mainWindow?.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main:ready');
    }
    // DB, secure storage, IPC handlers, and the window all exist now — safe to
    // drain any deep link captured during cold launch, exactly once.
    appFullyReady = true;
    if (pendingDeepLinkUrl) {
      const url = pendingDeepLinkUrl;
      pendingDeepLinkUrl = null;
      authLog('deep-link-drained-from-queue');
      void handleDeepLink(url);
    }
  });

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
    // E2E isolation: override watched folders so tests don't touch the user's real library
    if (process.env.WAVI_E2E === '1') {
      const e2eFolder = process.env.WAVI_E2E_FOLDER ?? '/tmp/wavi-e2e';
      watcherManager!.addFolder(e2eFolder);
      return;
    }

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

// Windows/Linux: second-instance fires with argv containing the URL. This also
// fires on macOS/Windows/Linux when a second launch attempt is blocked by the
// single-instance lock (e.g. the OS spawning a new process to deliver a
// wavi:// callback) — argv from that blocked second launch arrives here, and
// we route it into the one real running instance instead of losing it.
//
// Bug fixed: this previously only matched auth-callback URLs, so an
// open-project (wavi://open-project?share=...) link arriving via a blocked
// second launch was silently dropped — the token was in argv but never
// looked at. Now matches any wavi:// URL and lets queueOrHandleDeepLink's
// own routing (open-project vs auth) decide what to do with it.
app.on('second-instance', (_event, argv) => {
  const url = argv.find((arg) => arg.includes('://auth/callback') || arg.includes('://auth?') || arg.includes('://open-project'));
  if (url) queueOrHandleDeepLink(url);
  // Restore/focus the existing window so the user sees auth/restore progress.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

// Exchange a short-lived Privy JWT for a persistent wv_ desktop token.
// Returns the wv_ token on success, null on failure.
async function exchangePrivyJwt(privyJwt: string): Promise<string | null> {
  authLog('token-exchange-start');
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
      authLog('token-exchange-failed', { httpStatus: res.status });
      return null;
    }
    const data: { token?: string; expiresAt?: string } = await res.json();
    if (!data?.token?.startsWith('wv_')) {
      authLog('token-exchange-failed', { reason: 'unexpected-response-shape' });
      return null;
    }
    authLog('token-exchange-success', describeToken(data.token));
    return data.token;
  } catch (e: any) {
    authLog('token-exchange-error', { message: e?.message ?? String(e) });
    captureException(e);
    return null;
  }
}

async function handleDeepLink(url: string) {
  try {
    // Explicit allowlist + path/credential validation, shared with unit tests
    // (see electron/deepLinkValidator.ts). This build only ever accepts its
    // own channel's scheme — a QA build receiving a production wavi://
    // callback (or vice versa) is rejected outright.
    const validation = validateDeepLink(url, PROTOCOL_SCHEME);
    if (!validation.ok) {
      authLog('deep-link-rejected', { reason: validation.reason, expected: `${PROTOCOL_SCHEME}:` });
      return;
    }
    const rawToken = validation.token;

    // Replay guard — a token value should only ever be processed once. We key
    // on a short hash, never the raw token, and cap the set so it can't grow
    // unbounded across a long-running session.
    const isReplay = checkAndRecordReplay(
      rawToken,
      processedDeepLinkUrls,
      (s) => crypto.createHash('sha256').update(s).digest('hex'),
    );
    if (isReplay) {
      authLog('deep-link-rejected', { reason: 'replay' });
      return;
    }

    authLog('deep-link-accepted', describeToken(rawToken));

    // Bring the window forward so the user sees auth progress immediately.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }

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
    authLog('token-stored', { ...describeToken(finalToken), encrypted: safeStorage.isEncryptionAvailable() });
    // Signal renderer that auth succeeded; send token so renderer can set authed=true.
    // The renderer does NOT store the token on disk — that is main process responsibility.
    mainWindow?.webContents.send('auth:token-received', finalToken);
    authLog('renderer-notified');
    rebuildTrayMenu();
  } catch (e) {
    captureException(e);
    authLog('handle-deep-link-error', { message: (e as any)?.message ?? String(e) });
  }
}

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.aiff', '.aif', '.flac', '.m4a', '.ogg', '.aac']);

/** Returns the DB id if this file_path already exists in the library, else null. */
function checkFileExists(filePath: string): string | null {
  return getFileByPath(filePath)?.id ?? null;
}

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
  // Logout: drop the active account DID so no account-scoped cache is served,
  // invalidate every in-flight Project Link request (its response becomes stale
  // and is discarded, never persisted), and tell the renderer to reset its
  // account-context resolver + epoch. Only the null handle crosses the IPC.
  currentAccountId = null;
  plCoordinator.bumpGeneration();
  mainWindow?.webContents.send('auth:account', { accountId: null });
});

// Share links — create or retrieve a share link for a synced asset
ipcMain.handle('share:createLink', async (_e, opts: {
  assetId: string;
  projectId?: string;
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
      res = await fetch(`${API_BASE}/desktop/index`, {
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
          // Reuse is only honored server-side when the existing active link's
          // allowDownload + expiresAt match exactly (immutable-link model).
          reuseExisting: true,
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
    if (opts.projectId) {
      const { updateProjectShareInfo } = require('./db');
      updateProjectShareInfo(opts.projectId, data.shareUrl, data.trackingId);
    }
    // Links registry (Links page): remember what we created so the creator
    // can label/duplicate/revoke it later without a server list endpoint.
    try {
      const { recordLink } = require('./db');
      recordLink({
        tracking_id: data.trackingId, kind: 'listen',
        project_id: opts.projectId ?? null, asset_id: opts.assetId,
        url: data.shareUrl, allow_download: opts.allowDownload ?? true,
        expires_at: opts.expiresAt ?? null,
      });
    } catch (e) { mainLog(`[links] record listen link failed: ${(e as any)?.message}`); }
    return { shareUrl: data.shareUrl, trackingId: data.trackingId, reused: data.reused };
  } catch (e: any) {
    captureException(e);
    return { error: e?.message ?? 'Unknown error' };
  }
});

ipcMain.handle('share:revokeLink', async (_e, opts: { trackingId: string; projectId?: string }) => {
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
      res = await fetch(`${API_BASE}/desktop/index`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Desktop-Action': 'revoke-share-link',
        },
        body: JSON.stringify({ trackingId: opts.trackingId }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as any;
      return { error: body?.error ?? `HTTP ${res.status}` };
    }
    logActivity({ id: crypto.randomUUID(), type: 'share_link_revoked', message: `Revoked link: ${opts.trackingId}` });
    if (opts.projectId) {
      const { updateProjectShareInfo } = require('./db');
      updateProjectShareInfo(opts.projectId, null, null);
    }
    try { require('./db').markLinkRevoked(opts.trackingId); } catch { /* registry best-effort */ }
    return { success: true };
  } catch (e: any) {
    captureException(e);
    return { error: e?.message ?? 'Unknown error' };
  }
});

// ── Project Links ─────────────────────────────────────────────────────────────

/**
 * LEGACY production endpoint helper (`/desktop/index`) — used ONLY for actions
 * OUTSIDE the locked Project Link contract (publish-project-version,
 * get-project-files, revoke-share-link, …) which are still served by the
 * deployed production router. The three Project Link actions must never go
 * through here — they use postDesktopAction → buildDesktopEndpoint(API_BASE)
 * (`/api/desktop`, the locked contract). Guarded by projectLinkEndpoints.test.
 */
async function desktopApiPost(token: string, action: string, body: Record<string, unknown>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${API_BASE}/desktop/index`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Desktop-Action': action,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) return { error: data?.error ?? `HTTP ${res.status}` };
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function getDecryptedToken(): string | null {
  const stored = store.get('authToken', null) as string | null;
  if (!stored) return null;
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(stored, 'base64'))
      : stored;
  } catch { return null; }
}

// ── project:publishVersion ────────────────────────────────────────────────────
// Collects all local files associated with a project, computes safe project-
// relative paths (never exposing absolute filesystem paths to the cloud),
// and submits a complete transactional snapshot to publish-project-version.

// Manifest helpers moved to the DAW adapter layer (Phase F):
// electron/adapters/common.ts (shared) + electron/adapters/ableton.ts.
// getAdapterForProject() resolves the right adapter; the generic adapter
// reproduces the exact pre-extraction behavior for non-Ableton projects.


async function doPublishVersion(opts: { localProjectId: string }) {
  const token = getDecryptedToken();
  if (!token) return { error: 'Not authenticated' };

  const project = getProjectById(opts.localProjectId) as any;
  if (!project) return { error: 'Project not found locally' };
  if (!project.cloud_id) return { error: 'Project not yet synced to cloud' };

  const projectFilePath = project.file_path as string;
  const projectRoot = path.dirname(projectFilePath);

  // Collect all files associated with this project
  const localFiles = getFilesByProject(opts.localProjectId) as any[];
  const syncedFiles = localFiles.filter((f: any) => f.sync_status === 'synced' && f.cloud_asset_id && f.file_path);

  if (!syncedFiles.length) return { error: 'No synced files found for this project' };

  // Build manifest — safe relative paths, no absolute paths
  const fileManifest: ManifestEntry[] = [];

  // Include the primary project file itself (the .als/.ptx/etc.)
  if (fs.existsSync(projectFilePath)) {
    const stat = fs.statSync(projectFilePath);
    fileManifest.push({
      relativePath: path.basename(projectFilePath),
      fileName: path.basename(projectFilePath),
      fileSize: stat.size,
      sha256: project.checksum ?? null,
      role: 'project',
      mimeType: null,
      assetId: project.project_asset_id ?? '',
    });
  }

  // Add all synced associated files
  for (const f of syncedFiles) {
    const rel = safeRelativePath(f.file_path, projectRoot + path.sep);
    if (!rel) continue;
    fileManifest.push({
      relativePath: rel,
      fileName: f.file_name,
      fileSize: f.file_size ?? 0,
      sha256: f.checksum ?? null,
      role: classifyFileRole(f.file_name, f.classifier_role ?? 'misc'),
      mimeType: null,
      assetId: f.cloud_asset_id,
    });
  }

  // Ableton: always include the (possibly empty) "Ableton Project Info" directory
  // marker so restored packs are recognized as a real Project, not a Temp Project.
  fileManifest.push(...getAdapterForProject(project.daw_type, projectFilePath).manifestExtras(projectFilePath, projectRoot));

  if (!fileManifest.length) return { error: 'No eligible files to publish in this project version' };

  // Preview bounce: prefer an explicit preview.wav/bounce.wav at the project root
  // over auto-selecting an arbitrary stem. If none exists, fall back to the
  // server's auto-selection but flag it so a stem is never silently treated as
  // the canonical preview.
  const previewCandidate = findPreviewCandidate(syncedFiles, projectRoot);
  const previewAssetId = previewCandidate?.cloud_asset_id ?? null;
  if (!previewCandidate) {
    logActivity({
      id: crypto.randomUUID(),
      type: 'preview_auto_selected',
      message: `No preview.wav/bounce.wav found at project root for "${project.project_name}" — falling back to auto-selected stem as preview`,
      project_id: opts.localProjectId,
    });
  }

  const result = await desktopApiPost(token, 'publish-project-version', {
    projectId: project.cloud_id,
    parentVersionId: project.cloud_version_id ?? null,
    daw: project.daw_type ?? null,
    bpm: previewCandidate?.bpm ?? null,
    sha256: project.checksum ?? null,
    fileSize: project.file_size ?? null,
    deviceLabel: `Wavi Studio — ${require('os').hostname()}`,
    files: fileManifest,
    versionNotes: null,
    previewAssetId,
    previewRelativePath: previewCandidate ? safeRelativePath(previewCandidate.file_path, projectRoot + path.sep) : null,
    previewDuration: previewCandidate?.duration ?? null,
    previewFormat: previewCandidate ? path.extname(previewCandidate.file_name).replace(/^\./, '') : null,
    previewKey: previewCandidate?.key_note ?? null,
    previewAutoSelected: !previewCandidate,
  });

  return result;
}

ipcMain.handle('project:publishVersion', (_e, opts: { localProjectId: string }) => doPublishVersion(opts));

ipcMain.handle('project:createLink', async (_e, opts: {
  projectId: string;           // local SQLite project id
  cloudProjectId?: string;     // cloud project UUID (if already known)
  projectVersionId?: string;   // if explicit version to link — skips publish step
  allowDownload?: boolean;
  expiresAt?: string;
  collaboratorMode?: 'view' | 'comment' | 'edit';
}) => {
  const token = getDecryptedToken();
  if (!token) return { error: 'Not authenticated' };

  let versionId = opts.projectVersionId ?? null;

  // Step 1: ensure a complete immutable version exists with all files populated.
  // If the caller didn't pass an explicit version, publish one now.
  if (!versionId) {
    const published = await desktopApiPost(token, 'publish-project-version', (() => {
      const project = getProjectById(opts.projectId) as any;
      if (!project?.cloud_id) return null;
      const projectFilePath = project.file_path as string;
      const projectRoot = path.dirname(projectFilePath) + path.sep;
      const localFiles = (getFilesByProject(opts.projectId) as any[]).filter(
        (f: any) => f.sync_status === 'synced' && f.cloud_asset_id && f.file_path
      );
      const fileManifest: ManifestEntry[] = [];
      if (fs.existsSync(projectFilePath)) {
        fileManifest.push({ relativePath: path.basename(projectFilePath), fileName: path.basename(projectFilePath), fileSize: project.file_size ?? 0, sha256: project.checksum ?? null, role: 'project', mimeType: null, assetId: project.project_asset_id ?? '' });
      }
      for (const f of localFiles) {
        const rel = safeRelativePath(f.file_path, projectRoot);
        if (!rel) continue;
        fileManifest.push({ relativePath: rel, fileName: f.file_name, fileSize: f.file_size ?? 0, sha256: f.checksum ?? null, role: classifyFileRole(f.file_name, f.classifier_role ?? 'misc'), mimeType: null, assetId: f.cloud_asset_id });
      }
      // Ableton: always include the (possibly empty) "Ableton Project Info" directory
      // marker — see abletonManifestExtras (adapters/ableton.ts) for why this is required.
      fileManifest.push(...getAdapterForProject(project.daw_type, projectFilePath).manifestExtras(projectFilePath, path.dirname(projectFilePath)));

      const previewCandidate = findPreviewCandidate(localFiles, path.dirname(projectFilePath));
      return {
        projectId: project.cloud_id,
        parentVersionId: project.cloud_version_id ?? null,
        daw: project.daw_type ?? null,
        bpm: previewCandidate?.bpm ?? null,
        sha256: project.checksum ?? null,
        fileSize: project.file_size ?? null,
        deviceLabel: `Wavi Studio — ${require('os').hostname()}`,
        files: fileManifest,
        previewAssetId: previewCandidate?.cloud_asset_id ?? null,
        previewRelativePath: previewCandidate ? safeRelativePath(previewCandidate.file_path, projectRoot) : null,
        previewDuration: previewCandidate?.duration ?? null,
        previewFormat: previewCandidate ? path.extname(previewCandidate.file_name).replace(/^\./, '') : null,
        previewKey: previewCandidate?.key_note ?? null,
        previewAutoSelected: !previewCandidate,
      };
    })() as any);

    if (!published || (published as any).error) return { error: (published as any)?.error ?? 'Failed to publish project version' };
    versionId = (published as any).versionId;
  }

  // Step 2: create the Project Link referencing this exact immutable version.
  // ROUTED through the authoritative service (locked /api/desktop contract,
  // in-flight dedup, no retry, outcome-unknown on ambiguity) — the obsolete
  // legacy-endpoint create path is gone. Response keeps the legacy
  // { trackingId, linkUrl } shape for existing callers.
  const cloudProjectId = opts.cloudProjectId ?? (getProjectById(opts.projectId) as any)?.cloud_id;
  const { stale, value: created } = await plCoordinator.runCreate(
    normalizeCreateKey({ projectId: cloudProjectId, projectVersionId: versionId ?? undefined, allowDownload: opts.allowDownload, expiresAt: opts.expiresAt ?? null, collaboratorMode: opts.collaboratorMode === 'comment' ? 'comment' : 'view' }),
    () => createProjectLinkFlow(plServiceDeps(token), {
      projectId: cloudProjectId, projectVersionId: versionId ?? undefined,
      allowDownload: opts.allowDownload, expiresAt: opts.expiresAt ?? null,
      collaboratorMode: opts.collaboratorMode === 'comment' ? 'comment' : 'view',
    }),
  );
  if (stale) return { error: 'Session changed while creating — refresh Links to check the result.' };
  if (created.kind === 'failure') return { error: created.message ?? created.reason };
  captureAccountId(created.accountId);
  // Desktop-owned recipient URL (always points at this app's deployment).
  const linkUrl = `${WEB_BASE}/project-link/${created.item.trackingId}`;
  try {
    const { recordLink } = require('./db');
    recordLink({
      tracking_id: created.item.trackingId, kind: 'project',
      project_id: opts.projectId, version_id: created.item.projectVersionId,
      url: linkUrl,
      allow_download: created.item.permissions.allowDownload !== false,
      collaborator_mode: (created.item.permissions.collaboratorMode as string) ?? 'view',
      expires_at: created.item.expiresAt,
      account_id: created.accountId,
    });
  } catch (e) { mainLog(`[links] record project link failed: ${(e as any)?.message}`); }
  return { trackingId: created.item.trackingId, linkUrl, versionId: created.item.projectVersionId };
});

ipcMain.handle('project:revokeLink', async (_e, opts: { trackingId: string }) => {
  const token = getDecryptedToken();
  if (!token) return { error: 'Not authenticated' };
  // ROUTED through the authoritative service (single mutation path).
  const r = await revokeProjectLinkFlow(plServiceDeps(token), opts.trackingId);
  if (r.kind === 'failure') return { error: r.message ?? r.reason };
  captureAccountId(r.accountId);
  try { require('./db').markLinkRevokedForAccount(opts.trackingId, r.accountId); } catch { /* registry best-effort */ }
  return { success: true };
});

// ── Links registry (Links page, Phase C) ─────────────────────────────────────
// Reads/labels come from the local registry; revocation dispatches to the
// existing server actions by kind — the server stays authoritative.
ipcMain.handle('links:getAll', () => {
  try { return require('./db').getLinks(); } catch { return []; }
});

ipcMain.handle('links:rename', (_e, opts: { trackingId: string; label: string | null }) => {
  try { return { success: require('./db').renameLink(opts.trackingId, opts.label) }; }
  catch (e: any) { return { error: e?.message ?? 'Rename failed' }; }
});

ipcMain.handle('links:revoke', async (_e, opts: { trackingId: string }) => {
  const { getLinkByTrackingId, markLinkRevoked: markRevoked } = require('./db');
  const link = getLinkByTrackingId(opts.trackingId);
  if (!link) return { error: 'Link not found' };
  const token = getDecryptedToken();
  if (!token) return { error: 'Not authenticated' };

  if (link.kind === 'project') {
    // Project Links: ROUTED through the authoritative service — single
    // mutation path against the locked /api/desktop contract.
    const r = await revokeProjectLinkFlow(plServiceDeps(token), opts.trackingId);
    if (r.kind === 'failure') return { error: r.message ?? r.reason };
    captureAccountId(r.accountId);
    try { require('./db').markLinkRevokedForAccount(opts.trackingId, r.accountId); } catch { /* best effort */ }
    logActivity({ id: crypto.randomUUID(), type: 'share_link_revoked', message: `Revoked link: ${opts.trackingId}` });
    return { success: true };
  }

  // Listen links: UNRELATED to the Project Link contract — still served by the
  // legacy production share-link action (documented legacy path).
  const result = await desktopApiPost(token, 'revoke-share-link', { trackingId: opts.trackingId });
  if (result && !(result as any).error) {
    markRevoked(opts.trackingId);
    if (link.project_id) {
      const { updateProjectShareInfo } = require('./db');
      updateProjectShareInfo(link.project_id, null, null);
    }
    logActivity({ id: crypto.randomUUID(), type: 'share_link_revoked', message: `Revoked link: ${opts.trackingId}` });
  }
  return result;
});

// ── Authoritative Project Link networking (P3-2c, locked Codex contract) ─────
// POST /api/desktop (via buildDesktopEndpoint — the ONE endpoint builder) with
// X-Desktop-Action; identity is the server Privy DID in `accountId`. The token
// AND the DID stay in the main process: the renderer receives only an opaque,
// non-reversible account handle (toRendererAccountHandle) for scoping/epoch.
const DESKTOP_ENDPOINT = buildDesktopEndpoint(API_BASE);
const plCoordinator = createLinkOpsCoordinator();

/** Raw desktop POST returning the full response (status/json/threw) for the service. */
async function postDesktopAction(token: string, action: string, body: Record<string, unknown>): Promise<DesktopResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(DESKTOP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Desktop-Action': action },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } catch {
    return { status: 0, json: {}, threw: true };
  } finally {
    clearTimeout(timer);
  }
}

/** The renderer-visible form of the active account: opaque handle, never the DID. */
function rendererAccountHandle(): string | null {
  return currentAccountId ? toRendererAccountHandle(currentAccountId) : null;
}

/** Record the server-authoritative account DID (main-only). A DID change is an
 *  account switch: invalidate in-flight work and tell the renderer via the
 *  OPAQUE handle only — the DID itself never crosses the IPC boundary. */
function captureAccountId(did: string) {
  if (did && did !== currentAccountId) {
    if (currentAccountId) plCoordinator.bumpGeneration(); // account switch mid-session
    currentAccountId = did;
    mainWindow?.webContents.send('auth:account', { accountId: toRendererAccountHandle(did) });
  }
}

/** Strip the DID from rows before they cross to the renderer (opaque handle instead). */
function toRendererRows(rows: any[]): any[] {
  return rows.map((r) => ({ ...r, account_id: r.account_id ? toRendererAccountHandle(r.account_id) : null }));
}

function plServiceDeps(token: string): ProjectLinkServiceDeps {
  return { postDesktop: (action, body) => postDesktopAction(token, action, body), isOnline: () => true };
}

// List + reconcile the local cache against server truth for the active account.
// No token → no network request at all. In-flight dedup per filter; a logout /
// account switch mid-flight marks the result stale → nothing is persisted.
ipcMain.handle('projectLinks:reconcile', async (_e, filter?: { projectId?: string; versionId?: string }) => {
  const token = getDecryptedToken();
  if (!token) return { error: 'Not authenticated', reason: 'unauthorized' };
  const f = filter ?? {};
  const { stale, value: res } = await plCoordinator.runReconcile(
    JSON.stringify({ p: f.projectId ?? null, v: f.versionId ?? null }),
    () => listProjectLinksAll(plServiceDeps(token), f),
  );
  if (stale) return { error: 'Session changed — result discarded.', reason: 'stale-session' };
  if (res.kind === 'failure') return { error: res.message ?? res.reason, reason: res.reason };
  captureAccountId(res.accountId);
  const db = require('./db');
  const cached = (db.getLinks() as any[]).map((r) => ({
    tracking_id: r.tracking_id, account_id: r.account_id ?? null, revoked_at: r.revoked_at ?? null,
    project_id: r.project_id ?? null, version_id: r.version_id ?? null,
  }));
  // Filter-scoped: a filtered listing can never flag another project's rows.
  const ops = planReconciliation(res.accountId, res.records, cached, res.pageComplete, f);
  let applied = 0, flagged = 0;
  for (const op of ops) {
    if (op.op === 'apply') {
      db.applyAuthoritativeLink({
        tracking_id: op.item.trackingId, account_id: op.item.ownerAccountId,
        project_version_id: op.item.projectVersionId, revoked: op.item.status === 'revoked',
        expires_at: op.item.expiresAt,
      });
      applied++;
    } else { flagged++; }
  }
  return { accountId: rendererAccountHandle(), applied, reconciliationNeeded: flagged, total: res.records.length, pageComplete: res.pageComplete };
});

// Account-scoped rows for the renderer (active account only; legacy separated).
// Rows are DID-stripped: account_id is replaced with the opaque handle.
ipcMain.handle('projectLinks:getScoped', () => {
  try {
    const db = require('./db');
    return {
      accountId: rendererAccountHandle(),
      scoped: currentAccountId ? toRendererRows(db.getLinksForAccount(currentAccountId)) : [],
      legacy: toRendererRows(db.getLegacyUnscopedLinks()),
    };
  } catch { return { accountId: rendererAccountHandle(), scoped: [], legacy: [] }; }
});

// Authoritative create — persists account_id ONLY after server confirmation.
// Create is NOT idempotent: one in-flight request per normalized configuration
// (double-click shares the promise); no automatic retry; a thrown/aborted fetch
// is `create-outcome-unknown` (recovery = reconcile); a session change
// mid-flight discards the response without persisting.
ipcMain.handle('projectLinks:create', async (_e, opts: {
  projectId: string; projectVersionId?: string; allowDownload?: boolean; expiresAt?: string | null; collaboratorMode?: 'view' | 'comment';
}) => {
  const token = getDecryptedToken();
  if (!token) return { error: 'Not authenticated', reason: 'unauthorized' };
  const { stale, value: r } = await plCoordinator.runCreate(
    normalizeCreateKey(opts),
    () => createProjectLinkFlow(plServiceDeps(token), opts),
  );
  if (stale) {
    // The link may exist server-side under the previous session — never persist
    // under the new one; recovery is the authoritative listing.
    return { error: 'Session changed while creating — refresh Links to check the result.', reason: 'stale-session' };
  }
  if (r.kind === 'failure') return { error: r.message ?? r.reason, reason: r.reason };
  captureAccountId(r.accountId);
  const url = `${WEB_BASE}/project-link/${r.item.trackingId}`;
  try {
    require('./db').recordLink({
      tracking_id: r.item.trackingId, kind: 'project', project_id: opts.projectId,
      version_id: r.item.projectVersionId, url,
      allow_download: r.item.permissions.allowDownload !== false,
      collaborator_mode: (r.item.permissions.collaboratorMode as string) ?? 'view',
      expires_at: r.item.expiresAt, account_id: r.accountId,
    });
  } catch (e) { mainLog(`[projectLinks] record create failed: ${(e as any)?.message}`); }
  return { ok: true, accountId: rendererAccountHandle(), trackingId: r.item.trackingId, url };
});

// Authoritative revoke — verifies ownership server-side; marks local on confirm.
// (Revoke IS idempotent server-side — alreadyRevoked — so no outcome-unknown.)
ipcMain.handle('projectLinks:revoke', async (_e, opts: { trackingId: string }) => {
  const token = getDecryptedToken();
  if (!token) return { error: 'Not authenticated', reason: 'unauthorized' };
  const r = await revokeProjectLinkFlow(plServiceDeps(token), opts.trackingId);
  if (r.kind === 'failure') return { error: r.message ?? r.reason, reason: r.reason };
  captureAccountId(r.accountId);
  try { require('./db').markLinkRevokedForAccount(opts.trackingId, r.accountId); } catch { /* best effort */ }
  return { ok: true, accountId: rendererAccountHandle(), alreadyRevoked: r.alreadyRevoked };
});

ipcMain.handle('project:getCloudFiles', async (_e, opts: { cloudProjectId: string }) => {
  const token = getDecryptedToken();
  if (!token) return { error: 'Not authenticated' };
  return desktopApiPost(token, 'get-project-files', { projectId: opts.cloudProjectId });
});

// Open-project deep link: supports wavi://open-project/:token AND
// wavi://open-project?share=:token (recipient-facing form used by the
// Project Link page's "Open in Wavi Studio" button).
// Queued by the same cold-launch mechanism as the auth callback.
const processedOpenProjectTokens = new Set<string>(); // replay guard, mirrors auth's

function queueOrHandleOpenProject(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${PROTOCOL_SCHEME}:`) return;
    if (parsed.hostname !== 'open-project') return;
    const pathToken = parsed.pathname.replace(/^\//, '').split('/')[0];
    const queryToken = parsed.searchParams.get('share');
    const token = queryToken || pathToken;
    if (!token) return;

    const replayKey = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    // Note: unlike auth tokens, the SAME project-link token is legitimately
    // reused across multiple opens (a recipient may open the same link many
    // times) — we only guard against a rapid duplicate firing (e.g. macOS
    // delivering the same open-url event twice), not repeat legitimate use.
    if (processedOpenProjectTokens.has(replayKey)) {
      authLog('open-project-rapid-duplicate-ignored');
      return;
    }
    processedOpenProjectTokens.add(replayKey);
    setTimeout(() => processedOpenProjectTokens.delete(replayKey), 5000);

    authLog('open-project-deep-link', { token: token.slice(0, 8) + '…' });
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('project:open-link', { token });
    }
  } catch (e) {
    mainLog(`[open-project] parse error: ${(e as any)?.message}`);
  }
}

// ── Project Link Restore ─────────────────────────────────────────────────────

// Resolve a share token → manifest (no auth required).
ipcMain.handle('restore:resolve', async (_e, token: string) => {
  try {
    const res = await fetch(`${API_BASE}/desktop/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Desktop-Action': 'resolve-project-link' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) return { error: data?.error ?? `HTTP ${res.status}` };
    return data;
  } catch (e: any) {
    return { error: e?.message ?? 'Network error' };
  }
});

// Check if this share token has already been restored locally.
ipcMain.handle('restore:checkExisting', (_e, shareId: string) => {
  return getRestoredProjectByShare(shareId);
});

// Let the user pick a destination folder for the restored project.
ipcMain.handle('restore:pickDestination', async (_e, defaultName: string) => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose restore location',
    message: `Where should "${defaultName}" be saved?`,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Restore Here',
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

// ── restore:start ────────────────────────────────────────────────────────────
// Downloads the Project Pack ZIP for a share token, extracts it safely (with
// zip-slip protection), verifies every file's SHA-256 hash, persists the
// restore record, then returns the path to the DAW project file.
//
// Progress is sent via 'restore:progress' events on the mainWindow webContents.
// Errors are returned in the resolved value so the UI can classify them.

function sendRestoreProgress(evt: string, payload: Record<string, unknown>) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('restore:progress', { evt, ...payload });
  }
}

const FORBIDDEN_PATH_PATTERNS_RESTORE = [
  /\.\./,          // zip-slip — path traversal
  /^\//, /^\\/,    // absolute paths
  /[\0\r\n]/,      // null / newline injection
];
function isSafeRestorePath(rel: string): boolean {
  return !FORBIDDEN_PATH_PATTERNS_RESTORE.some(rx => rx.test(rel));
}

ipcMain.handle('restore:start', async (_e, opts: {
  token: string;
  shareId: string;
  projectId: string;
  versionId: string;
  ownerUserId?: string;
  collaboratorMode?: string;
  parentVersionId?: string;
  projectName: string;
  dawType?: string;
  fileCount: number;
  totalSize: number;
  files: Array<{ file_name: string; relative_path?: string; sha256?: string; file_size?: number; role?: string }>;
  destinationFolder: string;
}) => {
  const { token, shareId, projectId, versionId, ownerUserId, collaboratorMode,
          parentVersionId, projectName, dawType, fileCount, totalSize, files, destinationFolder } = opts;

  // Sanitize project name for use as directory name
  const safeName = projectName.replace(/[^\w\s\-().]/g, '').trim() || 'Restored-Project';
  const projectDir = path.join(destinationFolder, safeName);

  // Prevent overwriting existing restores by appending a timestamp
  const finalDir = fs.existsSync(projectDir)
    ? `${projectDir}-${Date.now()}`
    : projectDir;

  try {
    fs.mkdirSync(finalDir, { recursive: true });
  } catch (e: any) {
    return { error: 'extraction_failure', detail: `Could not create project directory: ${e.message}` };
  }

  sendRestoreProgress('download_start', { totalSize, fileCount });

  // Download the ZIP
  let zipBuffer: Buffer;
  try {
    // API_BASE = https://host/api — strip /api suffix to get the web origin
    const webOrigin = API_BASE.replace(/\/api\/?$/, '');
    const downloadUrl = `${webOrigin}/api/project-link/${token}/download`;
    const resp = await fetch(downloadUrl, { signal: AbortSignal.timeout(300_000) });
    if (!resp.ok) {
      if (resp.status === 403) return { error: 'permission_denied', detail: 'Download not permitted for this link' };
      if (resp.status === 410) return { error: 'expired_link', detail: 'This project link has expired' };
      if (resp.status === 404) return { error: 'missing_asset', detail: 'Project archive not found' };
      return { error: 'network', detail: `HTTP ${resp.status}` };
    }
    const arrayBuf = await resp.arrayBuffer();
    zipBuffer = Buffer.from(arrayBuf);
    sendRestoreProgress('download_complete', { downloadedBytes: zipBuffer.length });
  } catch (e: any) {
    if (e?.name === 'TimeoutError') return { error: 'network', detail: 'Download timed out' };
    return { error: 'network', detail: e?.message ?? 'Download failed' };
  }

  sendRestoreProgress('extract_start', {});

  // Extract ZIP with zip-slip protection (no native unzip — we parse in-process)
  let dawProjectPath: string | null = null;
  const extractedFiles: Array<{ relativePath: string; sha256: string }> = [];

  try {
    // Use the built-in unzipper via dynamic import (avoid adding another dep)
    // We extract using the Node 'zlib' + manual ZIP parsing isn't practical,
    // so we shell out to the macOS `unzip` command with explicit destination.
    // To maintain zip-slip protection we validate every entry name before extraction.

    // First pass: list entries and validate paths using `unzip -l`
    const tmpZipList = path.join(app.getPath('temp'), `wavi-restore-list-${Date.now()}.zip`);
    fs.writeFileSync(tmpZipList, zipBuffer);
    const listResult = await new Promise<string>((resolve, reject) => {
      execFile('unzip', ['-l', tmpZipList], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpZipList); } catch { /* ignore */ }
        if (err && !stdout) { reject(new Error(stderr || err.message)); return; }
        resolve(stdout);
      });
    });

    // Parse entry names from `unzip -l` output (lines like: `   1234  ..  filename`)
    const entryLines = listResult.split('\n').slice(3); // skip header
    const entryNames = entryLines
      .map(l => l.replace(/^\s+\d+\s+[\d-]+\s+[\d:]+\s+/, '').trim())
      .filter(n => n && !n.startsWith('---') && !n.includes('files'));

    for (const name of entryNames) {
      if (!isSafeRestorePath(name)) {
        return { error: 'extraction_failure', detail: `Zip-slip or unsafe path detected: ${name}` };
      }
    }

    // Second pass: extract to finalDir
    const tmpZipPath2 = path.join(app.getPath('temp'), `wavi-restore-${Date.now()}.zip`);
    fs.writeFileSync(tmpZipPath2, zipBuffer);

    await new Promise<void>((resolve, reject) => {
      execFile('unzip', ['-o', tmpZipPath2, '-d', finalDir], { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
        try { fs.unlinkSync(tmpZipPath2); } catch { /* ignore */ }
        if (err) { reject(new Error(stderr || err.message)); return; }
        resolve();
      });
    });

    sendRestoreProgress('extract_complete', { destDir: finalDir });
  } catch (e: any) {
    return { error: 'extraction_failure', detail: e?.message ?? 'Extraction failed' };
  }

  // Hash-verify every file in the manifest
  sendRestoreProgress('verify_start', { fileCount: files.length });
  const mismatches: string[] = [];
  const missing: string[] = [];
  let verifiedCount = 0;

  for (const f of files) {
    const relPath = (f.relative_path ?? f.file_name).replace(/^\//, '');
    if (!isSafeRestorePath(relPath)) continue; // already caught above, but double-guard
    const localPath = path.join(finalDir, relPath);

    if (!fs.existsSync(localPath)) {
      if (f.role === 'project') {
        missing.push(relPath); // Required DAW project file
      }
      // Missing optional/audio files are warnings, not failures
      continue;
    }

    // Verify SHA-256 if manifest provided one
    if (f.sha256) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
      if (hash !== f.sha256) {
        mismatches.push(relPath);
      } else {
        extractedFiles.push({ relativePath: relPath, sha256: hash });
      }
    } else {
      extractedFiles.push({ relativePath: relPath, sha256: '' });
    }
    verifiedCount++;
    if (verifiedCount % 5 === 0) {
      sendRestoreProgress('verify_progress', { verified: verifiedCount, total: files.length });
    }

    // Never execute archive contents — enforce via extension allowlist check
    const ext = path.extname(localPath).toLowerCase();
    const NEVER_EXECUTE = ['.sh', '.bash', '.command', '.app', '.exe', '.bat', '.cmd', '.py', '.rb', '.pl'];
    if (NEVER_EXECUTE.includes(ext)) {
      // Don't delete; just ensure we never run it. Log for auditability.
      mainLog(`[restore] Non-audio file in archive (will not execute): ${relPath}`);
    }
  }

  if (missing.length > 0) {
    return { error: 'missing_required_file', detail: `Required project file(s) missing: ${missing.join(', ')}`, partialDir: finalDir };
  }
  if (mismatches.length > 0) {
    return { error: 'hash_mismatch', detail: `Hash mismatch for: ${mismatches.join(', ')}`, partialDir: finalDir };
  }

  sendRestoreProgress('verify_complete', { verified: verifiedCount });

  // Find the DAW project file
  for (const f of files) {
    if (f.role === 'project') {
      const relPath = (f.relative_path ?? f.file_name).replace(/^\//, '');
      const candidate = path.join(finalDir, relPath);
      if (fs.existsSync(candidate)) { dawProjectPath = candidate; break; }
    }
  }
  // Fallback: recursive search behind the adapter (behavior-preserving — same
  // extension set and traversal as before; restore is DAW-agnostic so the
  // adapter resolved from daw_type delegates to the shared locateProjectFile).
  if (!dawProjectPath) {
    dawProjectPath = getAdapterForProject(dawType, null).locateProjectFile(finalDir);
  }

  if (!dawProjectPath) {
    return { error: 'missing_required_file', detail: 'No DAW project file found in archive', partialDir: finalDir };
  }

  // Persist restore record
  const manifestHash = crypto.createHash('sha256')
    .update(JSON.stringify(files.map(f => ({ p: f.relative_path ?? f.file_name, h: f.sha256 }))))
    .digest('hex');

  const restored = insertRestoredProject({
    source_project_id: projectId,
    source_version_id: versionId,
    share_id: shareId,
    owner_user_id: ownerUserId ?? null,
    local_checkout_id: crypto.randomUUID(),
    collaborator_permission: collaboratorMode ?? 'view',
    parent_version_id: parentVersionId ?? null,
    local_project_path: dawProjectPath,
    project_name: projectName,
    daw_type: dawType ?? null,
    file_count: fileCount,
    total_size: totalSize,
    sha256_manifest: manifestHash,
    restored_at: new Date().toISOString(),
    last_opened_at: null,
  });

  logActivity({ id: crypto.randomUUID(), type: 'restore', message: `Restored project "${projectName}" from Project Link` });

  sendRestoreProgress('restore_complete', { dawProjectPath, restoreId: restored.id });

  return {
    ok: true,
    restoreId: restored.id,
    dawProjectPath,
    projectDir: finalDir,
    dawType,
  };
});

// Open an existing restored project (duplicate-restore flow).
ipcMain.handle('restore:openExisting', async (_e, restoreId: string) => {
  touchRestoredProject(restoreId);
  return { ok: true };
});

// Folders
ipcMain.handle('folders:getAll', () => {
  const folders = store.get('watchedFolders', []) as string[];
  // Filter out stale paths (e.g. deleted e2e test dirs) so UI stays clean
  const existing = folders.filter(f => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
  if (existing.length !== folders.length) store.set('watchedFolders', existing);
  return existing;
});

ipcMain.handle('folders:discover', () => {
  return new Promise<string[]>((resolve) => {
    setImmediate(() => resolve(discoverDawFolders()));
  });
});

/**
 * Checks whether a folder looks like a purchased/downloaded sample library
 * rather than a user's own project, before it gets added to watchedFolders.
 * Never classifies on file count alone — see classifyFolderForImport's own
 * ratio-based heuristic. Read-only: does not touch the filesystem beyond a
 * single readdirSync of the folder's direct children.
 */
function checkAmbiguousFolder(folderPath: string): FolderClassification | null {
  try {
    const entries = fs.readdirSync(folderPath);
    const classification = classifyFolderForImport(folderPath, entries);
    return classification.likelySampleLibrary ? classification : null;
  } catch {
    return null;
  }
}

function addWatchedFolder(folderPath: string) {
  const folders = store.get('watchedFolders', []) as string[];
  if (!folders.includes(folderPath)) {
    folders.push(folderPath);
    store.set('watchedFolders', folders);
    watcherManager?.addFolder(folderPath);
  }
}

ipcMain.handle('folders:addPath', (_e, folderPath: string, opts?: { force?: boolean }) => {
  if (!opts?.force) {
    const ambiguous = checkAmbiguousFolder(folderPath);
    if (ambiguous) return { needsConfirmation: true, classification: ambiguous };
  }
  addWatchedFolder(folderPath);
  return { needsConfirmation: false, path: folderPath };
});

ipcMain.handle('folders:add', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: 'Select DAW Project Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;

  const folderPath = result.filePaths[0];
  const ambiguous = checkAmbiguousFolder(folderPath);
  if (ambiguous) return { needsConfirmation: true, classification: ambiguous };

  addWatchedFolder(folderPath);
  return { needsConfirmation: false, path: folderPath };
});

// Completes an add after the renderer confirmed an ambiguous-folder prompt
// (e.g. "this looks like a sample library — add anyway?"). Skips
// re-classification since the user has already made the call.
ipcMain.handle('folders:confirmAmbiguous', (_e, folderPath: string) => {
  addWatchedFolder(folderPath);
  return { needsConfirmation: false, path: folderPath };
});

ipcMain.handle('folders:remove', (_e, folderPath: string) => {
  const folders = store.get('watchedFolders', []) as string[];
  const updated = folders.filter((f) => f !== folderPath);
  store.set('watchedFolders', updated);
  // Also remove from excluded paths for this folder
  const excluded = store.get('excludedPaths', []) as string[];
  store.set('excludedPaths', excluded.filter((e) => !e.startsWith(folderPath)));
  watcherManager?.removeFolder(folderPath);
});

// Per-folder rescan: run discoverAudioFiles scoped to a single root
ipcMain.handle('folders:rescan', async (_e, folderPath: string) => {
  if (discoveryAbortSignal) discoveryAbortSignal.aborted = true;
  const signal = { aborted: false };
  discoveryAbortSignal = signal;

  const excluded = store.get('excludedPaths', []) as string[];
  const startMs = Date.now();
  let imported = 0;
  let duplicates = 0;

  const { paths, result } = await discoverAudioFiles(
    { roots: [folderPath], extraRoots: [], excludePaths: excluded, maxFiles: 50_000, maxDurationMs: 120_000, signal },
    (progress) => { mainWindow?.webContents.send('discovery:progress', progress); },
  );

  for (const p of paths) {
    if (signal.aborted) break;
    if (await checkFileExists(p)) { duplicates++; } else { if (await importAudioFile(p)) imported++; }
  }

  discoveryAbortSignal = null;
  const durationMs = Date.now() - startMs;

  // Persist last-scanned timestamp and file count for this folder
  const scanMeta = store.get('folderScanMeta', {}) as Record<string, { lastScanned: string; fileCount: number }>;
  scanMeta[folderPath] = { lastScanned: new Date().toISOString(), fileCount: result.found };
  store.set('folderScanMeta', scanMeta);

  mainWindow?.webContents.send('discovery:progress', { phase: 'done', found: result.found, imported, duplicates, scanned: result.scanned, permissionErrors: result.permissionErrors });
  return { found: result.found, imported, duplicates, scanned: result.scanned, permissionErrors: result.permissionErrors, durationMs, cancelled: signal.aborted };
});

// Folder scan metadata (last scanned, file count)
ipcMain.handle('folders:scanMeta', () => {
  return store.get('folderScanMeta', {});
});

// Exclude a subfolder from future scans
ipcMain.handle('folders:excludePath', (_e, subPath: string) => {
  const excluded = store.get('excludedPaths', []) as string[];
  if (!excluded.includes(subPath)) {
    excluded.push(subPath);
    store.set('excludedPaths', excluded);
  }
});

ipcMain.handle('folders:getExcluded', () => store.get('excludedPaths', []));

ipcMain.handle('folders:unexcludePath', (_e, subPath: string) => {
  const excluded = store.get('excludedPaths', []) as string[];
  store.set('excludedPaths', excluded.filter((e) => e !== subPath));
});

// File count per indexed folder (fast — counts from DB)
ipcMain.handle('folders:fileCounts', () => {
  try {
    const db = require('./db').getDb() as import('better-sqlite3').Database;
    const folders = store.get('watchedFolders', []) as string[];
    const counts: Record<string, number> = {};
    for (const folder of folders) {
      const row = db.prepare("SELECT COUNT(*) as c FROM files WHERE file_path LIKE ?").get(folder + '%') as any;
      counts[folder] = row?.c ?? 0;
    }
    return counts;
  } catch { return {}; }
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

// DAW capability report for the Project Detail compatibility surface. Pure
// adapter lookup — no canonical cloud state. Resolves by stored daw_type, then
// by the project file path.
ipcMain.handle('daw:getCapabilities', (_e, opts: { dawType?: string | null; filePath?: string | null }) => {
  const adapter = getAdapterForProject(opts?.dawType ?? null, opts?.filePath ?? null);
  return { id: adapter.id, displayName: adapter.displayName, capabilities: adapter.capabilities() };
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

// Active discovery cancellation signal
let discoveryAbortSignal: { aborted: boolean } | null = null;

ipcMain.handle('files:discoverAll', async (_e, opts?: {
  roots?: string[];
  extraRoots?: string[];
  excludePaths?: string[];
  maxFiles?: number;
  maxDurationMs?: number;
}) => {
  // Cancel any in-progress scan
  if (discoveryAbortSignal) discoveryAbortSignal.aborted = true;
  const signal = { aborted: false };
  discoveryAbortSignal = signal;

  const startMs = Date.now();
  let imported = 0;
  let duplicates = 0;

  const { paths, result } = await discoverAudioFiles(
    {
      roots: opts?.roots ?? defaultDiscoveryRoots(),
      extraRoots: opts?.extraRoots ?? [],
      excludePaths: opts?.excludePaths ?? [],
      maxFiles: opts?.maxFiles ?? 50_000,
      maxDurationMs: opts?.maxDurationMs ?? 120_000,
      signal,
    },
    (progress) => {
      // Send progress to renderer (non-blocking)
      mainWindow?.webContents.send('discovery:progress', progress);
    },
  );

  if (signal.aborted) {
    mainWindow?.webContents.send('discovery:progress', { phase: 'cancelled', found: result.found, scanned: result.scanned });
    return { found: result.found, imported: 0, duplicates: 0, scanned: result.scanned, durationMs: Date.now() - startMs, cancelled: true };
  }

  // Import phase — idempotent per file_path
  mainWindow?.webContents.send('discovery:progress', { phase: 'importing', found: result.found, imported: 0 });
  for (const p of paths) {
    if (signal.aborted) break;
    // Check for existing record first (count as duplicate, don't re-import)
    const existingId = await checkFileExists(p);
    if (existingId) {
      duplicates++;
    } else {
      const id = await importAudioFile(p);
      if (id) imported++;
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
    limitReached: result.found >= (opts?.maxFiles ?? 50_000),
  };
});

ipcMain.handle('files:discoverCancel', () => {
  if (discoveryAbortSignal) {
    discoveryAbortSignal.aborted = true;
    discoveryAbortSignal = null;
  }
});

ipcMain.handle('files:defaultDiscoveryRoots', () => defaultDiscoveryRoots());

// Sync
ipcMain.handle('sync:getQueue', () => syncAgent?.getQueue() ?? []);
ipcMain.handle('sync:retryAll', () => syncAgent?.retryFailed());
ipcMain.handle('sync:getStatus', () => syncAgent?.getStatus() ?? 'idle');
ipcMain.handle('sync:now', () => { syncAgent?.retryFailed(); syncAgent?.tick?.(); });
// User pause is persisted so it survives app restart (D2). The store lives in
// this instance's userData directory, so the setting is naturally scoped per
// channel/user-data dir (production vs QA vs WAVI_USER_DATA_DIR overrides).
// Only the *user* pause is persisted — auth/limit pauses are derived from
// live server/token state on every launch and must never be persisted.
ipcMain.handle('sync:pause', () => {
  syncAgent?.pauseUser();
  store.set('syncPausedByUser', true);
  return syncAgent?.getStatus() ?? 'idle';
});
ipcMain.handle('sync:resume', () => {
  syncAgent?.resumeUser();
  store.set('syncPausedByUser', false);
  return syncAgent?.getStatus() ?? 'idle';
});
ipcMain.handle('sync:isPausedByUser', () => syncAgent?.isPausedByUser() ?? false);
// "Sync This Project" (D3). Requeues transiently-failed rows + bumps priority.
// If the retry would push a lot of uploads onto the network, require an
// explicit confirmation from the renderer first (force: true on the retry).
const RETRY_CONFIRM_THRESHOLD = 25;
ipcMain.handle('sync:prioritizeProject', (_e, projectId: string, opts?: { force?: boolean }) => {
  if (!syncAgent) {
    return { needsConfirmation: false, bumped: 0, requeued: 0, blockedPermanent: 0, skippedMissing: 0 };
  }
  if (!opts?.force) {
    const { retryable } = classifyFailedRowsForProject(projectId);
    if (retryable.length > RETRY_CONFIRM_THRESHOLD) {
      return { needsConfirmation: true, retryCount: retryable.length };
    }
  }
  const summary = syncAgent.prioritizeProject(projectId);
  return { needsConfirmation: false, ...summary };
});
ipcMain.handle('sync:cancelItem', (_e, itemId: string) => syncAgent?.cancelItem(itemId) ?? false);

// Activity
ipcMain.handle('activity:getAll', () => getActivityLog(100));

// Shell — open external URL (restricted to known hosts)
ipcMain.handle('shell:openExternal', (_e, url: string) => {
  try {
    const parsed = new URL(url);
    const webBaseHost = new URL(WEB_BASE).hostname;
    const allowed = ['wavi.stream', 'github.com', 'privy.io', webBaseHost];
    if (parsed.protocol !== 'https:' || !allowed.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) return;
    shell.openExternal(url);
  } catch { /* invalid URL */ }
});

// ── Shell helpers ─────────────────────────────────────────────────────────────

const USER_SAFE_PREFIXES = () => [
  app.getPath('home'),
  app.getPath('music'),
  app.getPath('documents'),
  app.getPath('desktop'),
];

/**
 * Validate that a path is:
 *  - A string (not a URL or shell command)
 *  - Resolves within user-safe directories
 *  - Actually exists on disk
 *  - Is a file (not a directory) when requireFile=true
 *  - Is indexed in the library when requireIndexed=true
 */
function validateSafePath(
  p: unknown,
  opts: { requireFile?: boolean; requireIndexed?: boolean } = {}
): { ok: true; resolved: string } | { ok: false; error: string } {
  if (typeof p !== 'string' || p.trim() === '') return { ok: false, error: 'Path must be a non-empty string' };
  if (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('file://')) {
    return { ok: false, error: 'URLs are not allowed' };
  }
  if (p.includes(';') || p.includes('&') || p.includes('|') || p.includes('`') || p.includes('$(')) {
    return { ok: false, error: 'Shell metacharacters are not allowed in path' };
  }

  const resolved = path.resolve(p);
  const safe = USER_SAFE_PREFIXES();
  if (!safe.some(prefix => resolved.startsWith(prefix + path.sep) || resolved === prefix)) {
    return { ok: false, error: `Path outside safe roots: ${resolved}` };
  }

  let stat: fs.Stats;
  try { stat = fs.statSync(resolved); } catch {
    return { ok: false, error: `File not found or inaccessible: ${resolved}` };
  }

  if (opts.requireFile && stat.isDirectory()) {
    return { ok: false, error: 'Expected a file, not a directory' };
  }

  if (opts.requireIndexed) {
    const indexed = getFileByPath(resolved);
    if (!indexed) {
      return { ok: false, error: `File is not in the Wavi library. Add it first before opening.` };
    }
  }

  return { ok: true, resolved };
}

// Shell — open in default OS handler (requires indexed file)
ipcMain.handle('shell:openPath', (_e, p: string) => {
  const v = validateSafePath(p, { requireFile: true });
  if (!v.ok) { console.warn('[shell:openPath]', v.error); return; }
  logActivity({ id: crypto.randomUUID(), type: 'file_opened', message: `Opened: ${path.basename(v.resolved)}`, metadata: { action: 'openPath' } });
  return shell.openPath(v.resolved);
});

// Reveal in Finder/Explorer (requires path in safe location, file or folder)
ipcMain.handle('shell:revealInFinder', (_e, p: string) => {
  const v = validateSafePath(p);
  if (!v.ok) { console.warn('[shell:revealInFinder]', v.error); return; }
  shell.showItemInFolder(v.resolved);
});

// Open a file with a specific application (DAW).
// appPath must be a .app bundle (macOS) or .exe (Windows).
// filePath must be indexed in the library.
ipcMain.handle('shell:openWithApp', (_e, filePath: string, appPath: string) => {
  const fv = validateSafePath(filePath, { requireFile: true, requireIndexed: true });
  if (!fv.ok) throw new Error(fv.error);

  // appPath: must exist and be an .app bundle or executable — no shell injection
  if (typeof appPath !== 'string' || appPath.trim() === '') throw new Error('appPath must be a non-empty string');
  if (appPath.includes(';') || appPath.includes('&') || appPath.includes('|') || appPath.includes('`')) {
    throw new Error('Shell metacharacters not allowed in appPath');
  }
  try { fs.statSync(appPath); } catch {
    throw new Error(`DAW application not found: ${appPath}. Update the path in Settings → DAW Applications.`);
  }

  logActivity({
    id: crypto.randomUUID(), type: 'file_opened',
    message: `Opened in DAW: ${path.basename(fv.resolved)}`,
    metadata: { action: 'openWithApp', daw: path.basename(appPath) },
  });

  if (process.platform === 'darwin') {
    return new Promise<void>((resolve, reject) => {
      execFile('open', ['-a', appPath, fv.resolved], (err) => {
        if (err) reject(new Error(`Failed to open in ${path.basename(appPath)}: ${err.message}`));
        else resolve();
      });
    });
  } else {
    return new Promise<void>((resolve, reject) => {
      execFile(appPath, [fv.resolved], (err) => {
        if (err) reject(new Error(`Failed to launch ${path.basename(appPath)}: ${err.message}`));
        else resolve();
      });
    });
  }
});

// Pick a DAW application via native file dialog
ipcMain.handle('shell:pickApp', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
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
ipcMain.handle('diagnostics:get', () => {
  const { getDiagnostics } = require('./db');
  const diag = getDiagnostics();
  const config = store.store; // electron-store's full plain-object copy
  // Sanitize: remove auth tokens, full paths in dawPaths (show basename only)
  const dawPaths = (config.dawPaths as Record<string, string> | undefined) ?? {};
  const sanitizedDawPaths: Record<string, string> = {};
  for (const [k, v] of Object.entries(dawPaths)) {
    sanitizedDawPaths[k] = typeof v === 'string' ? path.basename(v as string) : '';
  }
  return {
    appVersion: app.getVersion(),
    arch: process.arch,
    platform: process.platform,
    environment: isDev ? 'development' : 'production',
    userDataPath: app.getPath('userData').replace(app.getPath('home'), '~'),
    ...diag,
    dbSizeMB: (diag.dbSizeBytes / (1024 * 1024)).toFixed(2),
    indexedRoots: (config.watchedFolders as string[] | undefined ?? []).map((f: string) => f.replace(app.getPath('home'), '~')),
    sanitizedDawPaths,
    lastSync: config.lastSync ?? null,
    buildDate: new Date().toISOString().slice(0, 10),
  };
});

// Settings
ipcMain.handle('settings:get', (_e, key: string) => store.get(key));
ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
  store.set(key, value);
  // Wire autoStart to macOS login item
  if (key === 'autoStart') {
    app.setLoginItemSettings({ openAtLogin: !!value, openAsHidden: true });
  }
  // Wire maxConcurrent live — no restart required to take effect
  if (key === 'maxConcurrent') {
    syncAgent?.setMaxConcurrent(value as number);
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
