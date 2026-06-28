import chokidar, { FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { upsertProject, upsertFile, upsertStandaloneFile, enqueueSyncItem, logActivity, createVersion, addBounceCandidate, getBounceCandidateByPath, versionExistsByChecksum, versionExistsByPath, updateFileClassificationByPath } from './db';
import { detectBpm } from './bpmDetector';
import { analyzeAudio } from './audioAnalyzer';
import { classifyFile as classifyFileLegacy } from './classifier';
import { classifyFile as classifyFileV1 } from './projectAssociation/fileClassifier';
import { runAssociationEngine } from './projectAssociation/projectAssociationEngine';

const BPM_EXTENSIONS = new Set(['.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a']);

const DAW_EXTENSIONS = new Set(['.flp', '.ptx', '.ptf', '.als', '.logic', '.logicx', '.rpp', '.cpr', '.band', '.sesx', '.song', '.reason', '.bwproject', '.npr']);
const DEPENDENCY_EXTENSIONS = new Set(['.wav', '.mp3', '.aiff', '.aif', '.mid', '.midi', '.stems', '.flac', '.ogg', '.m4a', '.aac', '.opus']);

export interface WatcherEvent {
  type: 'project_added' | 'project_changed' | 'project_deleted' | 'dependency_found' | 'bounce_detected';
  filePath: string;
  projectId?: string;
  role?: string;
  candidateId?: string;
  timestamp: string;
}

const EXPORT_FOLDER_NAMES = new Set(['exports', 'export', 'bounces', 'bounce', 'stems', 'stem', 'masters', 'master', 'mixes', 'mix', 'renders', 'render']);

function isInExportFolder(filePath: string): boolean {
  const parts = filePath.split(path.sep);
  return parts.some(p => EXPORT_FOLDER_NAMES.has(p.toLowerCase()));
}

function generateId(): string {
  return crypto.randomUUID();
}

export async function fileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', () => resolve(crypto.randomUUID()));
    } catch {
      resolve(crypto.randomUUID());
    }
  });
}

function getDawType(ext: string): string {
  const map: Record<string, string> = {
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
    '.song': 'Studio One',
    '.reason': 'Reason',
    '.bwproject': 'Bitwig Studio',
    '.npr': 'Nuendo',
  };
  return map[ext] ?? 'Unknown';
}

