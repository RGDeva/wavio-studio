import { ipcMain, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { DawSnapshot, DetectedFile } from '../src/types/daw';

const DAW_EXTENSIONS = new Set(['.als', '.alc', '.adg', '.wav', '.aiff', '.mp3', '.mid', '.json']);

export function registerAbletonHandlers() {
  ipcMain.handle('ableton:select-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Ableton Project Folder',
      buttonLabel: 'Select Folder',
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }

    const folderPath = result.filePaths[0];
    const snapshot = await scanAbletonFolder(folderPath);
    return { canceled: false, folderPath, snapshot };
  });

  ipcMain.handle('ableton:sync-to-cloud', async (_e, snapshot: DawSnapshot, authToken: string) => {
    if (!authToken) return { error: 'Not authenticated with Wavi' };

    try {
      const resp = await fetch('https://wavi.stream/api/daw-snapshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ snapshot }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        return { error: `Sync failed: ${resp.status} ${body}` };
      }

      const result = await resp.json();
      return { success: true, cloudProjectId: result.projectId };
    } catch (err: any) {
      return { error: err.message };
    }
  });
}

async function scanAbletonFolder(folderPath: string): Promise<DawSnapshot> {
  const detectedFiles: DetectedFile[] = [];

  function scanDir(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden dirs and Ableton backup folders to keep scan fast
        if (!entry.name.startsWith('.') && entry.name !== 'Backup') {
          scanDir(fullPath);
        }
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (DAW_EXTENSIONS.has(ext)) {
          let stat: fs.Stats;
          try {
            stat = fs.statSync(fullPath);
          } catch {
            continue;
          }
          detectedFiles.push({
            path: fullPath,
            name: entry.name,
            type: ext.slice(1) as DetectedFile['type'],
            role: getFileRole(ext),
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        }
      }
    }
  }

  scanDir(folderPath);

  return {
    id: crypto.randomUUID(),
    source: 'ableton',
    sessionName: path.basename(folderPath),
    bpm: 120,
    key: 'C',
    detectedFiles,
    metadata: {
      detectedAt: new Date().toISOString(),
      folderPath,
      projectType: 'song',
    },
    syncStatus: 'pending',
  };
}

function getFileRole(ext: string): DetectedFile['role'] {
  switch (ext) {
    case '.als': return 'project';
    case '.alc': return 'clip';
    case '.adg': return 'preset';
    case '.wav':
    case '.aiff':
    case '.mp3': return 'audio';
    case '.mid': return 'midi';
    case '.json': return 'analysis';
    default: return 'audio';
  }
}
