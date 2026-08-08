declare global {
  interface Window {
    waviAPI: WaviAPI;
  }
}

export interface FolderClassification {
  path: string;
  audioFileCount: number;
  projectFileCount: number;
  likelySampleLibrary: boolean;
  reason: 'name_match' | 'high_audio_ratio' | 'none';
}

/** A locally-known link from the desktop links registry (Links page). */
export interface LinkListItem {
  tracking_id: string;
  kind: 'listen' | 'project';
  project_id: string | null;
  project_name: string | null;
  asset_id: string | null;
  version_id: string | null;
  url: string;
  label: string | null;
  allow_download: number;
  collaborator_mode: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  /** Owning account (server Privy DID); null = legacy/ownership-unknown. */
  account_id?: string | null;
}

/** Reply from copilot chat: plain text, or text plus a pending confirmation
 *  that the renderer must surface as a card (the model cannot self-confirm). */
export type CopilotChatReply = string | {
  content: string;
  pendingConfirmation: { tool: string; params: Record<string, unknown>; summary: string };
};

/** Result of sync:prioritizeProject ("Sync This Project", D3). */
export type PrioritizeResult =
  | { needsConfirmation: true; retryCount: number }
  | { needsConfirmation: false; bumped: number; requeued: number; blockedPermanent: number; skippedMissing: number };

export interface WaviAPI {
  auth: {
    getToken: () => Promise<string | null>;
    setToken: (token: string) => Promise<void>;
    clearToken: () => Promise<void>;
  };
  copilot: {
    toggle:     () => Promise<void>;
    getContext: (projectId?: string | null) => Promise<any>;
    runTool:    (toolName: string, params: Record<string, unknown>, projectId?: string | null) =>
      Promise<{ status: string; message?: string; error?: string; projectId?: string; blockedReason?: string; data?: unknown }>;
    chat:       (messages: Array<{role:string;content:string}>, context: any) => Promise<CopilotChatReply>;
    confirmTool: (toolName: string, params: Record<string, unknown>, context: any) =>
      Promise<{ status: string; message?: string; error?: string; projectId?: string; blockedReason?: string; data?: unknown }>;
  };
  folders: {
    getAll: () => Promise<string[]>;
    add: () => Promise<string | null | { needsConfirmation: true; classification: FolderClassification } | { needsConfirmation: false; path: string }>;
    remove: (folderPath: string) => Promise<void>;
    discover: () => Promise<string[]>;
    addPath: (folderPath: string, opts?: { force?: boolean }) => Promise<{ needsConfirmation: true; classification: FolderClassification } | { needsConfirmation: false; path: string }>;
    confirmAmbiguous: (folderPath: string) => Promise<{ needsConfirmation: false; path: string }>;
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
  daw: {
    getCapabilities: (opts: { dawType?: string | null; filePath?: string | null }) => Promise<{
      id: string;
      displayName: string;
      capabilities: {
        detect: boolean; packageNative: boolean; restore: boolean; sameDawOpen: boolean;
        crossDawReconstruct: boolean; scanPlugins: boolean; fidelityReport: boolean;
      };
    }>;
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
    pause: () => Promise<string>;
    resume: () => Promise<string>;
    isPausedByUser: () => Promise<boolean>;
    prioritizeProject: (projectId: string, opts?: { force?: boolean }) => Promise<PrioritizeResult>;
    cancelItem: (itemId: string) => Promise<boolean>;
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
      projectId?: string;
      allowDownload?: boolean;
      password?: string;
      expiresAt?: string;
    }) => Promise<{ shareUrl?: string; trackingId?: string; reused?: boolean; error?: string }>;
    revokeLink: (opts: { trackingId: string; projectId?: string }) =>
      Promise<{ success?: boolean; error?: string }>;
  };
  links: {
    getAll: () => Promise<LinkListItem[]>;
    rename: (opts: { trackingId: string; label: string | null }) => Promise<{ success?: boolean; error?: string }>;
    revoke: (opts: { trackingId: string }) => Promise<{ success?: boolean; error?: string }>;
  };
  /** Authoritative Project Links (locked Codex contract). Token/DID stay in main. */
  projectLinks: {
    reconcile: (filter?: { projectId?: string; versionId?: string }) =>
      Promise<{ accountId?: string; applied?: number; reconciliationNeeded?: number; total?: number; pageComplete?: boolean; error?: string; reason?: string }>;
    getScoped: () => Promise<{ accountId: string | null; scoped: LinkListItem[]; legacy: LinkListItem[] }>;
    create: (opts: { projectId: string; projectVersionId?: string; allowDownload?: boolean; expiresAt?: string | null; collaboratorMode?: 'view' | 'comment' }) =>
      Promise<{ ok?: boolean; accountId?: string; trackingId?: string; url?: string; error?: string; reason?: string }>;
    revoke: (opts: { trackingId: string }) =>
      Promise<{ ok?: boolean; accountId?: string; alreadyRevoked?: boolean; error?: string; reason?: string }>;
  };
  project: {
    publishVersion: (opts: { localProjectId: string }) => Promise<{ versionId?: string; versionNumber?: number; fileCount?: number; created?: boolean; skipped?: boolean; error?: string }>;
    createLink: (opts: {
      projectId: string;
      cloudProjectId?: string;
      projectVersionId?: string;
      allowDownload?: boolean;
      expiresAt?: string;
      collaboratorMode?: 'view' | 'comment' | 'edit';
    }) => Promise<{ linkUrl?: string; trackingId?: string; versionId?: string; error?: string }>;
    revokeLink: (opts: { trackingId: string }) => Promise<{ success?: boolean; error?: string }>;
    getCloudFiles: (opts: { cloudProjectId: string }) => Promise<{ assets?: unknown[]; versions?: unknown[]; error?: string }>;
    onOpenLink: (cb: (data: { token: string }) => void) => void;
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
    channel: 'production' | 'qa' | 'development';
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
  restore: {
    resolve:         (token: string)                     => Promise<Record<string, unknown>>;
    checkExisting:   (shareId: string)                   => Promise<Record<string, unknown> | null>;
    pickDestination: (defaultName: string)               => Promise<string | null>;
    start:           (opts: Record<string, unknown>)     => Promise<Record<string, unknown>>;
    openExisting:    (restoreId: string)                 => Promise<{ ok: boolean }>;
    onProgress:      (cb: (data: Record<string, unknown>) => void) => void;
  };
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  off: (channel: string, listener: (...args: unknown[]) => void) => void;
}

