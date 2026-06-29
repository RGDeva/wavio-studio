export interface Project {
  id: string;
  project_name: string;
  file_path: string;
  daw_type: string;
  file_size: number;
  version_count: number;
  sync_status: 'pending' | 'uploading' | 'synced' | 'failed' | 'missing';
  cloud_id: string | null;
  created_at: string;
  modified_at: string;
  last_synced_at: string | null;
}

export interface ProjectFile {
  id: string;
  project_id: string;
  file_path: string;
  file_name: string;
  file_type: string;
  file_size: number;
  sync_status: 'pending' | 'uploading' | 'synced' | 'failed' | 'missing';
  cloud_url: string | null;
  checksum: string | null;
  created_at: string;
  modified_at: string;
}

export interface SyncQueueItem {
  id: string;
  project_id: string;
  file_id: string | null;
  file_name: string | null;
  type: string;
  status: 'pending' | 'uploading' | 'retrying' | 'completed' | 'failed';
  priority: number;
  retries: number;
  max_retries: number;
  error_message: string | null;
  upload_offset: number;
  upload_url: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ActivityEntry {
  id: string;
  type: string;
  message: string;
  project_id: string | null;
  file_id: string | null;
  metadata: string | null;
  created_at: string;
}

export interface SyncProgress {
  itemId: string;
  projectId: string;
  type: string;
  status: string;
  bytesUploaded?: number;
  bytesTotal?: number;
  percentage?: number;
  error?: string;
}

export interface LibraryFile {
  id: string;
  project_id: string;
  file_path: string;
  file_name: string;
  file_type: string;
  file_size: number;
  sync_status: 'pending' | 'uploading' | 'synced' | 'failed' | 'missing';
  cloud_url: string | null;
  checksum: string | null;
  bpm: number | null;
  key_note: string | null;
  duration: number | null;
  role: string;
  created_at: string;
  modified_at: string;
  // Joined from projects table
  project_name: string | null;
  daw_type: string | null;
}

export interface FileStats {
  totalFiles: number;
  totalSize: number;
  syncedFiles: number;
  byType: { file_type: string; count: number }[];
  byRole: { role: string; count: number }[];
}

export type Page = 'dashboard' | 'library' | 'folders' | 'activity' | 'studio' | 'settings' | 'review' | 'search' | 'copilot' | 'ableton' | 'diagnostics';

export interface MemoryEntry {
  id: string;
  key: string;
  value: string;
  category: 'project' | 'preference' | 'note' | 'context';
  createdAt: string;
  updatedAt: string;
}

export interface AssociationQueueItem {
  id: string;
  file_ids: string[];
  suggested_project_id: string | null;
  relationship: 'same_project' | 'stem_of' | 'version_of' | 'exported_from' | 'duplicate_of' | 'reference_for';
  confidence: number;
  signals: {
    sameFolder?: boolean;
    parentChildFolder?: boolean;
    sharedHint?: string | null;
    tokenOverlap?: number;
    timestampProximity?: boolean;
    hasDawProject?: boolean;
    hasExportFile?: boolean;
    exportUnderProject?: boolean;
    suggestedProjectName?: string;
    fileCount?: number;
    roles?: string[];
    [key: string]: unknown;
  };
  status: 'pending' | 'confirmed' | 'rejected' | 'deferred';
  shown_at: number | null;
  resolved_at: number | null;
  created_at: number;
}
