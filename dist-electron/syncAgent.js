"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncAgent = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const tus = __importStar(require("tus-js-client"));
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
        // POST project metadata to API
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
        (0, db_1.updateProjectSyncStatus)(project.id, 'synced', data.projectId ?? data.id);
        // Upload the actual file via tus resumable upload
        if (fs_1.default.existsSync(project.file_path)) {
            await this.tusUpload(project.file_path, item.id, item.project_id, 'project', data.uploadToken);
        }
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
        // If already deduplicated, just update local status
        if (presignData.deduplicated) {
            (0, db_1.updateFileSyncStatus)(file.id, 'synced', presignData.fileUrl);
            (0, db_1.logActivity)({
                id: generateId(),
                type: 'file_synced',
                message: `Dedup hit: ${file.file_name}`,
                project_id: item.project_id,
                metadata: { fileId: file.id },
            });
            return;
        }
        // Step 2: PUT file directly to signed URL (bypasses Vercel 4.5MB limit)
        const fileBuffer = fs_1.default.readFileSync(file.file_path);
        const uploadRes = await fetch(presignData.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: fileBuffer,
        });
        if (!uploadRes.ok) {
            throw new Error(`Storage upload failed: HTTP ${uploadRes.status}`);
        }
        // Step 3: Register asset with API using storageKey
        const registerRes = await fetch(`${API_BASE}/desktop/index`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.authToken}`,
                'X-Desktop-Action': 'register-asset',
            },
            body: JSON.stringify({
                fileName: file.file_name,
                storageKey: presignData.storageKey,
                fileSize: stats.size,
                sha256: file.checksum ?? null,
                projectId: item.project_id,
                bpm: file.bpm ?? null,
                keyNote: file.key_note ?? null,
                duration: file.duration ?? null,
                role: file.role ?? null,
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
    tusUpload(filePath, itemId, projectId, uploadType, uploadToken, fileId) {
        return new Promise((resolve, reject) => {
            let fileStream;
            let fileSize;
            try {
                fileSize = fs_1.default.statSync(filePath).size;
                fileStream = fs_1.default.createReadStream(filePath);
            }
            catch (err) {
                return reject(err);
            }
            const upload = new tus.Upload(fileStream, {
                endpoint: `${API_BASE}/files/upload`,
                retryDelays: [0, 3000, 5000, 10000, 20000],
                chunkSize: 5 * 1024 * 1024, // 5MB chunks
                metadata: {
                    filename: path_1.default.basename(filePath),
                    filetype: `application/octet-stream`,
                    projectId,
                    uploadType,
                    ...(fileId ? { fileId } : {}),
                },
                headers: {
                    Authorization: `Bearer ${this.authToken ?? ''}`,
                    ...(uploadToken ? { 'X-Upload-Token': uploadToken } : {}),
                },
                uploadSize: fileSize,
                onProgress: (bytesUploaded, bytesTotal) => {
                    const percentage = Math.round((bytesUploaded / bytesTotal) * 100);
                    (0, db_1.updateSyncItem)(itemId, { upload_offset: bytesUploaded });
                    this.onProgress({
                        itemId,
                        projectId,
                        type: uploadType,
                        status: 'uploading',
                        bytesUploaded,
                        bytesTotal,
                        percentage,
                    });
                },
                onSuccess: () => resolve(),
                onError: (err) => reject(err),
            });
            upload.findPreviousUploads().then((prev) => {
                if (prev.length)
                    upload.resumeFromPreviousUpload(prev[0]);
                upload.start();
                // Save upload URL for resume
                setTimeout(() => {
                    if (upload.url) {
                        (0, db_1.updateSyncItem)(itemId, { upload_url: upload.url });
                    }
                }, 1000);
            });
        });
    }
}
exports.SyncAgent = SyncAgent;
