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
  repairStalledQueue,
  updateProjectAssetId,
  bumpProjectPriority,
  requeueFailedForProject,
} from './db';
import { fileChecksum } from './watcher';
import crypto from 'crypto';
import { API_BASE } from './config';
function formatSyncError(err: any): string {
  const msg: string = err?.message ?? 'Unknown error';
  // Node native fetch AbortError: cause is DOMException with name 'AbortError'
  if (msg === 'fetch failed' && err?.cause) {
    const cause = err.cause;
    const causeCode = cause?.code ?? cause?.name ?? '';
    const causeMsg = cause?.message ?? '';
    return `fetch failed [${causeCode || causeMsg || 'no cause'}]`;
  }
  return msg;
}

const POLL_INTERVAL_MS = 5000; // periodic safety-net only — primary refill is immediate-on-completion, see _tick()
const DEFAULT_MAX_CONCURRENT = 2;
const MIN_CONCURRENT = 1;
const MAX_ALLOWED_CONCURRENT = 8; // hard ceiling so a bad Settings value can't spawn unbounded work
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000]; // 5s, 30s, 2m, 5m
const FETCH_TIMEOUT_MS = 60000; // 60s for Vercel Hobby cold-starts
const UPLOAD_TIMEOUT_MS = 300000; // 5 minute timeout for file uploads
const HIGH_PRIORITY = 10; // used by prioritizeProject() to jump the queue ahead of default priority 5/3

