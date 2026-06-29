import { ipcMain, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';

interface DetectedFile {
  path: string;
  name: string;
  type: string;
  role: 'project' | 'clip' | 'preset' | 'audio' | 'midi' | 'analysis';
  size: number;
  modifiedAt: string;
  metadata?: { bpm?: number; key?: string; duration?: number; sampleRate?: number };
}

interface DawSnapshot {
  id: string;
  source: 'ableton' | 'fl-studio' | 'logic' | 'pro-tools';
  sessionName: string;
  bpm: number;
  key: string;
  detectedFiles: DetectedFile[];
  metadata: { detectedAt: string; folderPath: string; projectType: string };
  syncStatus: 'pending' | 'syncing' | 'synced' | 'error';
  cloudProjectId?: string;
}

// Project file extensions per DAW
const ABLETON_EXTS  = new Set(['.als', '.alc', '.adg']);
const FL_EXTS       = new Set(['.flp']);
const LOGIC_EXTS    = new Set(['.logicx']);
const PT_EXTS       = new Set(['.ptf', '.ptx']);
const AUDIO_EXTS    = new Set(['.wav', '.aiff', '.mp3', '.flac', '.m4a', '.ogg', '.aac']);
const MIDI_EXTS     = new Set(['.mid', '.midi']);
const ANALYSIS_EXTS = new Set(['.json', '.asd']);

const ALL_EXTS = new Set([
  ...ABLETON_EXTS, ...FL_EXTS, ...LOGIC_EXTS, ...PT_EXTS,
  ...AUDIO_EXTS, ...MIDI_EXTS, ...ANALYSIS_EXTS,
]);

let _registered = false;

export function registerAbletonHandlers() {
  if (_registered) return;
  _registered = true;
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
  const SKIP_DIRS = new Set(['.', 'Backup', 'node_modules', '__MACOSX']);

  function scanDir(dir: string, depth = 0) {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // .logicx is a package (directory) — treat as single project file
        if (entry.name.endsWith('.logicx')) {
          let stat: fs.Stats;
          try { stat = fs.statSync(fullPath); } catch { continue; }
          detectedFiles.push({ path: fullPath, name: entry.name, type: 'logicx', role: 'project', size: stat.size, modifiedAt: stat.mtime.toISOString() });
        } else {
          scanDir(fullPath, depth + 1);
        }
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALL_EXTS.has(ext)) continue;
        let stat: fs.Stats;
        try { stat = fs.statSync(fullPath); } catch { continue; }
        detectedFiles.push({
          path: fullPath,
          name: entry.name,
          type: ext.slice(1),
          role: getFileRole(ext),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    }
  }

  scanDir(folderPath);

  // Detect DAW source from what project files were found
  const source = detectDawSource(detectedFiles);

  // Find main project file for naming
  const projectFile = detectedFiles.find(f => f.role === 'project');
  const sessionName = projectFile
    ? path.basename(projectFile.name, path.extname(projectFile.name))
    : path.basename(folderPath);

  // Try to parse real BPM from Ableton .als (gzipped XML)
  let bpm = 0;
  let key = '';
  if (source === 'ableton' && projectFile?.path.endsWith('.als')) {
    const parsed = await parseAbletonLiveSet(projectFile.path);
    bpm = parsed.bpm;
    key = parsed.key;
  }

  return {
    id: crypto.randomUUID(),
    source,
    sessionName,
    bpm,
    key,
    detectedFiles,
    metadata: {
      detectedAt: new Date().toISOString(),
      folderPath,
      projectType: 'song',
    },
    syncStatus: 'pending',
  };
}

function detectDawSource(files: DetectedFile[]): DawSnapshot['source'] {
  for (const f of files) {
    const ext = '.' + f.type;
    if (ABLETON_EXTS.has(ext)) return 'ableton';
    if (FL_EXTS.has(ext)) return 'fl-studio';
    if (LOGIC_EXTS.has(ext)) return 'logic';
    if (PT_EXTS.has(ext)) return 'pro-tools';
  }
  return 'ableton'; // default
}

async function parseAbletonLiveSet(alsPath: string): Promise<{ bpm: number; key: string }> {
  try {
    const zlib = await import('zlib');
    const raw = fs.readFileSync(alsPath);
    const xml: Buffer = await new Promise((resolve, reject) => {
      zlib.gunzip(raw, (err, result) => err ? reject(err) : resolve(result));
    });
    const xmlStr = xml.toString('utf8', 0, Math.min(xml.length, 16384)); // read first 16KB only

    // BPM: <Tempo><LomId Value="0" /><Manual Value="140" />
    const bpmMatch = xmlStr.match(/<Tempo>[^<]*(?:<[^>]+>\s*)*<Manual\s+Value="([\d.]+)"/);
    const bpm = bpmMatch ? Math.round(parseFloat(bpmMatch[1])) : 0;

    // Key: <KeySignature>...<Tonic Value="5" />  (0=C,1=Db,...,11=B)
    const tonicMatch = xmlStr.match(/<Tonic\s+Value="(\d+)"/);
    const NOTE_NAMES = ['C','Db','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
    const key = tonicMatch ? (NOTE_NAMES[parseInt(tonicMatch[1])] ?? '') : '';

    return { bpm, key };
  } catch {
    return { bpm: 0, key: '' };
  }
}

function getFileRole(ext: string): DetectedFile['role'] {
  if (ABLETON_EXTS.has(ext)) {
    if (ext === '.als') return 'project';
    if (ext === '.alc') return 'clip';
    if (ext === '.adg') return 'preset';
  }
  if (FL_EXTS.has(ext) || LOGIC_EXTS.has(ext) || PT_EXTS.has(ext)) return 'project';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (MIDI_EXTS.has(ext)) return 'midi';
  if (ANALYSIS_EXTS.has(ext)) return 'analysis';
  return 'audio';
}
