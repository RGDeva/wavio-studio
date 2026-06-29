"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUDIO_EXTS = void 0;
exports.shouldSkipDirTest = shouldSkipDirTest;
/**
 * Test-only re-exports from discovery.ts so tests can reach internal helpers
 * without making them part of the public API.
 */
const path_1 = __importDefault(require("path"));
const discovery_1 = require("./discovery");
Object.defineProperty(exports, "AUDIO_EXTS", { enumerable: true, get: function () { return discovery_1.AUDIO_EXTS; } });
const SKIP_DIRS = new Set([
    'node_modules', '.npm', '.yarn', '.pnp', 'bower_components',
    '.cargo', '.rustup', '__pycache__', 'venv', '.venv',
    'target', 'dist', 'build', 'out', '.next', '.nuxt', '.cache',
    '.git', '.svn', '.hg',
    '.Trash', '.Spotlight-V100', '.fseventsd', '.DocumentRevisions-V100',
    '.TemporaryItems', '.DS_Store', 'System', 'private', 'usr',
    'com~apple~CloudDocs',
    'release', 'dist-electron', '.electron-gyp',
    'DerivedData', 'xcuserdata',
]);
function shouldSkipDirTest(name, fullPath) {
    if (name.startsWith('.'))
        return true;
    if (SKIP_DIRS.has(name))
        return true;
    const ext = path_1.default.extname(name).toLowerCase();
    if (['.app', '.framework', '.bundle', '.xcodeproj', '.pkg'].includes(ext))
        return true;
    if (name === 'release' && fullPath.includes('wavio'))
        return true;
    return false;
}
