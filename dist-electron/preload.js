"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const API_BASE_PRELOAD = (process.env.WAVI_API_BASE_URL ?? 'https://wavi.stream/api').replace(/\/$/, '');
const ALLOWED_CHANNELS = new Set(['watcher:event', 'sync:progress', 'auth:token-received', 'update:ready', 'tray:sync-now', 'context:updated', 'copilot:tool:done', 'bounce:detected', 'version:created', 'musehub:session', 'musehub:error', 'main:ready', 'discovery:progress']);
const ALLOWED_SETTINGS_KEYS = new Set(['theme', 'autoSync', 'syncInterval', 'serverUrl', 'autoStart', 'syncOnSave', 'chunkSizeMB', 'maxConcurrent', 'dawPaths']);
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
        discoverAll: (opts) => electron_1.ipcRenderer.invoke('files:discoverAll', opts),
        discoverCancel: () => electron_1.ipcRenderer.invoke('files:discoverCancel'),
        defaultDiscoveryRoots: () => electron_1.ipcRenderer.invoke('files:defaultDiscoveryRoots'),
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
        revealInFinder: (p) => electron_1.ipcRenderer.invoke('shell:revealInFinder', p),
        openWithApp: (filePath, appPath) => electron_1.ipcRenderer.invoke('shell:openWithApp', filePath, appPath),
        pickApp: () => electron_1.ipcRenderer.invoke('shell:pickApp'),
    },
    // Share links
    share: {
        createLink: (opts) => electron_1.ipcRenderer.invoke('share:createLink', opts),
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
        getContext: () => electron_1.ipcRenderer.invoke('copilot:getContext'),
        chat: (messages, context) => electron_1.ipcRenderer.invoke('copilot:chat', messages, context),
    },
    // Ableton DAW Companion
    ableton: {
        selectFolder: () => electron_1.ipcRenderer.invoke('ableton:select-folder'),
        syncToCloud: (snapshot, authToken) => electron_1.ipcRenderer.invoke('ableton:sync-to-cloud', snapshot, authToken),
    },
    // Memory (Copilot persistent context)
    memory: {
        list: () => electron_1.ipcRenderer.invoke('memory:list'),
        get: (key) => electron_1.ipcRenderer.invoke('memory:get', key),
        set: (key, value, category) => electron_1.ipcRenderer.invoke('memory:set', key, value, category),
        delete: (key) => electron_1.ipcRenderer.invoke('memory:delete', key),
    },
    // Config exposed to renderer (safe, non-secret values only)
    config: {
        apiBase: API_BASE_PRELOAD,
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
