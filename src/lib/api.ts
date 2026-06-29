declare global {
  interface Window {
    waviAPI: WaviAPI;
  }
}

export interface WaviAPI {
  auth: {
    getToken: () => Promise<string | null>;
    setToken: (token: string) => Promise<void>;
    clearToken: () => Promise<void>;
  };
  copilot: {
    toggle:     () => Promise<void>;
    getContext: () => Promise<any>;
    chat:       (messages: Array<{role:string;content:string}>, context: any) => Promise<string>;
  };
  folders: {
    getAll: () => Promise<string[]>;
    add: () => Promise<string | null>;
    remove: (folderPath: string) => Promise<void>;
    discover: () => Promise<string[]>;
    addPath: (folderPath: string) => Promise<string>;
    rescan: (folderPath: string) => Promise<{ found: number; imported: number; duplicates: number; scanned: number; durationMs: number; cancelled: boolean }>;
    scanMeta: () => Promise<Record<string, { lastScanned: string; fileCount: number }>>;
    fileCounts: () => Promise<Record<string, number>>;
    excludePath: (subPath: string) => Promise<void>;
    getExcluded: () => Promise<string[]>;
    unexcludePath: (subPath: string) => Promise<void>;
  };
  projects: {
    getAll: () => Promise<any[]>;
    getById: (id: string) => Promise<any>;
    getDemoStatus: (projectId: string) => Promise<any>;
  };
  files: {
    getByProject: (projectId: string) => Promise<any[]>;
    getAll: (limit?: number, offset?: number) => Promise<any[]>;
    search: (query: string) => Promise<any[]>;
    stats: () => Promise<{ totalFiles: number; totalSize: number; syncedFiles: number; byType: any[]; byRole: any[] }>;
    import: (filePaths: string[]) => Promise<string[]>;
    addViaDialog: () => Promise<string[]>;
    discoverAll: (opts?: { roots?: string[]; extraRoots?: string[]; excludePaths?: string[]; maxFiles?: number; maxDurationMs?: number }) =>
      Promise<{ found: number; imported: number; duplicates: number; scanned: number; permissionErrors: number; durationMs: number; cancelled: boolean; limitReached: boolean }>;
    discoverCancel: () => Promise<void>;
    defaultDiscoveryRoots: () => Promise<string[]>;
  };
  sync: {
    getQueue: () => Promise<any[]>;
    retryAll: () => Promise<void>;
    getStatus: () => Promise<string>;
    now: () => Promise<void>;
  };
  activity: {
    getAll: () => Promise<any[]>;
  };
  shell: {
    openPath: (p: string) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    revealInFinder: (p: string) => Promise<void>;
    openWithApp: (filePath: string, appPath: string) => Promise<void>;
    pickApp: () => Promise<string | null>;
  };
  share: {
    createLink: (opts: {
      assetId: string;
      allowDownload?: boolean;
      password?: string;
      expiresAt?: string;
    }) => Promise<{ shareUrl?: string; trackingId?: string; reused?: boolean; error?: string }>;
  };
  app: {
    relaunch: () => Promise<void>;
  };
  bounces: {
    getPending: () => Promise<any[]>;
    resolve: (id: string, action: string) => Promise<void>;
  };
  versions: {
    getByProject: (projectId: string) => Promise<any[]>;
  };
  settings: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  bridge: {
    getStatus: () => Promise<{
      port: number;
      host: string;
      tokenExists: boolean;
      tokenPerm: string;
      tokenHint: string;
      online: boolean;
    } | null>;
  };
  association: {
    getPending:   ()                                          => Promise<any[]>;
    confirm:      (queueId: string, name?: string)           => Promise<{ ok: boolean }>;
    reject:       (queueId: string)                          => Promise<{ ok: boolean }>;
    undo:         (associationId: string)                    => Promise<{ ok: boolean }>;
    classifyFile: (filePath: string)                         => Promise<any>;
  };
  memory: {
    list:   ()                                               => Promise<any[]>;
    get:    (key: string)                                    => Promise<string | null>;
    set:    (key: string, value: string, category?: string) => Promise<void>;
    delete: (key: string)                                    => Promise<void>;
  };
  ableton: {
    selectFolder:  ()                                        => Promise<{ canceled: boolean; folderPath?: string; snapshot?: any }>;
    syncToCloud:   (snapshot: any, authToken: string)        => Promise<{ success?: boolean; cloudProjectId?: string; error?: string }>;
  };
  config: {
    apiBase: string;
  };
  diagnostics: {
    get: () => Promise<{
      appVersion: string;
      arch: string;
      platform: string;
      environment: 'production' | 'development';
      userDataPath: string;
      fileCount: number;
      projectCount: number;
      dbSizeBytes: number;
      dbSizeMB: string;
      queueCounts: Record<string, number>;
      missingFileCount: number;
      activityLogCount: number;
      indexedRoots: string[];
      sanitizedDawPaths: Record<string, string>;
      lastSync: string | null;
      buildDate: string;
    }>;
  };
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  off: (channel: string, listener: (...args: unknown[]) => void) => void;
}

const _noop = () => Promise.resolve(null as any);
const _stub: WaviAPI = {
  auth: { getToken: _noop, setToken: _noop, clearToken: _noop },
  copilot: { toggle: _noop, getContext: _noop, chat: _noop },
  folders: { getAll: () => Promise.resolve([]), add: _noop, remove: _noop, discover: () => Promise.resolve([]), addPath: _noop, rescan: _noop, scanMeta: () => Promise.resolve({}), fileCounts: () => Promise.resolve({}), excludePath: _noop, getExcluded: () => Promise.resolve([]), unexcludePath: _noop },
  projects: { getAll: () => Promise.resolve([]), getById: _noop, getDemoStatus: _noop },
  files: { getByProject: () => Promise.resolve([]), getAll: () => Promise.resolve([]), search: () => Promise.resolve([]), stats: () => Promise.resolve({ totalFiles: 0, totalSize: 0, syncedFiles: 0, byType: [], byRole: [] }), import: () => Promise.resolve([]), addViaDialog: () => Promise.resolve([]), discoverAll: () => Promise.resolve({ found: 0, imported: 0, duplicates: 0, scanned: 0, permissionErrors: 0, durationMs: 0, cancelled: false, limitReached: false }), discoverCancel: _noop, defaultDiscoveryRoots: () => Promise.resolve([]) },
  sync: { getQueue: () => Promise.resolve([]), retryAll: _noop, getStatus: () => Promise.resolve('idle'), now: _noop },
  activity: { getAll: () => Promise.resolve([]) },
  shell: { openPath: _noop, openExternal: _noop, revealInFinder: _noop, openWithApp: _noop, pickApp: _noop },
  share: { createLink: _noop },
  app: { relaunch: _noop },
  bounces: { getPending: () => Promise.resolve([]), resolve: _noop },
  versions: { getByProject: () => Promise.resolve([]) },
  settings: { get: _noop, set: _noop },
  bridge: { getStatus: () => Promise.resolve(null) },
  association: {
    getPending:   () => Promise.resolve([]),
    confirm:      _noop,
    reject:       _noop,
    undo:         _noop,
    classifyFile: _noop,
  },
  memory: {
    list:   () => Promise.resolve([]),
    get:    _noop,
    set:    _noop,
    delete: _noop,
  },
  ableton: {
    selectFolder:  () => Promise.resolve({ canceled: true }),
    syncToCloud:   _noop,
  },
  config: { apiBase: 'https://wavi.stream/api' },
  diagnostics: { get: _noop },
  on: () => {},
  off: () => {},
};
export const api: WaviAPI = (window as any).waviAPI ?? _stub;
