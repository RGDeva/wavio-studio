import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  getPendingSyncItems,
  updateSyncItem,
  updateProjectSyncStatus,
  updateFileSyncStatus,
  logActivity,
  getSyncQueue,
  getProjectById,
  getFilesByProject,
  getFileById,
  getDb,
} from './db';
import crypto from 'crypto';

const API_BASE = 'https://wavi.stream/api';
const POLL_INTERVAL_MS = 5000;
const MAX_CONCURRENT = 2;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000]; // 5s, 30s, 2m, 5m
const FETCH_TIMEOUT_MS = 30000; // 30 second timeout for API calls
const UPLOAD_TIMEOUT_MS = 300000; // 5 minute timeout for file uploads

// Fetch with timeout to prevent hanging
async function fetchWithTimeout(url: string, options: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const { timeout = FETCH_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
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

function generateId(): string {
  return crypto.randomUUID();
}

export class SyncAgent {
  private db: Database.Database;
  private onProgress: (progress: SyncProgress) => void;
  private authToken: string | null = null;
  private running = false;
  private pausedReason: 'auth' | 'limit' | null = null; // null = not paused
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeUploads = new Set<string>();

  constructor(db: Database.Database, onProgress: (progress: SyncProgress) => void) {
    this.db = db;
    this.onProgress = onProgress;
  }

  setAuthToken(token: string | null) {
    this.authToken = token;
    if (token) this.pausedReason = null; // resume on new token
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => this._tick(), POLL_INTERVAL_MS);
    this._tick();
  }

  /** Trigger an immediate sync cycle (called from tray or IPC). */
  tick() {
    return this._tick();
  }

  stop() {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getQueue() {
    return getSyncQueue();
  }

  getStatus(): string {
    if (this.pausedReason === 'auth') return 'paused:auth';
    if (this.pausedReason === 'limit') return 'paused:limit';
    const active = this.activeUploads.size;
    return active > 0 ? `uploading (${active} active)` : 'idle';
  }

  retryFailed() {
    this.db.prepare(`
      UPDATE sync_queue SET status = 'pending', retries = 0, error_message = NULL
      WHERE status = 'failed'
    `).run();
    this._tick();
  }

  private async _tick() {
    if (!this.authToken) return;
    if (this.pausedReason !== null) return;
    if (this.activeUploads.size >= MAX_CONCURRENT) return;

    const slots = MAX_CONCURRENT - this.activeUploads.size;
    const items = getPendingSyncItems(slots);

    for (const item of items as any[]) {
      if (this.activeUploads.has(item.id)) continue;
      this.activeUploads.add(item.id);
      this.processItem(item).finally(() => {
        this.activeUploads.delete(item.id);
      });
    }
  }

  private async processItem(item: any) {
    updateSyncItem(item.id, {
      status: 'uploading',
      started_at: new Date().toISOString(),
    });

    logActivity({
      id: generateId(),
      type: 'upload_started',
      message: `Upload started: ${item.file_name ?? item.type}`,
      project_id: item.project_id !== '__standalone__' ? item.project_id : undefined,
      metadata: { itemId: item.id, type: item.type },
    });

    this.onProgress({
      itemId: item.id, projectId: item.project_id, type: item.type,
      status: 'uploading', percentage: 0,
    });

    try {
      if (item.type === 'project_upload' || item.type === 'project_update') {
        await this.syncProject(item);
      } else if (item.type === 'dependency_upload') {
        await this.syncFile(item);
      }

      updateSyncItem(item.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
      });

      logActivity({
        id: generateId(),
        type: 'upload_complete',
        message: `Upload complete: ${item.file_name ?? item.type}`,
        project_id: item.project_id !== '__standalone__' ? item.project_id : undefined,
        metadata: { itemId: item.id },
      });
    } catch (err: any) {
      const retries = (item.retries ?? 0) + 1;
      const maxRetries = item.max_retries ?? RETRY_DELAYS_MS.length;
      const failed = retries >= maxRetries;

      // 401 = token revoked/expired — pause all syncs until re-auth
      if (err?.message?.includes('401') || err?.message?.includes('INVALID_TOKEN')) {
        this.pausedReason = 'auth';
        this.onProgress({ itemId: item.id, projectId: item.project_id, type: item.type, status: 'paused:auth' });
        return;
      }

      // 402 = plan limit reached — pause and prompt upgrade
      if (err?.message?.includes('402') || err?.message?.includes('PLAN_LIMIT')) {
        this.pausedReason = 'limit';
        this.onProgress({ itemId: item.id, projectId: item.project_id, type: item.type, status: 'paused:limit' });
        return;
      }

      const delay = failed ? 0 : RETRY_DELAYS_MS[Math.min(retries - 1, RETRY_DELAYS_MS.length - 1)]
        + Math.floor(Math.random() * 1000);
      const nextRetryAt = failed ? null : new Date(Date.now() + delay).toISOString();

      updateSyncItem(item.id, {
        status: failed ? 'failed' : 'retrying',
        retries,
        error_message: err?.message ?? 'Unknown error',
        next_retry_at: nextRetryAt,
      });

      this.onProgress({
        itemId: item.id,
        projectId: item.project_id,
        type: item.type,
        status: failed ? 'failed' : 'retrying',
        error: err?.message,
      });

      logActivity({
        id: generateId(),
        type: 'sync_error',
        message: `Sync failed: ${err?.message ?? 'Unknown error'}`,
        project_id: item.project_id,
        metadata: { itemId: item.id, retries },
      });

      // Schedule in-memory retry tick (belt-and-suspenders alongside next_retry_at DB gate)
      if (!failed) {
        setTimeout(() => this.tick(), delay);
      }
    }
  }

  private async syncProject(item: any) {
    const project = getProjectById(item.project_id) as any;
    if (!project) throw new Error('Project not found');

    // Step 1: POST project metadata to API (daw-sync)
    const res = await fetchWithTimeout(`${API_BASE}/desktop/index`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
        'X-Desktop-Action': 'daw-sync',
      },
      body: JSON.stringify({
        projectName: project.project_name,
        fileName: path.basename(project.file_path),   // basename only — no local absolute path
        localProjectId: project.id,                   // stable local UUID for server-side dedup
        daw: project.daw_type,
        fileSize: project.file_size,
        lastModified: project.modified_at,
        sha256: project.checksum ?? null,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }

    const data = await res.json();
    const cloudProjectId = data.projectId ?? data.id;
    const cloudVersionId = data.projectVersionId ?? null;
    updateProjectSyncStatus(project.id, 'synced', cloudProjectId, cloudVersionId);

    // Step 2: Upload the actual project file via presign → PUT → register-asset
    if (fs.existsSync(project.file_path)) {
      const stats = fs.statSync(project.file_path);
      const fileName = path.basename(project.file_path);

      // Get pre-signed upload URL
      const presignRes = await fetchWithTimeout(`${API_BASE}/storage/presign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({
          fileName,
          fileSize: stats.size,
          sha256: project.sha256 ?? null,
          projectId: cloudProjectId,
        }),
      });

      if (presignRes.ok) {
        const presignData = await presignRes.json();

        if (!presignData.deduplicated) {
          // PUT file directly to signed URL
          this.onProgress({
            itemId: item.id, projectId: item.project_id, type: 'project',
            status: 'uploading', bytesUploaded: 0, bytesTotal: stats.size, percentage: 0,
          });

          const fileStream = fs.createReadStream(project.file_path);
          const uploadRes = await fetchWithTimeout(presignData.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(stats.size) },
            body: fileStream as any,
            timeout: UPLOAD_TIMEOUT_MS,
            // @ts-ignore — duplex required in Node 18+
            duplex: 'half',
          });

          if (!uploadRes.ok) {
            console.error(`[syncAgent] Project file upload failed: HTTP ${uploadRes.status}`);
          } else {
            this.onProgress({
              itemId: item.id, projectId: item.project_id, type: 'project',
              status: 'uploading', bytesUploaded: stats.size, bytesTotal: stats.size, percentage: 100,
            });
          }
        }
      }
    }

    this.onProgress({
      itemId: item.id, projectId: item.project_id, type: 'project',
      status: 'completed', percentage: 100,
    });

    logActivity({
      id: generateId(),
      type: 'project_synced',
      message: `Synced project: ${project.project_name}`,
      project_id: project.id,
    });
  }

  private async syncFile(item: any) {
    let file: any;

    // Try by file_id first (fastest, most reliable)
    if (item.file_id) {
      file = getFileById(item.file_id);
    }
    // Fall back: find by file_name within the project's files
    if (!file && item.project_id && item.project_id !== '__standalone__' && item.file_name) {
      const files = getFilesByProject(item.project_id) as any[];
      file = files.find((f: any) => f.file_name === item.file_name);
    }
    // Last resort: search the DB by file_name alone
    if (!file && item.file_name) {
      file = getDb()
        .prepare('SELECT * FROM files WHERE file_name = ? ORDER BY modified_at DESC LIMIT 1')
        .get(item.file_name);
    }
    if (!file) {
      logActivity({
        id: generateId(),
        type: 'sync_error',
        message: `Skipping sync: file row not found for ${item.file_name ?? item.file_id}`,
        project_id: item.project_id !== '__standalone__' ? item.project_id : undefined,
      });
      return;
    }

    if (!fs.existsSync(file.file_path)) {
      updateFileSyncStatus(file.id, 'missing');
      return;
    }

    const stats = fs.statSync(file.file_path);

    // Step 1: Get pre-signed upload URL (handles dedup check server-side)
    const presignRes = await fetchWithTimeout(`${API_BASE}/storage/presign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify({
        fileName: file.file_name,
        fileSize: stats.size,
        sha256: file.checksum ?? null,
      }),
    });

    if (!presignRes.ok) {
      const err = await presignRes.json().catch(() => ({ error: `HTTP ${presignRes.status}` }));
      throw new Error(err.error ?? `HTTP ${presignRes.status}`);
    }

    const presignData = await presignRes.json();

    // Step 2: Upload file if not deduplicated
    if (!presignData.deduplicated) {
      const fileSize2 = stats.size;
      this.onProgress({
        itemId: item.id, projectId: item.project_id, type: 'file',
        status: 'uploading', bytesUploaded: 0, bytesTotal: fileSize2, percentage: 0,
      });
      const fileStream = fs.createReadStream(file.file_path);
      const uploadRes = await fetchWithTimeout(presignData.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fileSize2) },
        body: fileStream as any,
        timeout: UPLOAD_TIMEOUT_MS,
        // @ts-ignore — duplex required in Node 18+
        duplex: 'half',
      });

      if (!uploadRes.ok) {
        throw new Error(`Storage upload failed: HTTP ${uploadRes.status}`);
      }
      this.onProgress({
        itemId: item.id, projectId: item.project_id, type: 'file',
        status: 'uploading', bytesUploaded: fileSize2, bytesTotal: fileSize2, percentage: 99,
      });
    }

    // Step 3: ALWAYS register asset (even on dedup) so user gets an asset row in Supabase.
    // Resolve cloud project ID — local IDs do not exist in Supabase, use cloud_id.
    let daw: string | null = null;
    let projectName: string | null = null;
    let cloudProjectId: string | null = null;
    if (item.project_id && item.project_id !== '__standalone__') {
      try {
        const project = getProjectById(item.project_id) as any;
        if (project) {
          daw = project.daw_type ?? null;
          projectName = project.project_name ?? null;
          cloudProjectId = project.cloud_id ?? null; // use cloud UUID, not local UUID
        }
      } catch {}
    }

    const registerRes = await fetchWithTimeout(`${API_BASE}/desktop/index`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
        'X-Desktop-Action': 'register-asset',
      },
      body: JSON.stringify({
        fileName: file.file_name,
        storageKey: presignData.storageKey ?? presignData.fileUrl,
        fileSize: stats.size,
        sha256: file.checksum ?? null,
        projectId: cloudProjectId,   // cloud UUID or null — not the local ID
        bpm: file.bpm ?? null,
        keyNote: file.key_note ?? null,
        duration: file.duration ?? null,
        role: file.role ?? null,
        daw,
        projectName,
      }),
    });

    if (!registerRes.ok) {
      const errBody = await registerRes.json().catch(() => ({})) as any;
      throw new Error(`Asset registration failed: HTTP ${registerRes.status} — ${errBody?.error ?? 'unknown'}`);
    }
    const regData = await registerRes.json().catch(() => ({})) as any;
    // Store cloud asset ID so share link creation can use it without a round-trip
    updateFileSyncStatus(file.id, 'synced', regData.fileUrl ?? presignData.storageKey, regData.assetId ?? undefined);

    this.onProgress({
      itemId: item.id,
      projectId: item.project_id,
      type: 'file',
      status: 'completed',
      bytesUploaded: stats.size,
      bytesTotal: stats.size,
      percentage: 100,
    });

    logActivity({
      id: generateId(),
      type: 'file_synced',
      message: `Synced file: ${file.file_name}`,
      project_id: item.project_id,
      metadata: { fileId: file.id },
    });
  }

}
