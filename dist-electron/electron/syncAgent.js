"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncAgent = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const db_1 = require("./db");
const crypto_1 = __importDefault(require("crypto"));
const API_BASE = 'https://wavi.stream/api';
const POLL_INTERVAL_MS = 5000;
const MAX_CONCURRENT = 2;
const RETRY_DELAYS_MS = [5000, 30000, 120000, 300000]; // 5s, 30s, 2m, 5m
function generateId() {
    return crypto_1.default.randomUUID();
}
class SyncAgent {
    constructor(db, onProgress) {
        this.authToken = null;
        this.running = false;
        this.pausedReason = null; // null = not paused
        this.pollTimer = null;
        this.activeUploads = new Set();
        this.db = db;
        this.onProgress = onProgress;
    }
    setAuthToken(token) {
        this.authToken = token;
        if (token)
            this.pausedReason = null; // resume on new token
    }
    start() {
        if (this.running)
            return;
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
        return (0, db_1.getSyncQueue)();
    }
    getStatus() {
        if (this.pausedReason === 'auth')
            return 'paused:auth';
        if (this.pausedReason === 'limit')
            return 'paused:limit';
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
    async _tick() {
        if (!this.authToken)
            return;
        if (this.pausedReason !== null)
            return;
        if (this.activeUploads.size >= MAX_CONCURRENT)
            return;
        const slots = MAX_CONCURRENT - this.activeUploads.size;
        const items = (0, db_1.getPendingSyncItems)(slots);
        for (const item of items) {
            if (this.activeUploads.has(item.id))
                continue;
            this.activeUploads.add(item.id);
            this.processItem(item).finally(() => {
                this.activeUploads.delete(item.id);
            });
        }
    }
    async processItem(item) {
        (0, db_1.updateSyncItem)(item.id, {
            status: 'uploading',
            started_at: new Date().toISOString(),
        });
        try {
            if (item.type === 'project_upload' || item.type === 'project_update') {
                await this.syncProject(item);
            }
            else if (item.type === 'dependency_upload') {
                await this.syncFile(item);
            }
            (0, db_1.updateSyncItem)(item.id, {
                status: 'completed',
                completed_at: new Date().toISOString(),
            });
        }
        catch (err) {
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
            (0, db_1.updateSyncItem)(item.id, {
                status: failed ? 'failed' : 'retrying',
                retries,
                error_message: err?.message ?? 'Unknown error',
            });
            this.onProgress({
                itemId: item.id,
                projectId: item.project_id,
                type: item.type,
                status: failed ? 'failed' : 'retrying',
                error: err?.message,
            });
            (0, db_1.logActivity)({
                id: generateId(),
                type: 'sync_error',
                message: `Sync failed: ${err?.message ?? 'Unknown error'}`,
                project_id: item.project_id,
                metadata: { itemId: item.id, retries },
            });
            // Exponential backoff before next retry
            if (!failed) {
                const delay = RETRY_DELAYS_MS[Math.min(retries - 1, RETRY_DELAYS_MS.length - 1)]
                    + Math.floor(Math.random() * 1000);
                setTimeout(() => this.tick(), delay);
            }
        }
    }
    async syncProject(item) {
        const project = (0, db_1.getProjectById)(item.project_id);
        if (!project)
            throw new Error('Project not found');
        // Step 1: POST project metadata to API (daw-sync)
        const res = await fetch(`${API_BASE}/desktop/index`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.authToken}`,
                'X-Desktop-Action': 'daw-sync',
            },
            body: JSON.stringify({
                projectName: project.project_name,
                sessionPath: project.file_path,
                daw: project.daw_type,
                fileSize: project.file_size,
                lastModified: project.modified_at,
                sha256: project.sha256 ?? null,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const data = await res.json();
        const cloudProjectId = data.projectId ?? data.id;
        (0, db_1.updateProjectSyncStatus)(project.id, 'synced', cloudProjectId);
        // Step 2: Upload the actual project file via presign → PUT → register-asset
        if (fs_1.default.existsSync(project.file_path)) {
            const stats = fs_1.default.statSync(project.file_path);
            const fileName = path_1.default.basename(project.file_path);
            // Get pre-signed upload URL
            const presignRes = await fetch(`${API_BASE}/storage/presign`, {
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
                    const fileStream = fs_1.default.createReadStream(project.file_path);
                    const uploadRes = await fetch(presignData.uploadUrl, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(stats.size) },
                        body: fileStream,
                        // @ts-ignore — duplex required in Node 18+
                        duplex: 'half',
                    });
                    if (!uploadRes.ok) {
                        console.error(`[syncAgent] Project file upload failed: HTTP ${uploadRes.status}`);
                    }
                    else {
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
        (0, db_1.logActivity)({
            id: generateId(),
            type: 'project_synced',
            message: `Synced project: ${project.project_name}`,
            project_id: project.id,
        });
    }
    async syncFile(item) {
        let file;
        if (item.project_id === '__standalone__' && item.file_id) {
            file = (0, db_1.getFileById)(item.file_id);
        }
        else {
            const files = (0, db_1.getFilesByProject)(item.project_id);
            file = files.find((f) => f.id === item.file_id);
        }
        if (!file)
            return;
        if (!fs_1.default.existsSync(file.file_path)) {
            (0, db_1.updateFileSyncStatus)(file.id, 'missing');
            return;
        }
        const stats = fs_1.default.statSync(file.file_path);
        // Step 1: Get pre-signed upload URL (handles dedup check server-side)
        const presignRes = await fetch(`${API_BASE}/storage/presign`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.authToken}`,
            },
            body: JSON.stringify({
                fileName: file.file_name,
                fileSize: stats.size,
                sha256: file.checksum ?? null,
                projectId: item.project_id,
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
            const fileStream = fs_1.default.createReadStream(file.file_path);
            const uploadRes = await fetch(presignData.uploadUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fileSize2) },
                body: fileStream,
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
        // Step 3: ALWAYS register asset (even on dedup) so user gets an asset row in Supabase
        // Resolve project info for daw + projectName
        let daw = null;
        let projectName = null;
        if (item.project_id && item.project_id !== '__standalone__') {
            try {
                const project = (0, db_1.getProjectById)(item.project_id);
                if (project) {
                    daw = project.daw_type ?? null;
                    projectName = project.project_name ?? null;
                }
            }
            catch { }
        }
        const registerRes = await fetch(`${API_BASE}/desktop/index`, {
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
                projectId: item.project_id !== '__standalone__' ? item.project_id : null,
                bpm: file.bpm ?? null,
                keyNote: file.key_note ?? null,
                duration: file.duration ?? null,
                role: file.role ?? null,
                daw,
                projectName,
            }),
        });
        const regData = await registerRes.json().catch(() => ({}));
        (0, db_1.updateFileSyncStatus)(file.id, 'synced', regData.fileUrl ?? presignData.storageKey);
        this.onProgress({
            itemId: item.id,
            projectId: item.project_id,
            type: 'file',
            status: 'completed',
            bytesUploaded: stats.size,
            bytesTotal: stats.size,
            percentage: 100,
        });
        (0, db_1.logActivity)({
            id: generateId(),
            type: 'file_synced',
            message: `Synced file: ${file.file_name}`,
            project_id: item.project_id,
            metadata: { fileId: file.id },
        });
    }
}
exports.SyncAgent = SyncAgent;
