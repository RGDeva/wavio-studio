"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const ALLOWED_CHANNELS = new Set(['watcher:event', 'sync:progress', 'auth:token-received', 'update:ready', 'tray:sync-now', 'context:updated', 'copilot:tool:done', 'bounce:detected', 'version:created', 'musehub:session', 'musehub:error']);
const ALLOWED_SETTINGS_KEYS = new Set(['theme', 'autoSync', 'syncInterval', 'serverUrl', 'autoStart', 'syncOnSave', 'chunkSizeMB', 'maxConcurrent']);
electron_1.contextBridge.exposeInMainWorld('waviAPI', {
    // Auth
    auth: {
        getToken: () => electron_1.ipcRenderer.invoke('auth:getToken'),
        setToken: (token) => electron_1.ipcRenderer.invoke('auth:setToken', token),
        clearToken: () => electron_1.ipcRenderer.invoke('auth:clearToken'),
    },
    // Folders
    folders: {
        getAll: () => electron_1.ipcRenderer.invoke('folders:getAll'),
        add: () => electron_1.ipcRenderer.invoke('folders:add'),
        remove: (folderPath) => electron_1.ipcRenderer.invoke('folders:remove', folderPath),
        discover: () => electron_1.ipcRenderer.invoke('folders:discover'),
        addPath: (folderPath) => electron_1.ipcRenderer.invoke('folders:addPath', folderPath),
    },
    // Projects
    projects: {
        getAll: () => electron_1.ipcRenderer.invoke('projects:getAll'),
        getById: (id) => electron_1.ipcRenderer.invoke('projects:getById', id),
        getDemoStatus: (projectId) => electron_1.ipcRenderer.invoke('projects:getDemoStatus', projectId),
    },
    // Files
    files: {
        getByProject: (projectId) => electron_1.ipcRenderer.invoke('files:getByProject', projectId),
        getAll: (limit, offset) => electron_1.ipcRenderer.invoke('files:getAll', limit, offset),
        search: (query) => electron_1.ipcRenderer.invoke('files:search', query),
        stats: () => electron_1.ipcRenderer.invoke('files:stats'),
        import: (filePaths) => electron_1.ipcRenderer.invoke('files:import', filePaths),
        addViaDialog: () => electron_1.ipcRenderer.invoke('files:addViaDialog'),
    },
    // Sync
    sync: {
        getQueue: () => electron_1.ipcRenderer.invoke('sync:getQueue'),
        retryAll: () => electron_1.ipcRenderer.invoke('sync:retryAll'),
        getStatus: () => electron_1.ipcRenderer.invoke('sync:getStatus'),
        now: () => electron_1.ipcRenderer.invoke('sync:now'),
    },
    // Activity
    activity: {
        getAll: () => electron_1.ipcRenderer.invoke('activity:getAll'),
    },
    // Shell
    shell: {
        openPath: (p) => electron_1.ipcRenderer.invoke('shell:openPath', p),
        openExternal: (url) => electron_1.ipcRenderer.invoke('shell:openExternal', url),
    },
    // App
    app: {
        relaunch: () => electron_1.ipcRenderer.invoke('app:relaunch'),
    },
    // Bounce candidates / version confirmation
    bounces: {
        getPending: () => electron_1.ipcRenderer.invoke('bounces:getPending'),
        resolve: (id, action) => electron_1.ipcRenderer.invoke('bounces:resolve', id, action),
    },
    // Versions
    versions: {
        getByProject: (projectId) => electron_1.ipcRenderer.invoke('versions:getByProject', projectId),
    },
    // Copilot
    copilot: {
        toggle: () => electron_1.ipcRenderer.invoke('copilot:toggle'),
    },
    // Bridge status
    bridge: {
        getStatus: () => electron_1.ipcRenderer.invoke('bridge:getStatus'),
    },
    // MuseHub
    musehub: {
        isSession: () => electron_1.ipcRenderer.invoke('musehub:isSession'),
        getUserInfo: () => electron_1.ipcRenderer.invoke('musehub:getUserInfo'),
        getEntitlement: () => electron_1.ipcRenderer.invoke('musehub:getEntitlement'),
        checkUsage: () => electron_1.ipcRenderer.invoke('musehub:checkUsage'),
        refreshSession: () => electron_1.ipcRenderer.invoke('musehub:refreshSession'),
    },
    // Association Engine (Phase 1)
    association: {
        getPending: () => electron_1.ipcRenderer.invoke('association:getPending'),
        confirm: (queueId, name) => electron_1.ipcRenderer.invoke('association:confirm', queueId, name),
        reject: (queueId) => electron_1.ipcRenderer.invoke('association:reject', queueId),
        undo: (associationId) => electron_1.ipcRenderer.invoke('association:undo', associationId),
        classifyFile: (filePath) => electron_1.ipcRenderer.invoke('association:classifyFile', filePath),
    },
    // Settings (restricted to safe keys)
    settings: {
        get: (key) => {
            if (!ALLOWED_SETTINGS_KEYS.has(key))
                return Promise.resolve(null);
            return electron_1.ipcRenderer.invoke('settings:get', key);
        },
        set: (key, value) => {
            if (!ALLOWED_SETTINGS_KEYS.has(key))
                return Promise.resolve();
            return electron_1.ipcRenderer.invoke('settings:set', key, value);
        },
    },
    // Event listeners (restricted to safe channels)
    on: (channel, listener) => {
        if (!ALLOWED_CHANNELS.has(channel))
            return;
        electron_1.ipcRenderer.on(channel, (_event, ...args) => listener(...args));
    },
    off: (channel, listener) => {
        if (!ALLOWED_CHANNELS.has(channel))
            return;
        electron_1.ipcRenderer.removeListener(channel, listener);
    },
});
