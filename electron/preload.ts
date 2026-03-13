import { contextBridge, ipcRenderer } from 'electron';

const ALLOWED_CHANNELS = new Set(['watcher:event', 'sync:progress', 'auth:token-received', 'update:ready', 'tray:sync-now']);
const ALLOWED_SETTINGS_KEYS = new Set(['theme', 'autoSync', 'syncInterval', 'serverUrl']);

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
