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
  folders: {
    getAll: () => Promise<string[]>;
    add: () => Promise<string | null>;
    remove: (folderPath: string) => Promise<void>;
    discover: () => Promise<string[]>;
    addPath: (folderPath: string) => Promise<string>;
  };
  projects: {
    getAll: () => Promise<any[]>;
    getById: (id: string) => Promise<any>;
  };
  files: {
    getByProject: (projectId: string) => Promise<any[]>;
    getAll: (limit?: number, offset?: number) => Promise<any[]>;
    search: (query: string) => Promise<any[]>;
    stats: () => Promise<{ totalFiles: number; totalSize: number; syncedFiles: number; byType: any[]; byRole: any[] }>;
    import: (filePaths: string[]) => Promise<string[]>;
    addViaDialog: () => Promise<string[]>;
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
  };
  app: {
    relaunch: () => Promise<void>;
  };
  settings: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  off: (channel: string, listener: (...args: unknown[]) => void) => void;
}

export const api: WaviAPI = (window as any).waviAPI;