const _noop = () => Promise.resolve(null as any);
const _stub: WaviAPI = {
  auth: { getToken: _noop, setToken: _noop, clearToken: _noop },
  copilot: { toggle: _noop, getContext: _noop, runTool: _noop, chat: _noop, confirmTool: _noop },
  folders: { getAll: () => Promise.resolve([]), add: _noop, remove: _noop, discover: () => Promise.resolve([]), addPath: _noop, confirmAmbiguous: _noop, rescan: _noop, scanMeta: () => Promise.resolve({}), fileCounts: () => Promise.resolve({}), excludePath: _noop, getExcluded: () => Promise.resolve([]), unexcludePath: _noop },
  projects: { getAll: () => Promise.resolve([]), getById: _noop, getDemoStatus: _noop },
  daw: { getCapabilities: () => Promise.resolve({ id: 'generic', displayName: 'DAW project', capabilities: { detect: false, packageNative: false, restore: true, sameDawOpen: false, crossDawReconstruct: false, scanPlugins: false, fidelityReport: false } }) },
  files: { getByProject: () => Promise.resolve([]), getAll: () => Promise.resolve([]), search: () => Promise.resolve([]), stats: () => Promise.resolve({ totalFiles: 0, totalSize: 0, syncedFiles: 0, byType: [], byRole: [] }), import: () => Promise.resolve([]), addViaDialog: () => Promise.resolve([]), discoverAll: () => Promise.resolve({ found: 0, imported: 0, duplicates: 0, scanned: 0, permissionErrors: 0, durationMs: 0, cancelled: false, limitReached: false }), discoverCancel: _noop, defaultDiscoveryRoots: () => Promise.resolve([]) },
  sync: { getQueue: () => Promise.resolve([]), retryAll: _noop, getStatus: () => Promise.resolve('idle'), now: _noop, pause: () => Promise.resolve('idle'), resume: () => Promise.resolve('idle'), isPausedByUser: () => Promise.resolve(false), prioritizeProject: () => Promise.resolve({ needsConfirmation: false as const, bumped: 0, requeued: 0, blockedPermanent: 0, skippedMissing: 0 }), cancelItem: () => Promise.resolve(false) },
  activity: { getAll: () => Promise.resolve([]) },
  shell: { openPath: _noop, openExternal: _noop, revealInFinder: _noop, openWithApp: _noop, pickApp: _noop },
  share: { createLink: _noop, revokeLink: _noop },
  links: { getAll: () => Promise.resolve([]), rename: _noop, revoke: _noop },
  projectLinks: { reconcile: () => Promise.resolve({}), getScoped: () => Promise.resolve({ accountId: null, scoped: [], legacy: [] }), create: _noop, revoke: _noop },
  project: { publishVersion: _noop, createLink: _noop, revokeLink: _noop, getCloudFiles: _noop, onOpenLink: () => {} },
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
  config: { apiBase: 'https://wavi.stream/api', channel: 'production' },
  diagnostics: { get: _noop },
  restore: {
    resolve: _noop,
    checkExisting: () => Promise.resolve(null),
    pickDestination: () => Promise.resolve(null),
    start: _noop,
    openExisting: _noop,
    onProgress: () => {},
  },
  on: () => {},
  off: () => {},
};
export const api: WaviAPI = (window as any).waviAPI ?? _stub;
