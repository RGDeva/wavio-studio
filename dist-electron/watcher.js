"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WatcherManager = void 0;
const chokidar_1 = __importDefault(require("chokidar"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("./db");
const bpmDetector_1 = require("./bpmDetector");
const audioAnalyzer_1 = require("./audioAnalyzer");
const classifier_1 = require("./classifier");
const BPM_EXTENSIONS = new Set(['.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a']);
const DAW_EXTENSIONS = new Set(['.flp', '.ptx', '.ptf', '.als', '.logic', '.logicx', '.rpp', '.cpr', '.band', '.sesx']);
const DEPENDENCY_EXTENSIONS = new Set(['.wav', '.mp3', '.aiff', '.aif', '.mid', '.midi', '.stems', '.flac', '.ogg', '.m4a', '.aac']);
function generateId() {
    return crypto_1.default.randomUUID();
}
async function fileChecksum(filePath) {
    return new Promise((resolve) => {
        try {
            const hash = crypto_1.default.createHash('sha256');
            const stream = fs_1.default.createReadStream(filePath, { highWaterMark: 64 * 1024 });
            stream.on('data', (chunk) => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex').slice(0, 16)));
            stream.on('error', () => resolve(generateId().slice(0, 16)));
        }
        catch {
            resolve(generateId().slice(0, 16));
        }
    });
}
function getDawType(ext) {
    const map = {
        '.flp': 'FL Studio',
        '.ptx': 'Pro Tools',
        '.ptf': 'Pro Tools',
        '.als': 'Ableton Live',
        '.logic': 'Logic Pro',
        '.logicx': 'Logic Pro',
        '.rpp': 'Reaper',
        '.cpr': 'Cubase',
        '.band': 'GarageBand',
        '.sesx': 'Adobe Audition',
    };
    return map[ext] ?? 'Unknown';
}
function getProjectName(filePath) {
    return path_1.default.basename(filePath, path_1.default.extname(filePath));
}
class WatcherManager {
    constructor(db, onEvent) {
        this.watchers = new Map();
        this.projectMap = new Map();
        this.pendingVersions = new Map();
        this.db = db;
        this.onEvent = onEvent;
    }
    addFolder(folderPath) {
        if (this.watchers.has(folderPath))
            return;
        const watcher = chokidar_1.default.watch(folderPath, {
            persistent: true,
            ignoreInitial: false,
            followSymlinks: false,
            depth: 4,
            awaitWriteFinish: {
                stabilityThreshold: 3000,
                pollInterval: 500,
            },
            ignored: /(^|[/\\])(\.|(node_modules|__MACOSX|Backup|Autosave|\.trash))/,
        });
        watcher
            .on('add', (filePath) => this.handleFileEvent('add', filePath))
            .on('change', (filePath) => this.handleFileEvent('change', filePath))
            .on('unlink', (filePath) => this.handleFileEvent('unlink', filePath))
            .on('error', (err) => console.error('[watcher] error:', err));
        this.watchers.set(folderPath, watcher);
        (0, db_1.logActivity)({
            id: generateId(),
            type: 'folder_added',
            message: `Started monitoring: ${folderPath}`,
            metadata: { folderPath },
        });
    }
    removeFolder(folderPath) {
        const watcher = this.watchers.get(folderPath);
        if (watcher) {
            watcher.close();
            this.watchers.delete(folderPath);
            (0, db_1.logActivity)({
                id: generateId(),
                type: 'folder_removed',
                message: `Stopped monitoring: ${folderPath}`,
                metadata: { folderPath },
            });
        }
    }
    stopAll() {
        for (const watcher of this.watchers.values()) {
            watcher.close();
        }
        this.watchers.clear();
    }
    handleFileEvent(event, filePath) {
        const ext = path_1.default.extname(filePath).toLowerCase();
        if (DAW_EXTENSIONS.has(ext)) {
            this.handleProjectFile(event, filePath);
        }
        else if (DEPENDENCY_EXTENSIONS.has(ext)) {
            this.handleDependencyFile(event, filePath);
        }
    }
    handleProjectFile(event, filePath) {
        if (event === 'unlink') {
            this.onEvent({ type: 'project_deleted', filePath, timestamp: new Date().toISOString() });
            return;
        }
        let stats;
        try {
            stats = fs_1.default.statSync(filePath);
        }
        catch {
            return;
        }
        const ext = path_1.default.extname(filePath).toLowerCase();
        const now = new Date().toISOString();
        // Check if project already exists
        const existing = this.db
            .prepare('SELECT id FROM projects WHERE file_path = ?')
            .get(filePath);
        const projectId = existing?.id ?? generateId();
        this.projectMap.set(filePath, projectId);
        (0, db_1.upsertProject)({
            id: projectId,
            project_name: getProjectName(filePath),
            file_path: filePath,
            daw_type: getDawType(ext),
            file_size: stats.size,
            created_at: now,
            modified_at: stats.mtime.toISOString(),
        });
        const watcherEventType = event === 'add' ? 'project_added' : 'project_changed';
        this.onEvent({ type: watcherEventType, filePath, projectId, timestamp: now });
        (0, db_1.logActivity)({
            id: generateId(),
            type: watcherEventType,
            message: `${event === 'add' ? 'Detected new' : 'Updated'} project: ${getProjectName(filePath)}`,
            project_id: projectId,
            metadata: { filePath, fileSize: stats.size },
        });
        if (event === 'change') {
            // Debounce: only create a version if file is stable for 10s, and checksum actually changed
            clearTimeout(this.pendingVersions.get(filePath));
            this.pendingVersions.set(filePath, setTimeout(async () => {
                this.pendingVersions.delete(filePath);
                const newChecksum = await fileChecksum(filePath);
                const lastVersion = this.db
                    .prepare('SELECT checksum FROM versions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
                    .get(projectId);
                if (lastVersion?.checksum === newChecksum)
                    return;
                (0, db_1.createVersion)({
                    id: generateId(),
                    project_id: projectId,
                    file_path: filePath,
                    file_size: stats.size,
                    checksum: newChecksum,
                    created_at: new Date().toISOString(),
                });
                (0, db_1.enqueueSyncItem)({
                    id: generateId(),
                    project_id: projectId,
                    file_name: path_1.default.basename(filePath),
                    type: 'project_update',
                    priority: 8,
                    created_at: new Date().toISOString(),
                });
            }, 10000));
        }
        else if (event === 'add') {
            (0, db_1.enqueueSyncItem)({
                id: generateId(),
                project_id: projectId,
                file_name: path_1.default.basename(filePath),
                type: 'project_upload',
                priority: 8,
                created_at: now,
            });
        }
        // Scan dependencies after a short delay
        setTimeout(() => this.scanDependencies(filePath, projectId), 2000);
    }
    handleDependencyFile(event, filePath) {
        if (event === 'unlink')
            return;
        // Find which project this file belongs to
        let projectId;
        // Walk up directory tree to find a project file
        for (const [projectFilePath, pid] of this.projectMap.entries()) {
            if (filePath.startsWith(path_1.default.dirname(projectFilePath))) {
                projectId = pid;
                break;
            }
        }
        let stats;
        try {
            stats = fs_1.default.statSync(filePath);
        }
        catch {
            return;
        }
        const now = new Date().toISOString();
        const fileId = generateId();
        const fileName = path_1.default.basename(filePath);
        const ext = path_1.default.extname(filePath).toLowerCase();
        const role = (0, classifier_1.classifyFile)(fileName);
        // Async analysis pipeline — does not block watcher or upload queue
        fileChecksum(filePath).then(async (checksum) => {
            let bpm = null;
            let key_note = null;
            let duration = null;
            if (BPM_EXTENSIONS.has(ext)) {
                // Run BPM + full audio analysis in parallel
                const [detectedBpm, analysis] = await Promise.all([
                    (0, bpmDetector_1.detectBpm)(filePath).catch(() => null),
                    (0, audioAnalyzer_1.analyzeAudio)(filePath).catch(() => null),
                ]);
                bpm = detectedBpm;
                key_note = analysis?.key ?? null;
                duration = analysis?.duration ?? null;
            }
            if (projectId) {
                (0, db_1.upsertFile)({
                    id: fileId,
                    project_id: projectId,
                    file_path: filePath,
                    file_name: fileName,
                    file_type: ext.slice(1),
                    file_size: stats.size,
                    checksum,
                    bpm,
                    key_note,
                    duration,
                    role,
                    created_at: now,
                    modified_at: stats.mtime.toISOString(),
                });
            }
            else {
                // Standalone audio file — no parent project
                (0, db_1.upsertStandaloneFile)({
                    id: fileId,
                    file_path: filePath,
                    file_name: fileName,
                    file_type: ext.slice(1),
                    file_size: stats.size,
                    checksum,
                    bpm,
                    key_note,
                    duration,
                    role,
                    created_at: now,
                    modified_at: stats.mtime.toISOString(),
                });
            }
            const parts = [];
            if (bpm)
                parts.push(`${bpm} BPM`);
            if (key_note)
                parts.push(key_note);
            if (role !== 'unknown')
                parts.push(role);
            if (parts.length) {
                (0, db_1.logActivity)({
                    id: generateId(),
                    type: 'file_analyzed',
                    message: `${fileName}: ${parts.join(' · ')}`,
                    project_id: projectId,
                    metadata: { filePath, bpm, key_note, duration, role },
                });
            }
        });
        // Enqueue for sync (project_id can be null for standalone files)
        (0, db_1.enqueueSyncItem)({
            id: generateId(),
            project_id: projectId ?? '__standalone__',
            file_id: fileId,
            file_name: path_1.default.basename(filePath),
            type: 'dependency_upload',
            priority: 3,
            created_at: now,
        });
        this.onEvent({ type: 'dependency_found', filePath, projectId, timestamp: now });
    }
    scanDependencies(projectFilePath, projectId) {
        const dir = path_1.default.dirname(projectFilePath);
        this.scanDir(dir, projectId, 0);
    }
    scanDir(dirPath, projectId, depth) {
        if (depth > 6)
            return;
        let entries;
        try {
            entries = fs_1.default.readdirSync(dirPath, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path_1.default.join(dirPath, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                this.scanDir(fullPath, projectId, depth + 1);
            }
            else if (entry.isFile()) {
                const ext = path_1.default.extname(entry.name).toLowerCase();
                if (DEPENDENCY_EXTENSIONS.has(ext)) {
                    this.handleDependencyFile('add', fullPath);
                }
            }
        }
    }
}
exports.WatcherManager = WatcherManager;
