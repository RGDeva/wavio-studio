import { contextBridge, ipcRenderer } from 'electron';

const API_BASE_PRELOAD = (process.env.WAVI_API_BASE_URL ?? 'https://wavi.stream/api').replace(/\/$/, '');

const ALLOWED_CHANNELS = new Set(['watcher:event', 'sync:progress', 'auth:token-received', 'update:ready', 'tray:sync-now', 'context:updated', 'copilot:tool:done', 'bounce:detected', 'version:created', 'musehub:session', 'musehub:error', 'main:ready', 'discovery:progress']);
const ALLOWED_SETTINGS_KEYS = new Set(['theme', 'autoSync', 'syncInterval', 'serverUrl', 'autoStart', 'syncOnSave', 'chunkSizeMB', 'maxConcurrent', 'dawPaths']);

contextBridge.exposeInMainWorld('waviAPI', {
  // Auth
  auth: {
    getToken: () => ipcRenderer.invoke('auth:getToken'),
    setToken: (token: string) => ipcRenderer.invoke('auth:setToken', token),
    clearToken: () => ipcRenderer.invoke('auth:clearToken'),
  },

  // Folders
  folders: {
    getAll: () => ipcRenderer.invoke('folders:getAll'),
    add: () => ipcRenderer.invoke('folders:add'),
    remove: (folderPath: string) => ipcRenderer.invoke('folders:remove', folderPath),
    discover: () => ipcRenderer.invoke('folders:discover'),
    addPath: (folderPath: string) => ipcRenderer.invoke('folders:addPath', folderPath),
  },

  // Projects
  projects: {
    getAll: () => ipcRenderer.invoke('projects:getAll'),
    getById: (id: string) => ipcRenderer.invoke('projects:getById', id),
    getDemoStatus: (projectId: string) => ipcRenderer.invoke('projects:getDemoStatus', projectId),
  },

  // Files
  files: {
    getByProject: (projectId: string) => ipcRenderer.invoke('files:getByProject', projectId),
    getAll: (limit?: number, offset?: number) => ipcRenderer.invoke('files:getAll', limit, offset),
    search: (query: string) => ipcRenderer.invoke('files:search', query),
    stats: () => ipcRenderer.invoke('files:stats'),
    import: (filePaths: string[]) => ipcRenderer.invoke('files:import', filePaths),
    addViaDialog: () => ipcRenderer.invoke('files:addViaDialog'),
    discoverAll: (opts?: { roots?: string[]; extraRoots?: string[]; excludePaths?: string[]; maxFiles?: number; maxDurationMs?: number }) =>
      ipcRenderer.invoke('files:discoverAll', opts),
    discoverCancel: () => ipcRenderer.invoke('files:discoverCancel'),
    defaultDiscoveryRoots: () => ipcRenderer.invoke('files:defaultDiscoveryRoots'),
  },

  // Sync
  sync: {
    getQueue: () => ipcRenderer.invoke('sync:getQueue'),
    retryAll: () => ipcRenderer.invoke('sync:retryAll'),
    getStatus: () => ipcRenderer.invoke('sync:getStatus'),
    now: () => ipcRenderer.invoke('sync:now'),
  },

  // Activity
  activity: {
    getAll: () => ipcRenderer.invoke('activity:getAll'),
  },

  // Shell
  shell: {
    openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    revealInFinder: (p: string) => ipcRenderer.invoke('shell:revealInFinder', p),
    openWithApp: (filePath: string, appPath: string) => ipcRenderer.invoke('shell:openWithApp', filePath, appPath),
    pickApp: () => ipcRenderer.invoke('shell:pickApp'),
  },

  // Share links
  share: {
    createLink: (opts: {
      assetId: string;
      allowDownload?: boolean;
      password?: string;
      expiresAt?: string;
    }) => ipcRenderer.invoke('share:createLink', opts),
  },

  // App
  app: {
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
  },

  // Bounce candidates / version confirmation
  bounces: {
    getPending: () => ipcRenderer.invoke('bounces:getPending'),
    resolve: (id: string, action: string) => ipcRenderer.invoke('bounces:resolve', id, action),
  },

  // Versions
  versions: {
    getByProject: (projectId: string) => ipcRenderer.invoke('versions:getByProject', projectId),
  },

  // Copilot
  copilot: {
    toggle:     () => ipcRenderer.invoke('copilot:toggle'),
    getContext: () => ipcRenderer.invoke('copilot:getContext'),
    chat:       (messages: unknown[], context: unknown) => ipcRenderer.invoke('copilot:chat', messages, context),
  },

  // Ableton DAW Companion
  ableton: {
    selectFolder: () => ipcRenderer.invoke('ableton:select-folder'),
    syncToCloud: (snapshot: unknown, authToken: string) => ipcRenderer.invoke('ableton:sync-to-cloud', snapshot, authToken),
  },

  // Memory (Copilot persistent context)
  memory: {
    list:   ()                                              => ipcRenderer.invoke('memory:list'),
    get:    (key: string)                                   => ipcRenderer.invoke('memory:get', key),
    set:    (key: string, value: string, category?: string) => ipcRenderer.invoke('memory:set', key, value, category),
    delete: (key: string)                                   => ipcRenderer.invoke('memory:delete', key),
  },

  // Config exposed to renderer (safe, non-secret values only)
  config: {
    apiBase: API_BASE_PRELOAD,
  },

  // Bridge status
  bridge: {
    getStatus: () => ipcRenderer.invoke('bridge:getStatus'),
  },

  // MuseHub
  musehub: {
    isSession:      ()  => ipcRenderer.invoke('musehub:isSession'),
    getUserInfo:    ()  => ipcRenderer.invoke('musehub:getUserInfo'),
    getEntitlement: ()  => ipcRenderer.invoke('musehub:getEntitlement'),
    checkUsage:     ()  => ipcRenderer.invoke('musehub:checkUsage'),
    refreshSession: ()  => ipcRenderer.invoke('musehub:refreshSession'),
  },

  // Association Engine (Phase 1)
  association: {
    getPending:   ()                                   => ipcRenderer.invoke('association:getPending'),
    confirm:      (queueId: string, name?: string)     => ipcRenderer.invoke('association:confirm', queueId, name),
    reject:       (queueId: string)                    => ipcRenderer.invoke('association:reject', queueId),
    undo:         (associationId: string)              => ipcRenderer.invoke('association:undo', associationId),
    classifyFile: (filePath: string)                   => ipcRenderer.invoke('association:classifyFile', filePath),
  },

  // Settings (restricted to safe keys)
  settings: {
    get: (key: string) => {
      if (!ALLOWED_SETTINGS_KEYS.has(key)) return Promise.resolve(null);
      return ipcRenderer.invoke('settings:get', key);
    },
    set: (key: string, value: unknown) => {
      if (!ALLOWED_SETTINGS_KEYS.has(key)) return Promise.resolve();
      return ipcRenderer.invoke('settings:set', key, value);
    },
  },

  // Event listeners (restricted to safe channels)
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    if (!ALLOWED_CHANNELS.has(channel)) return;
    ipcRenderer.on(channel, (_event, ...args) => listener(...args));
  },
  off: (channel: string, listener: (...args: unknown[]) => void) => {
    if (!ALLOWED_CHANNELS.has(channel)) return;
    ipcRenderer.removeListener(channel, listener);
  },
});
