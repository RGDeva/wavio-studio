import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import { initDatabase, getProjects, getProjectById, getFilesByProject, getAllFiles, searchFiles, getFileStats, getActivityLog, upsertStandaloneFile, logActivity, enqueueSyncItem } from './db';
import { detectBpm } from './bpmDetector';
import { analyzeAudio } from './audioAnalyzer';
import { classifyFile } from './classifier';
import crypto from 'crypto';
import { WatcherManager } from './watcher';
import { SyncAgent } from './syncAgent';
import Store from 'electron-store';
import * as Sentry from '@sentry/electron/main';

Sentry.init({ dsn: process.env.SENTRY_DSN });

// Register wavi:// deep-link protocol
if (!app.isDefaultProtocolClient('wavi')) {
  app.setAsDefaultProtocolClient('wavi');
}

const store = new Store();
let mainWindow: BrowserWindow | null = null;
let watcherManager: WatcherManager | null = null;
let syncAgent: SyncAgent | null = null;
let tray: Tray | null = null;

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

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Init database
  const db = initDatabase();

  // Init watcher manager
  watcherManager = new WatcherManager(db, (event) => {
    mainWindow?.webContents.send('watcher:event', event);
  });

  // Init sync agent
  syncAgent = new SyncAgent(db, (progress) => {
    mainWindow?.webContents.send('sync:progress', progress);
    // Rebuild tray so status label stays current
    rebuildTrayMenu();
  });

  // Restore watched folders from store
  const folders = store.get('watchedFolders', []) as string[];
  for (const folder of folders) {
    watcherManager.addFolder(folder);
  }

  // Auto-discover DAW + audio folders on very first launch
  if (!store.get('didAutoDiscover', false)) {
    store.set('didAutoDiscover', true);
    const discovered = discoverDawFolders();
    // Also add common audio locations so loose audio files auto-populate
    const audioFolders = [
      app.getPath('music'),
      app.getPath('desktop'),
      path.join(app.getPath('home'), 'Downloads'),
    ].filter(p => { try { return require('fs').statSync(p).isDirectory(); } catch { return false; } });
    const allFolders = [...new Set([...discovered, ...audioFolders])];
    for (const folder of allFolders) {
      const current = store.get('watchedFolders', []) as string[];
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
      app.getPath('music'),
      app.getPath('desktop'),
      path.join(app.getPath('home'), 'Downloads'),
    ].filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    for (const folder of audioFolders) {
      const current = store.get('watchedFolders', []) as string[];
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
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('error', () => {}); // non-fatal — no network / no new release
      autoUpdater.on('update-downloaded', () => mainWindow?.webContents.send('update:ready'));
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch { /* skip if module unavailable */ }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    syncAgent?.stop();
    watcherManager?.stopAll();
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
      click: () => {
        syncAgent?.stop();
        watcherManager?.stopAll();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// Deep-link: wavi://auth?token=wv_...
// macOS: open-url fires when app is already running
app.on('open-url', (_event, url) => {
  handleDeepLink(url);
});

// Windows/Linux: second-instance fires with argv containing the URL
app.on('second-instance', (_event, argv) => {
  const url = argv.find(arg => arg.startsWith('wavi://'));
  if (url) handleDeepLink(url);
  // Focus existing window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function handleDeepLink(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'auth') {
      const token = parsed.searchParams.get('token');
      if (token && token.length > 10) {
        const toStore = safeStorage.isEncryptionAvailable()
          ? safeStorage.encryptString(token).toString('base64')
          : token;
        store.set('authToken', toStore);
        syncAgent?.setAuthToken(token);
        mainWindow?.webContents.send('auth:token-received', token);
        rebuildTrayMenu();
      }
    }
  } catch (e) {
    Sentry.captureException(e);
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

  // Insert immediately so it shows in Library
  const id = upsertStandaloneFile({
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
    // General music folders
    music,
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
            return ['.ptx', '.ptf', '.flp', '.als', '.logicx', '.rpp', '.cpr', '.band'].includes(ext);
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

// Folders
ipcMain.handle('folders:getAll', () => {
  return store.get('watchedFolders', []);
});

ipcMain.handle('folders:discover', () => {
  return discoverDawFolders();
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
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('wavi.stream')) return;
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
ipcMain.handle('settings:set', (_e, key: string, value: unknown) => store.set(key, value));

// App
ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});
