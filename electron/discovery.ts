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

import { readdirSync, statSync, lstatSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { app } from 'electron';
import { KNOWN_DAW_PROJECT_EXTENSIONS } from './adapters';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveryOptions {
  roots?: string[];
  extraRoots?: string[];
  excludePaths?: string[];
  maxFiles?: number;
  maxDurationMs?: number;
  maxDepth?: number;
  signal?: { aborted: boolean };
}

export interface DiscoveryProgress {
  scanned: number;
  found: number;
  imported: number;
  duplicates: number;
  permissionErrors: number;
  phase: 'scanning' | 'importing' | 'done' | 'cancelled' | 'limit_reached';
  currentDir?: string;
}

export interface DiscoveryResult {
  found: number;
  imported: number;
  duplicates: number;
  permissionErrors: number;
  scanned: number;
  durationMs: number;
  cancelled: boolean;
  limitReached: boolean;
}

// ── Audio extensions that are worth indexing ──────────────────────────────────

export const AUDIO_EXTS = new Set([
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
  // ── Caches / backups / temp exports (Phase 2: sync-engine scalability) ───
  'Cache', 'Caches', 'CachedData', 'Temp', 'tmp', '.tmp',
  'Time Machine Backups', '.Trashes', 'Backup', 'Backups', 'Old Backups',
  'Exported', 'Freeze Files', 'Frozen',
  // Plugin content — large, rarely worth syncing, frequently duplicated
  // across every DAW install on the machine
  'VST', 'VST3', 'Components', 'Audio Music Apps', 'Plug-Ins', 'Plugins',
  'Kontakt', 'iLok', 'Waves Preferences',
]);

// Name patterns that indicate a directory should be skipped
function shouldSkipDir(name: string, fullPath: string): boolean {
  if (name.startsWith('.')) return true;           // hidden
  if (SKIP_DIRS.has(name)) return true;            // exact match
  const ext = path.extname(name).toLowerCase();
  // Skip macOS package bundles (except .logicx which we want to index)
  if (['.app', '.framework', '.bundle', '.xcodeproj', '.pkg'].includes(ext)) return true;
  // Skip Wavio's own release output wherever it lives
  if (name === 'release' && fullPath.includes('wavio')) return true;
  return false;
}

// ── Sample-library heuristic ──────────────────────────────────────────────────
// A folder is "likely a sample library" (not a user's own project) when it
// has a large number of audio files but essentially no DAW project files
// alongside them, and/or its name matches a well-known sample-vendor
// pattern. We never auto-index these — the caller must get explicit user
// confirmation first (see files:confirmAmbiguousFolder in main.ts). Never
// classifies on file count alone: the ratio to DAW project files is the
// signal, since a real project folder with many stems/bounces is legitimate.
// Derived from the DAW adapter registry (Phase F) — same membership as the
// previous hardcoded list; adapters are the single source of truth now.
const DAW_PROJECT_EXTS: ReadonlySet<string> = KNOWN_DAW_PROJECT_EXTENSIONS;
const SAMPLE_LIBRARY_NAME_PATTERNS = [
  /splice/i, /loopmasters/i, /native instruments/i, /kontakt library/i,
  /output\s*(rev|arcade|portal)/i, /spitfire/i, /sample\s*pack/i,
  /loop\s*pack/i, /construction\s*kit/i, /\bwav\s*library\b/i,
];

export interface FolderClassification {
  path: string;
  audioFileCount: number;
  projectFileCount: number;
  likelySampleLibrary: boolean;
  reason: 'name_match' | 'high_audio_ratio' | 'none';
}

/**
 * Classifies a folder as a likely sample library vs a real project folder,
 * given its direct-child entry names. Used before indexing an ambiguous
 * large folder so the caller can prompt for confirmation rather than
 * silently uploading what might be a purchased sample library.
 */
export function classifyFolderForImport(dirPath: string, entryNames: string[]): FolderClassification {
  const name = path.basename(dirPath);
  const nameMatch = SAMPLE_LIBRARY_NAME_PATTERNS.some((re) => re.test(name));

  let audioFileCount = 0;
  let projectFileCount = 0;
  for (const entryName of entryNames) {
    const ext = path.extname(entryName).toLowerCase();
    if (DAW_PROJECT_EXTS.has(ext)) projectFileCount++;
    else if (AUDIO_EXTS.has(ext)) audioFileCount++;
  }

  if (nameMatch) {
    return { path: dirPath, audioFileCount, projectFileCount, likelySampleLibrary: true, reason: 'name_match' };
  }

  // High-ratio heuristic: many audio files, essentially no project file.
  // The absolute threshold (200) keeps this from firing on a legitimate
  // project's stems/bounces folder, which normally holds a handful of files.
  const highRatio = audioFileCount >= 200 && projectFileCount === 0;
  return {
    path: dirPath,
    audioFileCount,
    projectFileCount,
    likelySampleLibrary: highRatio,
    reason: highRatio ? 'high_audio_ratio' : 'none',
  };
}

// ── Default roots ─────────────────────────────────────────────────────────────

export function defaultDiscoveryRoots(): string[] {
  return [
    app.getPath('music'),
    app.getPath('documents'),
    app.getPath('desktop'),
  ];
}

// ── Core walk ────────────────────────────────────────────────────────────────

export async function discoverAudioFiles(
  options: DiscoveryOptions,
  onProgress?: (p: DiscoveryProgress) => void,
): Promise<{ paths: string[]; result: Omit<DiscoveryResult, 'imported' | 'durationMs' | 'cancelled' | 'limitReached'> }> {
  const {
    roots = defaultDiscoveryRoots(),
    extraRoots = [],
    excludePaths = [],
    maxFiles = 100_000,
    maxDurationMs = 120_000,   // 2 minutes hard stop
    maxDepth = 6,
    signal,
  } = options;

  const allRoots = [...roots, ...extraRoots];
  const excludeSet = new Set(excludePaths.map(p => path.resolve(p)));
  const foundPaths: string[] = [];
  const visitedInodes = new Set<number>(); // symlink-loop protection
  const startMs = Date.now();

  let scanned = 0;
  let permissionErrors = 0;
  let limitReached = false;
  let cancelled = false;

  function progress(phase: DiscoveryProgress['phase'], currentDir?: string) {
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

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    if (signal?.aborted) { cancelled = true; return; }
    if (Date.now() - startMs > maxDurationMs) { limitReached = true; return; }
    if (foundPaths.length >= maxFiles) { limitReached = true; return; }
    if (excludeSet.has(path.resolve(dir))) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      permissionErrors++;
      return;
    }

    progress('scanning', dir);

    for (const entry of entries) {
      if (signal?.aborted) { cancelled = true; return; }
      if (limitReached) return;
      if (foundPaths.length >= maxFiles) { limitReached = true; return; }

      const fullPath = path.join(dir, entry.name);

      // Resolve symlinks safely
      let resolvedEntry = entry;
      let inode = 0;
      try {
        const lst = lstatSync(fullPath);
        inode = lst.ino;
        if (lst.isSymbolicLink()) {
          // Dereference to check target type, but guard against loops
          const real = statSync(fullPath); // follows symlink
          if (real.isDirectory()) {
            if (visitedInodes.has(inode)) continue; // loop
            visitedInodes.add(inode);
            if (!shouldSkipDir(entry.name, fullPath)) {
              walk(fullPath, depth + 1);
            }
            continue;
          }
        }
      } catch { continue; }

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name, fullPath)) continue;
        if (inode && visitedInodes.has(inode)) continue;
        if (inode) visitedInodes.add(inode);
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        scanned++;
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTS.has(ext)) {
          foundPaths.push(fullPath);
        }
      }
    }
  }

  for (const root of allRoots) {
    if (cancelled || limitReached) break;
    try { statSync(root); } catch { continue; }
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
