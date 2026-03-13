import chokidar, { FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { upsertProject, upsertFile, upsertStandaloneFile, enqueueSyncItem, logActivity, createVersion } from './db';
import { detectBpm } from './bpmDetector';
import { analyzeAudio } from './audioAnalyzer';
import { classifyFile } from './classifier';

const BPM_EXTENSIONS = new Set(['.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a']);

const DAW_EXTENSIONS = new Set(['.flp', '.ptx', '.ptf', '.als', '.logic', '.logicx', '.rpp', '.cpr', '.band', '.sesx']);
const DEPENDENCY_EXTENSIONS = new Set(['.wav', '.mp3', '.aiff', '.aif', '.mid', '.midi', '.stems', '.flac', '.ogg', '.m4a', '.aac']);

export interface WatcherEvent {
  type: 'project_added' | 'project_changed' | 'project_deleted' | 'dependency_found';
  filePath: string;
  projectId?: string;
  timestamp: string;
}

function generateId(): string {
  return crypto.randomUUID();
}

async function fileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex').slice(0, 16)));
      stream.on('error', () => resolve(generateId().slice(0, 16)));
    } catch {
      resolve(generateId().slice(0, 16));
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
  };
  return map[ext] ?? 'Unknown';
}

function getProjectName(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

export class WatcherManager {
  private watchers = new Map<string, FSWatcher>();
  private db: Database.Database;
  private onEvent: (event: WatcherEvent) => void;
  private projectMap = new Map<string, string>();
  private pendingVersions = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(db: Database.Database, onEvent: (event: WatcherEvent) => void) {
    this.db = db;
    this.onEvent = onEvent;
  }

  addFolder(folderPath: string) {
    if (this.watchers.has(folderPath)) return;

    const watcher = chokidar.watch(folderPath, {
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

    logActivity({
      id: generateId(),
      type: 'folder_added',
      message: `Started monitoring: ${folderPath}`,
      metadata: { folderPath },
    });
  }

  removeFolder(folderPath: string) {
    const watcher = this.watchers.get(folderPath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(folderPath);
      logActivity({
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
    const role = classifyFile(fileName);

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
    });

    // Enqueue for sync (project_id can be null for standalone files)
    enqueueSyncItem({
      id: generateId(),
      project_id: projectId ?? '__standalone__',
      file_id: fileId,
      file_name: path.basename(filePath),
      type: 'dependency_upload',
      priority: 3,
      created_at: now,
    });

    this.onEvent({ type: 'dependency_found', filePath, projectId, timestamp: now });
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
