export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  toolOutputs?: ToolOutput[];
}

export interface ToolOutput {
  toolName: string;
  status: 'running' | 'done' | 'error';
  filePath?: string;
  description?: string;
  importGuide?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectContext {
  projectId: string | null;
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

export type CopilotMode = 'ask' | 'act';