function getProjectName(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

// Per-file stabilization: detect → wait STABILIZE_MS → re-check size → process if unchanged.
const STABILIZE_MS = 1500;    // wait after first detection
const STABILIZE_RECHECK_MS = 1000; // re-check interval
const STABILIZE_MAX_RECHECKS = 8;  // give up after ~8s total

export class WatcherManager {
  private watchers = new Map<string, FSWatcher>();
  private db: Database.Database;
  private _rawOnEvent: (event: WatcherEvent) => void;
  private projectMap = new Map<string, string>();
  private pendingVersions = new Map<string, ReturnType<typeof setTimeout>>();
  // Per-file stabilization: filePath → { timer, size, recheckCount }
  private stabilizationMap = new Map<string, { timer: ReturnType<typeof setTimeout>; size: number; recheckCount: number }>(); 
  // Debounced association engine: run at most once per 30 s after new files arrive
  private _assocEngineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(db: Database.Database, onEvent: (event: WatcherEvent) => void) {
    this.db = db;
    this._rawOnEvent = onEvent;
  }

  private onEvent(event: WatcherEvent) {
    this._rawOnEvent(event);
  }

  /**
   * Per-file stabilization gate.
   * When a file is first seen (or changes), we record its size, wait STABILIZE_MS,
   * then re-check. If the size is still the same we call onReady; otherwise we
   * reschedule for another STABILIZE_RECHECK_MS. Gives up after STABILIZE_MAX_RECHECKS.
   */
  private stableFile(filePath: string, onReady: () => void) {
    // Cancel any pending stabilization for this path
    const existing = this.stabilizationMap.get(filePath);
    if (existing) clearTimeout(existing.timer);

    let currentSize = 0;
    try { currentSize = fs.statSync(filePath).size; } catch { return; }

    const check = (prevSize: number, recheckCount: number) => {
      if (this._stopped) return;
      let nowSize = 0;
      try { nowSize = fs.statSync(filePath).size; } catch {
        this.stabilizationMap.delete(filePath);
        return;
      }
      if (nowSize === prevSize && nowSize > 0) {
        // File is stable
        this.stabilizationMap.delete(filePath);
        onReady();
        return;
      }
      if (recheckCount >= STABILIZE_MAX_RECHECKS) {
        // Timed out — process anyway (file may be legitimately large)
        this.stabilizationMap.delete(filePath);
        onReady();
        return;
      }
      const timer = setTimeout(() => check(nowSize, recheckCount + 1), STABILIZE_RECHECK_MS);
      this.stabilizationMap.set(filePath, { timer, size: nowSize, recheckCount: recheckCount + 1 });
    };

    const timer = setTimeout(() => check(currentSize, 0), STABILIZE_MS);
    this.stabilizationMap.set(filePath, { timer, size: currentSize, recheckCount: 0 });
  }

  addFolder(folderPath: string) {
    if (this.watchers.has(folderPath)) return;

    // Only watch audio & DAW files — avoids scanning tens of thousands of irrelevant files
    const audioGlob = '**/*.{flp,ptx,ptf,als,logic,logicx,rpp,cpr,band,sesx,song,reason,bwproject,npr,wav,mp3,aiff,aif,mid,midi,flac,ogg,m4a,aac,opus}';
    const watcher = chokidar.watch(audioGlob, {
      cwd: folderPath,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      depth: 3,
      awaitWriteFinish: {
        stabilityThreshold: 3000,
        pollInterval: 500,
      },
      ignored: /(^|[/\\])(\.|(node_modules|__MACOSX|Backup|Autosave|\.trash))/,
    });

    watcher
      .on('add', (rel) => {
        const abs = path.join(folderPath, rel);
        const ext = path.extname(rel).toLowerCase();
        // DAW files and non-audio deps: process immediately (chokidar's awaitWriteFinish handles them)
        if (DAW_EXTENSIONS.has(ext)) {
          this.handleFileEvent('add', abs);
        } else if (DEPENDENCY_EXTENSIONS.has(ext)) {
          // Audio files: use our own stabilization on top of awaitWriteFinish
          this.stableFile(abs, () => this.handleFileEvent('add', abs));
        }
      })
      .on('change', (rel) => {
        const abs = path.join(folderPath, rel);
        const ext = path.extname(rel).toLowerCase();
        if (DAW_EXTENSIONS.has(ext)) {
          this.handleFileEvent('change', abs);
        } else if (DEPENDENCY_EXTENSIONS.has(ext)) {
          this.stableFile(abs, () => this.handleFileEvent('change', abs));
        }
      })
      .on('unlink', (rel) => this.handleFileEvent('unlink', path.join(folderPath, rel)))
      .on('error', (err) => console.error('[watcher] error:', err))
      .on('ready', () => {
        // Walk existing files after watcher is fully initialized
        // (ignoreInitial=true means chokidar won't fire 'add' for them,
        //  so we do a one-time manual scan to pick up files already on disk)
        this.scanExisting(folderPath);
      });

    this.watchers.set(folderPath, watcher);

    logActivity({
      id: generateId(),
      type: 'folder_added',
      message: `Started monitoring: ${folderPath}`,
      metadata: { folderPath },
    });
  }

  async removeFolder(folderPath: string) {
    const watcher = this.watchers.get(folderPath);
    if (watcher) {
      await watcher.close().catch(() => {});
      this.watchers.delete(folderPath);
      logActivity({
        id: generateId(),
        type: 'folder_removed',
        message: `Stopped monitoring: ${folderPath}`,
        metadata: { folderPath },
      });
    }
  }

  async stopAll() {
    this._stopped = true;
    // Cancel all pending stabilization timers
    for (const { timer } of this.stabilizationMap.values()) clearTimeout(timer);
    this.stabilizationMap.clear();
    const closers = Array.from(this.watchers.values()).map(w => w.close().catch(() => {}));
    await Promise.all(closers);
    this.watchers.clear();
  }

  private _stopped = false;

  /**
   * One-time walk of existing files in a watched folder.
   * Runs after chokidar 'ready' so the native fsevents watcher is fully initialised
   * and won't race with cleanup.  Files are fed through handleFileEvent('add', …)
   * in small batches with yielding so the main thread stays responsive.
   * 
   * CRITICAL: Uses async fs.promises.readdir to avoid blocking the main thread
   * (synchronous fs.readdirSync causes 10+ second hangs on APFS with large folders)
   */
  private async scanExisting(folderPath: string) {
    const SCAN_EXTENSIONS = new Set([...DAW_EXTENSIONS, ...DEPENDENCY_EXTENSIONS]);
    const MAX_DEPTH = 3;
    const BATCH_SIZE = 50;
    const MAX_FILES = 2000; // hard cap per folder — prevents OOM on large libraries
    const ignoreRe = /(^|[/\\])(\.|(node_modules|__MACOSX|Backup|Autosave|\.trash))/;

    const queue: { dir: string; depth: number }[] = [{ dir: folderPath, depth: 0 }];
    let batch = 0;
    let totalFiles = 0;

    while (queue.length > 0 && !this._stopped && totalFiles < MAX_FILES) {
      const { dir, depth } = queue.shift()!;
      let entries: fs.Dirent[];
      // Use async readdir to prevent main thread blocking (fs.readdirSync hangs on APFS)
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch { continue; }

      for (const entry of entries) {
        if (this._stopped) return;
        const rel = path.relative(folderPath, path.join(dir, entry.name));
        if (ignoreRe.test(rel)) continue;

        if (entry.isDirectory() && depth < MAX_DEPTH) {
          queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SCAN_EXTENSIONS.has(ext)) {
            const abs = path.join(dir, entry.name);
            // Existing files: run through stabilization before processing
            // (avoids acting on partially-written files from a previous session)
            if (DEPENDENCY_EXTENSIONS.has(ext)) {
              this.stableFile(abs, () => this.handleFileEvent('add', abs));
            } else {
              this.handleFileEvent('add', abs);
            }
            totalFiles++;
            batch++;
            if (batch >= BATCH_SIZE) {
              batch = 0;
              await new Promise(r => setTimeout(r, 50));
            }
            if (totalFiles >= MAX_FILES) {
              console.warn(`[watcher] scanExisting hit ${MAX_FILES} file cap for ${folderPath} — stopping scan`);
              return;
            }
          }
        }
      }
    }
  }

  private handleFileEvent(event: 'add' | 'change' | 'unlink', filePath: string) {
    const ext = path.extname(filePath).toLowerCase();

    if (DAW_EXTENSIONS.has(ext)) {
      this.handleProjectFile(event, filePath);
    } else if (DEPENDENCY_EXTENSIONS.has(ext)) {
      this.handleDependencyFile(event, filePath);
    }
  }

  private handleProjectFile(event: 'add' | 'change' | 'unlink', filePath: string) {
    if (event === 'unlink') {
      this.onEvent({ type: 'project_deleted', filePath, timestamp: new Date().toISOString() });
      return;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const now = new Date().toISOString();

    // Check if project already exists
    const existing = this.db
      .prepare('SELECT id FROM projects WHERE file_path = ?')
      .get(filePath) as { id: string } | undefined;

    const projectId = existing?.id ?? generateId();
    this.projectMap.set(filePath, projectId);

    upsertProject({
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

    logActivity({
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
          .get(projectId) as { checksum: string } | undefined;
        if (lastVersion?.checksum === newChecksum) return;
        createVersion({
          id: generateId(),
          project_id: projectId,
          file_path: filePath,
          file_size: stats.size,
          checksum: newChecksum,
          created_at: new Date().toISOString(),
        });
        enqueueSyncItem({
          id: generateId(),
          project_id: projectId,
          file_name: path.basename(filePath),
          type: 'project_update',
          priority: 8,
          created_at: new Date().toISOString(),
        });
      }, 10_000));
    } else if (event === 'add') {
      enqueueSyncItem({
        id: generateId(),
        project_id: projectId,
        file_name: path.basename(filePath),
        type: 'project_upload',
        priority: 8,
        created_at: now,
      });
    }

    // Scan dependencies after a short delay
    setTimeout(() => this.scanDependencies(filePath, projectId), 2000);
  }

  private handleDependencyFile(event: 'add' | 'change' | 'unlink', filePath: string) {
    if (event === 'unlink') return;

    // Find which project this file belongs to
    let projectId: string | undefined;

    // Walk up directory tree to find a project file
    for (const [projectFilePath, pid] of this.projectMap.entries()) {
      if (filePath.startsWith(path.dirname(projectFilePath))) {
        projectId = pid;
        break;
      }
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return;
    }

    const now = new Date().toISOString();
    const fileId = generateId();

    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const role = classifyFileLegacy(fileName);

    // Async analysis pipeline — does not block watcher or upload queue
    fileChecksum(filePath).then(async (checksum) => {
      let bpm: number | null = null;
      let key_note: string | null = null;
      let duration: number | null = null;

      if (BPM_EXTENSIONS.has(ext)) {
        // Run BPM + full audio analysis in parallel
        const [detectedBpm, analysis] = await Promise.all([
          detectBpm(filePath).catch(() => null),
          analyzeAudio(filePath).catch(() => null),
        ]);
        bpm = detectedBpm;
        key_note = analysis?.key ?? null;
        duration = analysis?.duration ?? null;
      }

      if (projectId) {
        upsertFile({
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
      } else {
        // Standalone audio file — no parent project
        upsertStandaloneFile({
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

      // Phase 1 classification — runs synchronously (pure string ops, no I/O)
      try {
        const v1 = classifyFileV1(filePath, stats);
        updateFileClassificationByPath(filePath, {
          classifier_role:       v1.role,
          classifier_confidence: v1.confidence,
          name_tokens:           JSON.stringify(v1.tokens),
        });
      } catch {
        // Non-fatal — classification failure must never block ingestion
      }

      // Phase 2: debounce association engine — runs at most once per 30s
      if (this._assocEngineTimer) clearTimeout(this._assocEngineTimer);
      this._assocEngineTimer = setTimeout(() => {
        this._assocEngineTimer = null;
        try {
          const r = runAssociationEngine(this.db);
          if (r.groupsQueued > 0) {
            console.log(`[assoc] Engine run: found=${r.groupsFound} queued=${r.groupsQueued} skipped=${r.groupsSkipped} autoConfirmed=${r.autoConfirmed}`);
          }
        } catch (err) {
          console.error('[assoc] Engine error:', err);
        }
      }, 30_000);

      const parts: string[] = [];
      if (bpm) parts.push(`${bpm} BPM`);
      if (key_note) parts.push(key_note);
      if (role !== 'unknown') parts.push(role);
      if (parts.length) {
        logActivity({
          id: generateId(),
          type: 'file_analyzed',
          message: `${fileName}: ${parts.join(' · ')}`,
          project_id: projectId,
          metadata: { filePath, bpm, key_note, duration, role },
        });
      }

      // Enqueue for sync AFTER DB row exists (avoids race condition)
      enqueueSyncItem({
        id: generateId(),
        project_id: projectId ?? '__standalone__',
        file_id: fileId,
        file_name: path.basename(filePath),
        type: 'dependency_upload',
        priority: 3,
        created_at: now,
      });
    });

    // Detect bounce/export files — audio files inside known export subdirs
    const inExportFolder = isInExportFolder(filePath);
    if (inExportFolder && (event === 'add' || event === 'change') && BPM_EXTENSIONS.has(ext)) {
      const candidateRole = classifyFileLegacy(fileName);
      const folderLabel = filePath.split(path.sep).reverse()
        .find(p => EXPORT_FOLDER_NAMES.has(p.toLowerCase())) ?? 'export';
      const effectiveRole = candidateRole !== 'unknown' ? candidateRole
        : folderLabel === 'masters' || folderLabel === 'master' ? 'master'
        : folderLabel === 'stems' || folderLabel === 'stem' ? 'stem'
        : folderLabel === 'mixes' || folderLabel === 'mix' ? 'mix'
        : 'mix';

      // Checksum-based dedup: if we already have a resolved (non-ignored) candidate for this
      // checksum+project, don't create a new one.
      fileChecksum(filePath).then((checksum) => {
        // Check if already tracked
        const existing = getBounceCandidateByPath(filePath);
        if (existing && existing.status !== 'ignored') {
          // Already pending or resolved — do nothing
          return;
        }
        // If ignored but same checksum — stay ignored
        if (existing && existing.status === 'ignored' && existing.checksum === checksum) {
          return;
        }

        const candidateId = generateId();
        const returnedId = addBounceCandidate({
          id: candidateId,
          project_id: projectId ?? null,
          file_path: filePath,
          file_name: fileName,
          file_size: stats.size,
          checksum,
          role: effectiveRole,
          detected_at: now,
        });

        // If addBounceCandidate returned an existing id, it was already tracked — still notify renderer
        const effectiveCandidateId = returnedId ?? candidateId;

        logActivity({
          id: generateId(),
          type: 'bounce_detected',
          message: `New ${effectiveRole} detected: ${fileName}`,
          project_id: projectId,
          metadata: { filePath, role: effectiveRole, candidateId: effectiveCandidateId, folderLabel },
        });

        this.onEvent({ type: 'bounce_detected', filePath, projectId, role: effectiveRole, candidateId: effectiveCandidateId, timestamp: now });
      }).catch(() => {
        // Checksum failed — still surface the detection
        const existing = getBounceCandidateByPath(filePath);
        if (!existing || existing.status === 'ignored') {
          const candidateId = generateId();
          addBounceCandidate({
            id: candidateId,
            project_id: projectId ?? null,
            file_path: filePath,
            file_name: fileName,
            file_size: stats.size,
            role: effectiveRole,
            detected_at: now,
          });
          this.onEvent({ type: 'bounce_detected', filePath, projectId, role: effectiveRole, candidateId, timestamp: now });
        }
      });
    } else {
      this.onEvent({ type: 'dependency_found', filePath, projectId, timestamp: now });
    }
  }

  private scanDependencies(projectFilePath: string, projectId: string) {
    const dir = path.dirname(projectFilePath);
    this.scanDir(dir, projectId, 0);
  }

  private scanDir(dirPath: string, projectId: string, depth: number) {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        this.scanDir(fullPath, projectId, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (DEPENDENCY_EXTENSIONS.has(ext)) {
          this.handleDependencyFile('add', fullPath);
        }
      }
    }
  }
}
