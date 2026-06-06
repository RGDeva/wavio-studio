import { contextBridge, ipcRenderer } from 'electron';

const ALLOWED_CHANNELS = new Set(['watcher:event', 'sync:progress', 'auth:token-received', 'update:ready', 'tray:sync-now', 'context:updated', 'copilot:tool:done', 'bounce:detected', 'version:created', 'musehub:session', 'musehub:error']);
const ALLOWED_SETTINGS_KEYS = new Set(['theme', 'autoSync', 'syncInterval', 'serverUrl', 'autoStart', 'syncOnSave', 'chunkSizeMB', 'maxConcurrent']);

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
    toggle: () => ipcRenderer.invoke('copilot:toggle'),
  },

  // Ableton DAW Companion
  ableton: {
    selectFolder: () => ipcRenderer.invoke('ableton:select-folder'),
    syncToCloud: (snapshot: unknown, authToken: string) => ipcRenderer.invoke('ableton:sync-to-cloud', snapshot, authToken),
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