// Fetch with timeout to prevent hanging. Accepts an optional external signal
// (from cancelItem()) that aborts the request independent of the timeout.
async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number; externalSignal?: AbortSignal } = {},
): Promise<Response> {
  const { timeout = FETCH_TIMEOUT_MS, externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (error: any) {
    if (externalSignal?.aborted) {
      throw new Error('Upload cancelled');
    }
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(id);
    externalSignal?.removeEventListener('abort', onExternalAbort);
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
  // null = not paused. 'user' = explicit Pause Sync button (resumable any time).
  // 'auth'/'limit' = system-triggered pauses that need re-auth/upgrade to clear.
  private pausedReason: 'auth' | 'limit' | 'user' | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeUploads = new Set<string>();
  private activeControllers = new Map<string, AbortController>();
  private maxConcurrent = DEFAULT_MAX_CONCURRENT;

  constructor(db: Database.Database, onProgress: (progress: SyncProgress) => void) {
    this.db = db;
    this.onProgress = onProgress;
  }

  setAuthToken(token: string | null) {
    this.authToken = token;
    if (token && this.pausedReason === 'auth') this.pausedReason = null; // resume on new token
  }

  /** Bounded by [MIN_CONCURRENT, MAX_ALLOWED_CONCURRENT] regardless of caller input. */
  setMaxConcurrent(n: number) {
    const floored = Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_CONCURRENT;
    this.maxConcurrent = Math.max(MIN_CONCURRENT, Math.min(MAX_ALLOWED_CONCURRENT, floored));
    this._tick(); // new slots may have opened up immediately
  }

  getMaxConcurrent() {
    return this.maxConcurrent;
  }

  start() {
    if (this.running) return;
    this.running = true;
    // Crash recovery: reset zombie 'uploading' rows and collapse duplicates
    const r = repairStalledQueue();
    console.log(`[sync] startup repair: recovered=${r.recovered} deduped=${r.deduped}`);
    // Periodic safety-net tick — catches newly-enqueued items between
    // completion events (e.g. from a file-watcher change) and covers the
    // case where a slot never gets an immediate refill signal.
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

  /** User-initiated pause — distinct from the system 'auth'/'limit' pauses so
   *  resume() doesn't accidentally clear a real auth/plan-limit block. */
  pauseUser() {
    if (this.pausedReason === null) this.pausedReason = 'user';
  }

  /** Resumes only a user-initiated pause. No-op if paused for auth/limit —
   *  those require setAuthToken()/plan upgrade respectively to clear. */
  resumeUser() {
    if (this.pausedReason === 'user') {
      this.pausedReason = null;
      this._tick();
    }
  }

  isPausedByUser(): boolean {
    return this.pausedReason === 'user';
  }

  /** "Sync This Project": bumps the project's pending/retrying rows to
   *  HIGH_PRIORITY AND moves its transiently-failed rows back to pending at
   *  that priority (D3 — previously failed rows were untouched, making the
   *  button a no-op for failed projects). Permanent auth/permission/not-found
   *  failures and missing-file rows stay blocked, reported in the summary so
   *  the UI can say why. Pure UPDATEs — no duplicate rows, no other project
   *  affected, safe to invoke repeatedly. */
  prioritizeProject(projectId: string): {
    bumped: number; requeued: number; blockedPermanent: number; skippedMissing: number;
  } {
    const retry = requeueFailedForProject(projectId, HIGH_PRIORITY);
    const bumped = bumpProjectPriority(projectId, HIGH_PRIORITY);
    this._tick();
    return { bumped, ...retry };
  }

  /** Cancels an in-flight upload (no-op if the item isn't currently active).
   *  The aborted fetch surfaces as a rejected promise which processItem()
   *  turns into an explicit 'cancelled' terminal status — not a retry. */
  cancelItem(itemId: string): boolean {
    const controller = this.activeControllers.get(itemId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  getQueue() {
    return getSyncQueue();
  }

  getStatus(): string {
    if (this.pausedReason === 'auth') return 'paused:auth';
    if (this.pausedReason === 'limit') return 'paused:limit';
    if (this.pausedReason === 'user') return 'paused:user';
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
    if (this.activeUploads.size >= this.maxConcurrent) return;

    const slots = this.maxConcurrent - this.activeUploads.size;
    const items = getPendingSyncItems(slots);

    for (const item of items as any[]) {
      if (this.activeUploads.has(item.id)) continue;
      this.activeUploads.add(item.id);
      const controller = new AbortController();
      this.activeControllers.set(item.id, controller);
      this.processItem(item, controller.signal).finally(() => {
        this.activeUploads.delete(item.id);
        this.activeControllers.delete(item.id);
        // Immediate refill: don't wait for the next POLL_INTERVAL_MS tick.
        // This is the core throughput fix — previously a freed slot sat idle
        // for up to POLL_INTERVAL_MS, capping max throughput at
        // maxConcurrent / POLL_INTERVAL_MS regardless of real upload speed.
        if (this.running) this._tick();
      });
    }
  }

  private async processItem(item: any, signal: AbortSignal) {
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
        await this.syncProject(item, signal);
      } else if (item.type === 'dependency_upload') {
        await this.syncFile(item, signal);
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
      // Explicit user cancellation — terminal, not a retry/failure.
      if (signal.aborted) {
        updateSyncItem(item.id, {
          status: 'cancelled',
          completed_at: new Date().toISOString(),
          error_message: 'Cancelled by user',
        });
        this.onProgress({ itemId: item.id, projectId: item.project_id, type: item.type, status: 'cancelled' });
        return;
      }

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

      const errMsg = formatSyncError(err);
      updateSyncItem(item.id, {
        status: failed ? 'failed' : 'retrying',
        retries,
        error_message: errMsg,
        next_retry_at: nextRetryAt,
      });

      this.onProgress({
        itemId: item.id,
        projectId: item.project_id,
        type: item.type,
        status: failed ? 'failed' : 'retrying',
        error: errMsg,
      });

      logActivity({
        id: generateId(),
        type: 'sync_error',
        message: `Sync failed: ${errMsg}`,
        project_id: item.project_id,
        metadata: { itemId: item.id, retries },
      });

      // Schedule in-memory retry tick (belt-and-suspenders alongside next_retry_at DB gate)
      if (!failed) {
        setTimeout(() => this.tick(), delay);
      }
    }
  }

  private async syncProject(item: any, signal: AbortSignal) {
    const project = getProjectById(item.project_id) as any;
    if (!project) throw new Error('Project not found');

    // Compute SHA-256 of the project file for deduplication before syncing
    let projectChecksum: string | null = null;
    if (fs.existsSync(project.file_path)) {
      try { projectChecksum = await fileChecksum(project.file_path); } catch { /* non-fatal */ }
    }

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
        sha256: projectChecksum,
      }),
      externalSignal: signal,
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
        externalSignal: signal,
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
            externalSignal: signal,
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

        // Register the project file as a real cloud asset (was previously
        // uploaded but never registered — meant project_version_files had no
        // retrievable asset for the .als/.ptx/etc itself, and ZIP downloads
        // silently dropped the DAW project file). Idempotent: register-asset
        // dedupes by storage_path within the user.
        try {
          const registerProjectFileRes = await fetchWithTimeout(`${API_BASE}/desktop/index`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.authToken}`,
              'X-Desktop-Action': 'register-asset',
            },
            body: JSON.stringify({
              fileName,
              storageKey: presignData.storageKey ?? presignData.fileUrl,
              fileSize: stats.size,
              sha256: project.sha256 ?? null,
              projectId: cloudProjectId,
              projectVersionId: cloudVersionId,
              role: 'project',
              daw: project.daw_type ?? null,
              projectName: project.project_name,
            }),
            externalSignal: signal,
          });
          if (registerProjectFileRes.ok) {
            const registerData = await registerProjectFileRes.json();
            if (registerData?.assetId) {
              updateProjectAssetId(project.id, registerData.assetId);
            }
          }
        } catch (registerErr: any) {
          console.warn('[syncAgent] Project file asset registration failed (non-fatal):', registerErr?.message);
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

  private async syncFile(item: any, signal: AbortSignal) {
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
      externalSignal: signal,
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
        externalSignal: signal,
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

      // Confirm the upload with the server so future presigns can dedup correctly
      try {
        await fetchWithTimeout(`${API_BASE}/storage/confirm`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.authToken}`,
          },
          body: JSON.stringify({
            sha256: file.checksum ?? null,
            storageKey: presignData.storageKey,
          }),
          externalSignal: signal,
        });
      } catch {
        // Non-fatal: confirm failure means next presign re-uploads instead of dedup
        // The asset registration still proceeds
      }
    }

    // Step 3: ALWAYS register asset (even on dedup) so user gets an asset row in Supabase.
    // Resolve cloud project ID — local IDs do not exist in Supabase, use cloud_id.
    let daw: string | null = null;
    let projectName: string | null = null;
    let cloudProjectId: string | null = null;
    let cloudVersionId: string | null = null;
    if (item.project_id && item.project_id !== '__standalone__') {
      try {
        const project = getProjectById(item.project_id) as any;
        if (project) {
          daw = project.daw_type ?? null;
          projectName = project.project_name ?? null;
          cloudProjectId = project.cloud_id ?? null; // use cloud UUID, not local UUID
          cloudVersionId = project.cloud_version_id ?? null;
        }
      } catch {}
    }

    // Immutable version bump: if this WAV file was previously registered (has cloud_asset_id)
    // and its content changed (new checksum), create a new project_version so each
    // bounce revision gets its own immutable snapshot.
    if (file.cloud_asset_id && cloudProjectId && cloudVersionId) {
      try {
        const bumpRes = await fetchWithTimeout(`${API_BASE}/desktop/index`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.authToken}`,
            'X-Desktop-Action': 'daw-sync',
          },
          body: JSON.stringify({
            projectName: projectName ?? path.basename(file.file_path, path.extname(file.file_path)),
            fileName: file.file_name,
            localProjectId: item.project_id !== '__standalone__' ? item.project_id : undefined,
            daw: daw ?? null,
            fileSize: stats.size,
            lastModified: new Date().toISOString(),
            // Prefix distinguishes WAV-triggered versions from DAW-file versions.
            // sha256 dedup in daw-sync ensures identical bounces don't create duplicate versions.
            sha256: `bounce:${file.checksum ?? presignData.storageKey}`,
          }),
          externalSignal: signal,
        });
        if (bumpRes.ok) {
          const bumpData = await bumpRes.json();
          const newVersionId: string | null = bumpData.projectVersionId ?? null;
          if (newVersionId && newVersionId !== cloudVersionId) {
            cloudVersionId = newVersionId;
            updateProjectSyncStatus(item.project_id, 'synced', cloudProjectId, newVersionId);
            console.log(`[syncAgent] WAV revision → new project version: ${newVersionId}`);
          }
        }
      } catch (bumpErr: any) {
        console.warn('[syncAgent] WAV version bump failed (non-fatal):', bumpErr?.message);
      }
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
        projectId: cloudProjectId,       // cloud UUID or null — not the local ID
        projectVersionId: cloudVersionId, // current project version for history tracking
        bpm: file.bpm ?? null,
        keyNote: file.key_note ?? null,
        duration: file.duration ?? null,
        role: file.role ?? null,
        daw,
        projectName,
      }),
      externalSignal: signal,
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
