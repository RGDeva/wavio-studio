"use strict";
/**
 * Hardened audio-file discovery engine.
 *
 * Scans user-selected roots (default: ~/Music, ~/Documents, ~/Desktop) for
 * audio and DAW project files. Designed for production use:
 *
 *  - Respects a file-count safety limit and a wall-clock duration limit
 *  - Skips hidden folders, package bundles (.app/.framework), system dirs,
 *    known heavy/irrelevant dirs (node_modules, .git, caches, cloud mirrors)
 *  - Detects and breaks symlink loops via a visited-inode set
 *  - Reports per-category progress to the renderer via a callback
 *  - Runs entirely in the main process (no renderer blocking)
 *  - Idempotent: upsertStandaloneFile uses file_path as unique key
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUDIO_EXTS = void 0;
exports.defaultDiscoveryRoots = defaultDiscoveryRoots;
exports.discoverAudioFiles = discoverAudioFiles;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
// ── Audio extensions that are worth indexing ──────────────────────────────────
exports.AUDIO_EXTS = new Set([
    '.wav', '.mp3', '.aiff', '.aif', '.flac', '.m4a', '.ogg', '.aac',
    '.opus', '.wma', '.caf',
    // DAW project files
    '.flp', '.als', '.ptx', '.ptf', '.rpp', '.logic', '.band',
    '.npr', '.sesx', '.song', '.reason', '.bwproject', '.cpr', '.vstpreset',
]);
// ── Folders to skip unconditionally ──────────────────────────────────────────
const SKIP_DIRS = new Set([
    // Package managers / build
    'node_modules', '.npm', '.yarn', '.pnp', 'bower_components',
    '.cargo', '.rustup', '__pycache__', 'venv', '.venv',
    'target', 'dist', 'build', 'out', '.next', '.nuxt', '.cache',
    // Source control
    '.git', '.svn', '.hg',
    // macOS / system
    '.Trash', '.Spotlight-V100', '.fseventsd', '.DocumentRevisions-V100',
    '.TemporaryItems', '.DS_Store', 'System', 'private', 'usr',
    // iCloud / cloud-drive mirror duplication
    'com~apple~CloudDocs',
    // Electron / wavio build artefacts
    'release', 'dist-electron', '.electron-gyp',
    // Xcode
    'DerivedData', 'xcuserdata',
]);
// Name patterns that indicate a directory should be skipped
function shouldSkipDir(name, fullPath) {
    if (name.startsWith('.'))
        return true; // hidden
    if (SKIP_DIRS.has(name))
        return true; // exact match
    const ext = path_1.default.extname(name).toLowerCase();
    // Skip macOS package bundles (except .logicx which we want to index)
    if (['.app', '.framework', '.bundle', '.xcodeproj', '.pkg'].includes(ext))
        return true;
    // Skip Wavio's own release output wherever it lives
    if (name === 'release' && fullPath.includes('wavio'))
        return true;
    return false;
}
// ── Default roots ─────────────────────────────────────────────────────────────
function defaultDiscoveryRoots() {
    return [
        electron_1.app.getPath('music'),
        electron_1.app.getPath('documents'),
        electron_1.app.getPath('desktop'),
    ];
}
// ── Core walk ────────────────────────────────────────────────────────────────
async function discoverAudioFiles(options, onProgress) {
    const { roots = defaultDiscoveryRoots(), extraRoots = [], excludePaths = [], maxFiles = 100000, maxDurationMs = 120000, // 2 minutes hard stop
    maxDepth = 6, signal, } = options;
    const allRoots = [...roots, ...extraRoots];
    const excludeSet = new Set(excludePaths.map(p => path_1.default.resolve(p)));
    const foundPaths = [];
    const visitedInodes = new Set(); // symlink-loop protection
    const startMs = Date.now();
    let scanned = 0;
    let permissionErrors = 0;
    let limitReached = false;
    let cancelled = false;
    function progress(phase, currentDir) {
        onProgress?.({
            scanned,
            found: foundPaths.length,
            imported: 0,
            duplicates: 0,
            permissionErrors,
            phase,
            currentDir,
        });
    }
    function walk(dir, depth) {
        if (depth > maxDepth)
            return;
        if (signal?.aborted) {
            cancelled = true;
            return;
        }
        if (Date.now() - startMs > maxDurationMs) {
            limitReached = true;
            return;
        }
        if (foundPaths.length >= maxFiles) {
            limitReached = true;
            return;
        }
        if (excludeSet.has(path_1.default.resolve(dir)))
            return;
        let entries;
        try {
            entries = (0, fs_1.readdirSync)(dir, { withFileTypes: true });
        }
        catch {
            permissionErrors++;
            return;
        }
        progress('scanning', dir);
        for (const entry of entries) {
            if (signal?.aborted) {
                cancelled = true;
                return;
            }
            if (limitReached)
                return;
            if (foundPaths.length >= maxFiles) {
                limitReached = true;
                return;
            }
            const fullPath = path_1.default.join(dir, entry.name);
            // Resolve symlinks safely
            let resolvedEntry = entry;
            let inode = 0;
            try {
                const lst = (0, fs_1.lstatSync)(fullPath);
                inode = lst.ino;
                if (lst.isSymbolicLink()) {
                    // Dereference to check target type, but guard against loops
                    const real = (0, fs_1.statSync)(fullPath); // follows symlink
                    if (real.isDirectory()) {
                        if (visitedInodes.has(inode))
                            continue; // loop
                        visitedInodes.add(inode);
                        if (!shouldSkipDir(entry.name, fullPath)) {
                            walk(fullPath, depth + 1);
                        }
                        continue;
                    }
                }
            }
            catch {
                continue;
            }
            if (entry.isDirectory()) {
                if (shouldSkipDir(entry.name, fullPath))
                    continue;
                if (inode && visitedInodes.has(inode))
                    continue;
                if (inode)
                    visitedInodes.add(inode);
                walk(fullPath, depth + 1);
            }
            else if (entry.isFile()) {
                scanned++;
                const ext = path_1.default.extname(entry.name).toLowerCase();
                if (exports.AUDIO_EXTS.has(ext)) {
                    foundPaths.push(fullPath);
                }
            }
        }
    }
    for (const root of allRoots) {
        if (cancelled || limitReached)
            break;
        try {
            (0, fs_1.statSync)(root);
        }
        catch {
            continue;
        }
        walk(root, 0);
    }
    return {
        paths: foundPaths,
        result: {
            found: foundPaths.length,
            scanned,
            duplicates: 0,
            permissionErrors,
        },
    };
}
