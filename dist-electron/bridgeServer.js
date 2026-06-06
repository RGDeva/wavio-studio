"use strict";
/**
 * Wavi Studio Local Bridge Server
 *
 * Exposes a lightweight HTTP API on 127.0.0.1:47821 so the
 * Wavi Agent (native macOS Swift companion app)
 * can read project context, trigger tool execution, and log actions
 * without having direct filesystem access.
 *
 * Security:
 *   - Binds to 127.0.0.1 only (never 0.0.0.0)
 *   - Every request must include X-Wavi-Token matching ~/.wavi/bridge-token
 *   - Token is a random UUID written at startup with chmod 600
 */
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
exports.BRIDGE_HOST = exports.BRIDGE_PORT = void 0;
exports.startBridgeServer = startBridgeServer;
exports.stopBridgeServer = stopBridgeServer;
exports.getBridgeToken = getBridgeToken;
const http_1 = __importDefault(require("http"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const crypto_1 = __importDefault(require("crypto"));
const electron_1 = require("electron");
const db_1 = require("./db");
const fileClassifier_1 = require("./projectAssociation/fileClassifier");
const audioAnalyzer_1 = require("./audioAnalyzer");
const agentLoop_1 = require("./agentLoop");
// ── Constants ─────────────────────────────────────────────────────────────────
exports.BRIDGE_PORT = 47821;
exports.BRIDGE_HOST = '127.0.0.1';
const TOKEN_DIR = path_1.default.join(os_1.default.homedir(), '.wavi');
const TOKEN_PATH = path_1.default.join(TOKEN_DIR, 'bridge-token');
let _bridgeToken = '';
let _server = null;
// ── Token management ──────────────────────────────────────────────────────────
function ensureToken() {
    try {
        fs_1.default.mkdirSync(TOKEN_DIR, { recursive: true });
        // If file exists and is valid, reuse it
        if (fs_1.default.existsSync(TOKEN_PATH)) {
            const existing = fs_1.default.readFileSync(TOKEN_PATH, 'utf8').trim();
            if (existing.length === 36)
                return existing; // UUID length
        }
        // Generate fresh token
        const token = crypto_1.default.randomUUID();
        fs_1.default.writeFileSync(TOKEN_PATH, token, { encoding: 'utf8', mode: 0o600 });
        return token;
    }
    catch (err) {
        console.error('[bridge] Failed to write bridge-token:', err);
        // Fall back to in-memory only — companion won't work but Studio won't crash
        return crypto_1.default.randomUUID();
    }
}
// ── Request helpers ───────────────────────────────────────────────────────────
class JSONParseError extends Error {
    constructor(message = 'Invalid JSON') {
        super(message);
        this.name = 'JSONParseError';
    }
}
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            }
            catch {
                reject(new JSONParseError());
            }
        });
        req.on('error', reject);
    });
}
// Helper to parse body with proper error handling for API endpoints
async function parseBodySafe(req) {
    try {
        const data = await parseBody(req);
        return { data };
    }
    catch (err) {
        return { data: {}, error: err instanceof Error ? err.message : 'Invalid JSON' };
    }
}
function send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
}
function auth(req, res) {
    const token = req.headers['x-wavi-token'];
    if (token !== _bridgeToken) {
        send(res, 401, { error: 'Unauthorized — invalid or missing X-Wavi-Token' });
        return false;
    }
    return true;
}
// ── Project context builder (shared with copilot.ts) ─────────────────────────
function buildProjectContext(activeProject) {
    const files = activeProject
        ? (0, db_1.getFilesByProject)(activeProject.id).map(f => ({
            id: f.id,
            fileName: f.file_name,
            fileType: f.file_type,
            fileSize: f.file_size,
            role: f.role ?? 'unknown',
            bpm: f.bpm ?? null,
            keyNote: f.key_note ?? null,
            syncStatus: f.sync_status,
            cloudUrl: f.cloud_url ?? null,
        }))
        : [];
    return {
        projectId: activeProject?.id ?? null,
        projectName: activeProject?.project_name ?? null,
        dawType: activeProject?.daw_type ?? null,
        filePath: activeProject?.file_path ?? null,
        versionCount: activeProject?.version_count ?? 0,
        lastSyncedAt: activeProject?.last_synced_at ?? null,
        files,
        cloudProject: null,
    };
}
function getActiveProject() {
    const projects = (0, db_1.getProjects)();
    return projects[0] ?? null;
}
function findLatestBounce(activeProject) {
    if (!activeProject)
        return null;
    const files = (0, db_1.getFilesByProject)(activeProject.id);
    // Prefer files with role 'bounce', 'master', or 'export'; fall back to most recent audio
    const bounceRoles = ['bounce', 'master', 'export', 'mix'];
    const bounces = files.filter(f => bounceRoles.includes(f.role ?? ''));
    const audioFiles = files.filter(f => /\.(wav|mp3|flac|aiff|m4a)$/i.test(f.file_name));
    const candidates = bounces.length > 0 ? bounces : audioFiles;
    if (!candidates.length)
        return null;
    return candidates.sort((a, b) => new Date(b.updated_at ?? b.created_at ?? 0).getTime() -
        new Date(a.updated_at ?? a.created_at ?? 0).getTime())[0];
}
// ── Route handler ─────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
    const start = Date.now();
    console.log(`[bridge] → ${req.method} ${req.url}`);
    const origEnd = res.end.bind(res);
    res.end = (...args) => {
        console.log(`[bridge] ← ${res.statusCode} ${req.url} (${Date.now() - start}ms)`);
        return origEnd(...args);
    };
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, X-Wavi-Token',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        });
        res.end();
        return;
    }
    const url = new URL(req.url ?? '/', `http://${exports.BRIDGE_HOST}`);
    const route = url.pathname;
    // ── GET /health — no auth required (used for polling) ─────────────────────
    if (req.method === 'GET' && route === '/health') {
        send(res, 200, {
            status: 'ok',
            service: 'wavi-studio-bridge',
            version: '1.0.0',
            port: exports.BRIDGE_PORT,
        });
        return;
    }
    // All other routes require auth
    if (!auth(req, res))
        return;
    // ── GET /active-project ───────────────────────────────────────────────────
    if (req.method === 'GET' && route === '/active-project') {
        const p = getActiveProject();
        if (!p) {
            send(res, 200, { project: null });
            return;
        }
        send(res, 200, {
            project: {
                id: p.id,
                name: p.project_name,
                dawType: p.daw_type,
                filePath: p.file_path,
                lastModified: p.last_synced_at,
                versionCount: p.version_count ?? 0,
                cloudId: p.cloud_id ?? null,
            },
        });
        return;
    }
    // ── GET /project-context ──────────────────────────────────────────────────
    if (req.method === 'GET' && route === '/project-context') {
        const p = getActiveProject();
        const ctx = buildProjectContext(p);
        send(res, 200, { context: ctx });
        return;
    }
    // ── GET /project-files ────────────────────────────────────────────────────
    if (req.method === 'GET' && route === '/project-files') {
        const p = getActiveProject();
        if (!p) {
            send(res, 200, { files: [] });
            return;
        }
        const files = (0, db_1.getFilesByProject)(p.id);
        send(res, 200, {
            files: files.map(f => ({
                id: f.id,
                fileName: f.file_name,
                filePath: f.file_path,
                fileType: f.file_type,
                fileSize: f.file_size,
                role: f.role ?? 'unknown',
                bpm: f.bpm ?? null,
                keyNote: f.key_note ?? null,
                syncStatus: f.sync_status,
                cloudUrl: f.cloud_url ?? null,
                updatedAt: f.updated_at,
            })),
        });
        return;
    }
    // ── GET /project-versions ─────────────────────────────────────────────────
    if (req.method === 'GET' && route === '/project-versions') {
        const p = getActiveProject();
        if (!p) {
            send(res, 200, { versions: [] });
            return;
        }
        const versions = (0, db_1.getVersionsByProject)(p.id);
        send(res, 200, {
            versions: versions.map(v => ({
                id: v.id,
                versionNumber: v.version_number,
                label: v.label ?? null,
                filePath: v.file_path,
                fileSize: v.file_size,
                checksum: v.checksum,
                syncedAt: v.synced_at ?? v.created_at,
                cloudUrl: v.cloud_url ?? null,
            })),
        });
        return;
    }
    // ── GET /latest-bounce ────────────────────────────────────────────────────
    if (req.method === 'GET' && route === '/latest-bounce') {
        const p = getActiveProject();
        const bounce = findLatestBounce(p);
        if (!bounce) {
            send(res, 200, { bounce: null });
            return;
        }
        send(res, 200, {
            bounce: {
                id: bounce.id,
                fileName: bounce.file_name,
                filePath: bounce.file_path,
                role: bounce.role ?? 'unknown',
                bpm: bounce.bpm ?? null,
                keyNote: bounce.key_note ?? null,
                fileSize: bounce.file_size,
                updatedAt: bounce.updated_at,
            },
        });
        return;
    }
    // ── GET /search-files?q= ─────────────────────────────────────────────────
    if (req.method === 'GET' && route === '/search-files') {
        const q = url.searchParams.get('q') ?? '';
        if (!q.trim()) {
            send(res, 200, { files: [] });
            return;
        }
        const results = (0, db_1.searchFiles)(q);
        send(res, 200, {
            files: results.slice(0, 20).map(f => ({
                id: f.id,
                fileName: f.file_name,
                filePath: f.file_path,
                projectName: f.project_name ?? null,
                role: f.role ?? 'unknown',
                bpm: f.bpm ?? null,
                keyNote: f.key_note ?? null,
            })),
        });
        return;
    }
    // ── POST /open-file ───────────────────────────────────────────────────────
    if (req.method === 'POST' && route === '/open-file') {
        try {
            const body = await parseBody(req);
            const filePath = body.filePath;
            if (!filePath) {
                send(res, 400, { error: 'filePath required' });
                return;
            }
            if (!fs_1.default.existsSync(filePath)) {
                send(res, 404, { error: 'File not found', filePath });
                return;
            }
            await electron_1.shell.openPath(filePath);
            (0, db_1.logActivity)({ id: crypto_1.default.randomUUID(), type: 'bridge_open_file', message: `Opened: ${path_1.default.basename(filePath)}`, metadata: { filePath } });
            send(res, 200, { status: 'ok', filePath });
        }
        catch (err) {
            send(res, 500, { error: String(err) });
        }
        return;
    }
    // ── POST /open-folder ─────────────────────────────────────────────────────
    if (req.method === 'POST' && route === '/open-folder') {
        try {
            const body = await parseBody(req);
            const folderPath = body.folderPath;
            if (!folderPath) {
                send(res, 400, { error: 'folderPath required' });
                return;
            }
            await electron_1.shell.openPath(folderPath);
            (0, db_1.logActivity)({ id: crypto_1.default.randomUUID(), type: 'bridge_open_folder', message: `Opened folder: ${folderPath}`, metadata: { folderPath } });
            send(res, 200, { status: 'ok', folderPath });
        }
        catch (err) {
            send(res, 500, { error: String(err) });
        }
        return;
    }
    // ── POST /reveal-file ─────────────────────────────────────────────────────
    if (req.method === 'POST' && route === '/reveal-file') {
        try {
            const body = await parseBody(req);
            const filePath = body.filePath;
            if (!filePath) {
                send(res, 400, { error: 'filePath required' });
                return;
            }
            if (!fs_1.default.existsSync(filePath)) {
                send(res, 404, { error: 'File not found', filePath });
                return;
            }
            electron_1.shell.showItemInFolder(filePath);
            (0, db_1.logActivity)({ id: crypto_1.default.randomUUID(), type: 'bridge_reveal_file', message: `Revealed: ${path_1.default.basename(filePath)}`, metadata: { filePath } });
            send(res, 200, { status: 'ok', filePath });
        }
        catch (err) {
            send(res, 500, { error: String(err) });
        }
        return;
    }
    // ── POST /generate-midi ───────────────────────────────────────────────────
    if (req.method === 'POST' && route === '/generate-midi') {
        try {
            const body = await parseBody(req);
            const { type = 'melody', key = 'C', scale = 'minor', tempo = 140, bars = 4, } = body;
            const p = getActiveProject();
            const projectFolder = p?.file_path ? path_1.default.dirname(p.file_path) : null;
            // Dispatch to the appropriate tool in TOOL_REGISTRY
            const toolName = type === 'drums'
                ? 'generate_drum_pattern'
                : type === 'chords'
                    ? 'generate_chord_progression'
                    : 'generate_midi_melody';
            const tool = (0, agentLoop_1.getToolByName)(toolName);
            if (!tool) {
                send(res, 500, { error: `Tool not found: ${toolName}` });
                return;
            }
            const ctx = buildProjectContext(p);
            const params = {
                key, scale, tempo, bars,
                ...(type === 'drums' ? { pattern_type: scale } : {}),
                projectFolder,
            };
            const result = await tool.handler(params, ctx);
            (0, db_1.logActivity)({
                id: crypto_1.default.randomUUID(),
                type: 'bridge_generate_midi',
                message: `Generated MIDI (${toolName}): ${result.filePath ? path_1.default.basename(result.filePath) : 'no file'}`,
                project_id: p?.id,
                metadata: { toolName, params, result },
            });
            send(res, result.status === 'done' ? 200 : 500, result);
        }
        catch (err) {
            if (err instanceof JSONParseError) {
                send(res, 400, { error: 'Invalid JSON' });
            }
            else {
                send(res, 500, { error: String(err) });
            }
        }
        return;
    }
    // ── POST /analyze-latest-bounce ───────────────────────────────────────────
    if (req.method === 'POST' && route === '/analyze-latest-bounce') {
        try {
            const body = await parseBody(req);
            const p = getActiveProject();
            // Allow caller to provide explicit filePath, or auto-detect latest bounce
            let filePath = body.filePath;
            if (!filePath) {
                const bounce = findLatestBounce(p);
                filePath = bounce?.file_path;
            }
            if (!filePath || !fs_1.default.existsSync(filePath)) {
                send(res, 404, { error: 'No bounce file found', hint: 'Provide filePath or ensure project has bounces' });
                return;
            }
            const analysis = await (0, audioAnalyzer_1.analyzeAudio)(filePath);
            (0, db_1.logActivity)({
                id: crypto_1.default.randomUUID(),
                type: 'bridge_analyze_bounce',
                message: `Analyzed bounce: ${path_1.default.basename(filePath)}`,
                project_id: p?.id,
                metadata: { filePath, analysis },
            });
            send(res, 200, { filePath, fileName: path_1.default.basename(filePath), analysis });
        }
        catch (err) {
            send(res, 500, { error: String(err) });
        }
        return;
    }
    // ── POST /log-action ──────────────────────────────────────────────────────
    if (req.method === 'POST' && route === '/log-action') {
        const { data: body, error: parseError } = await parseBodySafe(req);
        if (parseError) {
            send(res, 400, { error: 'Invalid JSON' });
            return;
        }
        const action = body.action;
        if (!action) {
            send(res, 400, { error: 'action required' });
            return;
        }
        const p = getActiveProject();
        (0, db_1.logActivity)({
            id: crypto_1.default.randomUUID(),
            type: `bridge_${action}`,
            message: String(body.message ?? action),
            project_id: body.projectId ?? p?.id,
            metadata: (body.metadata ?? {}),
        });
        send(res, 200, { status: 'ok' });
        return;
    }
    // ── POST /open-copilot-panel ──────────────────────────────────────────────
    if (req.method === 'POST' && route === '/open-copilot-panel') {
        try {
            // Import toggleOverlay lazily to avoid circular dependency
            const { toggleOverlay } = await Promise.resolve().then(() => __importStar(require('./copilot')));
            toggleOverlay();
            (0, db_1.logActivity)({ id: crypto_1.default.randomUUID(), type: 'bridge_open_copilot', message: 'Opened Wavi Copilot panel via bridge', metadata: {} });
            send(res, 200, { status: 'ok' });
        }
        catch (err) {
            send(res, 500, { error: String(err) });
        }
        return;
    }
    // ── GET /pending-associations ──────────────────────────────────────────
    if (req.method === 'GET' && route === '/pending-associations') {
        try {
            const items = (0, db_1.getPendingAssociations)(50);
            send(res, 200, { items, count: items.length });
        }
        catch (err) {
            send(res, 500, { error: String(err) });
        }
        return;
    }
    // ── POST /confirm-association ─────────────────────────────────────────
    if (req.method === 'POST' && route === '/confirm-association') {
        try {
            const body = await parseBody(req);
            const { queueId, associationId, action, projectName } = body;
            if (!queueId && !associationId) {
                send(res, 400, { error: 'queueId or associationId required' });
                return;
            }
            const normalizedAction = action ?? 'confirmed';
            if (!['confirmed', 'rejected', 'deferred', 'undo'].includes(normalizedAction)) {
                send(res, 400, { error: `Invalid action: ${normalizedAction}` });
                return;
            }
            if (queueId) {
                const queueStatus = normalizedAction === 'undo' ? 'deferred'
                    : normalizedAction;
                (0, db_1.resolveAssociationQueue)(queueId, queueStatus);
            }
            if (associationId) {
                if (normalizedAction === 'undo') {
                    (0, db_1.undoAssociation)(associationId);
                }
                else if (normalizedAction === 'confirmed') {
                    (0, db_1.confirmAssociation)(associationId, 'user');
                }
            }
            (0, db_1.logActivity)({
                id: crypto_1.default.randomUUID(),
                type: 'bridge_association_action',
                message: `Association ${normalizedAction}: ${queueId ?? associationId}${projectName ? ` (${projectName})` : ''}`,
                metadata: { queueId, associationId, action: normalizedAction, projectName },
            });
            send(res, 200, { status: 'ok', action: normalizedAction });
        }
        catch (err) {
            send(res, 500, { error: String(err) });
        }
        return;
    }
    // ── POST /classify-file ───────────────────────────────────────────────
    if (req.method === 'POST' && route === '/classify-file') {
        try {
            const body = await parseBody(req);
            const filePath = body.filePath;
            if (!filePath) {
                send(res, 400, { error: 'filePath required' });
                return;
            }
            // Security: path must be inside a watched folder
            const Store = (await Promise.resolve().then(() => __importStar(require('electron-store')))).default;
            const store = new Store();
            const watchedFolders = store.get('watchedFolders', []);
            const isAllowed = watchedFolders.some(f => filePath.startsWith(f));
            if (!isAllowed) {
                send(res, 403, { error: 'filePath is outside all watched folders' });
                return;
            }
            if (!fs_1.default.existsSync(filePath)) {
                send(res, 404, { error: 'File not found', filePath });
                return;
            }
            const stat = fs_1.default.statSync(filePath);
            const result = (0, fileClassifier_1.classifyFile)(filePath, stat);
            (0, db_1.logActivity)({
                id: crypto_1.default.randomUUID(),
                type: 'bridge_classify_file',
                message: `Classified: ${path_1.default.basename(filePath)} → ${result.role} (${Math.round(result.confidence * 100)}%)`,
                metadata: { filePath, role: result.role, confidence: result.confidence },
            });
            send(res, 200, {
                filePath,
                fileName: path_1.default.basename(filePath),
                role: result.role,
                confidence: result.confidence,
                tokens: result.tokens,
                signals: result.signals,
            });
        }
        catch (err) {
            send(res, 500, { error: String(err) });
        }
        return;
    }
    // ── POST /run-command ─────────────────────────────────────────────────────
    // Executes a shell command scoped to the active project folder.
    // Only commands in the COMMAND_ALLOWLIST are permitted.
    if (req.method === 'POST' && route === '/run-command') {
        try {
            const body = await parseBody(req);
            const command = body.command;
            const cwd = body.cwd;
            if (!command || typeof command !== 'string' || !command.trim()) {
                send(res, 400, { error: 'command required' });
                return;
            }
            // Security: only allow safe read/info commands — no rm, curl, eval, etc.
            const COMMAND_ALLOWLIST = [
                /^ls(\s|$)/,
                /^cat\s/,
                /^echo(\s|$)/,
                /^pwd$/,
                /^find\s/,
                /^grep\s/,
                /^wc\s/,
                /^file\s/,
                /^open\s/,
                /^ffprobe\s/,
                /^ffmpeg\s/,
                /^python3?\s/,
                /^node\s/,
                /^npm\s(run|list|info)/,
                /^git\s(status|log|diff|show|branch)/,
            ];
            const trimmedCommand = command.trim();
            const isAllowed = COMMAND_ALLOWLIST.some(re => re.test(trimmedCommand));
            if (!isAllowed) {
                send(res, 403, { error: `Command not in allowlist: "${trimmedCommand.split(' ')[0]}"` });
                return;
            }
            // Resolve working directory: use provided cwd, or active project folder, or home
            const p = getActiveProject();
            const projectFolder = p?.file_path ? path_1.default.dirname(p.file_path) : null;
            const resolvedCwd = cwd ?? projectFolder ?? os_1.default.homedir();
            // Validate cwd exists
            if (!fs_1.default.existsSync(resolvedCwd)) {
                send(res, 400, { error: `cwd does not exist: ${resolvedCwd}` });
                return;
            }
            const { execFile } = await Promise.resolve().then(() => __importStar(require('child_process')));
            const { promisify } = await Promise.resolve().then(() => __importStar(require('util')));
            const execFileAsync = promisify(execFile);
            const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', trimmedCommand], {
                cwd: resolvedCwd,
                timeout: 10000,
                maxBuffer: 256 * 1024,
            });
            (0, db_1.logActivity)({
                id: crypto_1.default.randomUUID(),
                type: 'bridge_run_command',
                message: `Ran: ${trimmedCommand.slice(0, 80)}`,
                project_id: p?.id,
                metadata: { command: trimmedCommand, cwd: resolvedCwd },
            });
            send(res, 200, {
                status: 'ok',
                stdout: stdout ?? '',
                stderr: stderr ?? '',
                cwd: resolvedCwd,
                command: trimmedCommand,
            });
        }
        catch (err) {
            // execFile throws on non-zero exit — return stdout/stderr anyway
            send(res, 200, {
                status: 'error',
                stdout: err.stdout ?? '',
                stderr: err.stderr ?? String(err),
                exitCode: err.code ?? 1,
                command: err.cmd ?? '',
            });
        }
        return;
    }
    // ── POST /chat ────────────────────────────────────────────────────────────
    if (req.method === 'POST' && route === '/chat') {
        try {
            const body = await parseBody(req);
            const messages = body.messages;
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                send(res, 400, { error: 'messages array required' });
                return;
            }
            const p = getActiveProject();
            const ctx = buildProjectContext(p);
            // Resolve auth token for cloud LLM
            let authToken = null;
            try {
                const Store = (await Promise.resolve().then(() => __importStar(require('electron-store')))).default;
                const store = new Store();
                const raw = store.get('authToken', null);
                if (raw) {
                    const { safeStorage } = require('electron');
                    authToken = safeStorage.isEncryptionAvailable()
                        ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
                        : raw;
                }
            }
            catch { /* no auth — will use fallback */ }
            const { runAgentChat } = await Promise.resolve().then(() => __importStar(require('./agentLoop')));
            const reply = await runAgentChat(messages, ctx, authToken);
            (0, db_1.logActivity)({
                id: crypto_1.default.randomUUID(),
                type: 'bridge_chat',
                message: `Chat: "${messages[messages.length - 1]?.content?.slice(0, 80)}"`,
                project_id: p?.id,
                metadata: { messageCount: messages.length },
            });
            send(res, 200, { reply, context: { projectName: ctx.projectName, dawType: ctx.dawType } });
        }
        catch (err) {
            send(res, 500, { error: String(err) });
        }
        return;
    }
    // ── 404 ───────────────────────────────────────────────────────────────────
    send(res, 404, { error: `Unknown route: ${req.method} ${route}` });
}
// ── Public API ────────────────────────────────────────────────────────────────
function startBridgeServer() {
    _bridgeToken = ensureToken();
    _server = http_1.default.createServer(async (req, res) => {
        // Hard 20-second timeout per request (LLM chat may take a while)
        const timeout = setTimeout(() => {
            if (!res.headersSent) {
                console.error('[bridge] Request timeout:', req.method, req.url);
                try {
                    send(res, 504, { error: 'Bridge handler timed out' });
                }
                catch { }
            }
        }, 20000);
        try {
            await handleRequest(req, res);
        }
        catch (err) {
            console.error('[bridge] Unhandled error:', err);
            try {
                send(res, 500, { error: 'Internal server error' });
            }
            catch { }
        }
        finally {
            clearTimeout(timeout);
        }
    });
    _server.listen(exports.BRIDGE_PORT, exports.BRIDGE_HOST, () => {
        console.log(`[bridge] Wavi Studio bridge running on http://${exports.BRIDGE_HOST}:${exports.BRIDGE_PORT}`);
        console.log(`[bridge] Token written to ${TOKEN_PATH}`);
    });
    _server.on('clientError', (err) => {
        // Handle malformed JSON and other client errors
        console.error('[bridge] Client error:', err.message);
        // We can't send a response here as the connection is already broken
    });
    _server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`[bridge] Port ${exports.BRIDGE_PORT} in use — bridge server not started`);
        }
        else {
            console.error('[bridge] Server error:', err);
        }
    });
}
function stopBridgeServer() {
    _server?.close();
    _server = null;
}
function getBridgeToken() {
    return _bridgeToken;
}
