// Shared types used by both the electron main process and the overlay renderer.
// Kept in electron/ so it stays within tsconfig.electron.json rootDir.

export interface ProjectContext {
  projectId: string | null;
  /** Immutable version currently selected in the renderer, when applicable. */
  versionId?: string | null;
  projectName: string | null;
  dawType: string | null;
  filePath: string | null;
  versionCount: number;
  lastSyncedAt: string | null;
  files: ProjectFile[];
  cloudProject: CloudProjectSnapshot | null;
}

export interface ProjectFile {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  role: string;
  bpm: number | null;
  keyNote: string | null;
  syncStatus: string;
  cloudUrl: string | null;
}

export interface CloudProjectSnapshot {
  projectId: string;
  name: string;
  daw: string | null;
  versions: CloudVersion[];
  assets: CloudAsset[];
  collaborators: string[];
  latestExport: CloudAsset | null;
}

export interface CloudVersion {
  id: string;
  versionNumber: number;
  syncedAt: string;
  fileSize: number;
}

export interface CloudAsset {
  id: string;
  name: string;
  fileUrl: string;
  format: string;
  createdAt: string;
  role: string | null;
}
