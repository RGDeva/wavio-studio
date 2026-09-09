import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import type { DawAdapter, ManifestEntry } from './types';
import { safeRelativePath, classifyFileRole, findPreviewCandidate, locateProjectFile } from './common';

/**
 * Ableton Live adapter — Phase F extraction. All logic moved verbatim from
 * electron/ableton.ts (scan/detect/parse) and electron/main.ts
 * (getAbletonManifestExtras). Behavior-preserving; no Electron imports so
 * vitest can exercise it directly.
 */

// ── Folder scan (moved from electron/ableton.ts) ─────────────────────────────

export interface DetectedFile {
  path: string;
  name: string;
  type: string;
  role: 'project' | 'clip' | 'preset' | 'audio' | 'midi' | 'analysis';
  size: number;
  modifiedAt: string;
  metadata?: { bpm?: number; key?: string; duration?: number; sampleRate?: number };
}

export interface DawSnapshot {
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

export function getFileRole(ext: string): DetectedFile['role'] {
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

export function detectDawSource(files: DetectedFile[]): DawSnapshot['source'] {
  for (const f of files) {
    const ext = '.' + f.type;
    if (ABLETON_EXTS.has(ext)) return 'ableton';
    if (FL_EXTS.has(ext)) return 'fl-studio';
    if (LOGIC_EXTS.has(ext)) return 'logic';
    if (PT_EXTS.has(ext)) return 'pro-tools';
  }
  return 'ableton'; // default
}

export async function scanAbletonFolder(folderPath: string): Promise<DawSnapshot> {
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

  const source = detectDawSource(detectedFiles);
  const projectFile = detectedFiles.find(f => f.role === 'project');
  const sessionName = projectFile
    ? path.basename(projectFile.name, path.extname(projectFile.name))
    : path.basename(folderPath);

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
    metadata: { detectedAt: new Date().toISOString(), folderPath, projectType: 'song' },
    syncStatus: 'pending',
  };
}

// ── .als parsing (moved from electron/ableton.ts) ────────────────────────────

export async function parseAbletonLiveSet(alsPath: string): Promise<{ bpm: number; key: string }> {
  try {
    const zlib = await import('zlib');
    const raw = fs.readFileSync(alsPath);
    const xml: Buffer = await new Promise((resolve, reject) => {
      zlib.gunzip(raw, (err, result) => err ? reject(err) : resolve(result));
    });
    const xmlStr = xml.toString('utf8');

    // BPM lives in MasterTrack, near the END of a real Live set: measured at byte
    // 293,923 of 334,317 and 154,040 of 194,360 in two real Live 12 projects. The
    // previous 16KB read window could never reach it, so every genuine .als parsed
    // as bpm 0 while a small synthetic fixture passed.
    //
    // Scope the search to the <Tempo>…</Tempo> element rather than scanning loosely:
    // an unanchored /<Tempo>(?:<[^>]+>\s*)*<Manual Value="…"/ matches any tag, so it
    // runs to EOF and backtracks to the LAST <Manual> in the document (yielding 1,
    // an unrelated device value) instead of the tempo's own.
    const tempoBlock = xmlStr.match(/<Tempo>([\s\S]*?)<\/Tempo>/);
    const bpmMatch = tempoBlock ? tempoBlock[1].match(/<Manual\s+Value="([\d.]+)"/) : null;
    const parsedBpm = bpmMatch ? parseFloat(bpmMatch[1]) : NaN;
    const bpm = Number.isFinite(parsedBpm) ? Math.round(parsedBpm) : 0;

    // Key: <KeySignature>…<Tonic Value="5" />  (0=C,1=Db,…,11=B). Live 12 sets do not
    // emit KeySignature at all (0 occurrences in both real projects), so '' is the
    // honest answer there. Confining the lookup to a KeySignature element keeps a bare
    // <Tonic> belonging to a device preset from being reported as the project key.
    const keyBlock = xmlStr.match(/<KeySignature>([\s\S]*?)<\/KeySignature>/);
    const tonicMatch = keyBlock ? keyBlock[1].match(/<Tonic\s+Value="(\d+)"/) : null;
    const NOTE_NAMES = ['C','Db','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
    const key = tonicMatch ? (NOTE_NAMES[parseInt(tonicMatch[1])] ?? '') : '';

    return { bpm, key };
  } catch {
    return { bpm: 0, key: '' };
  }
}

// ── Manifest extras (moved from electron/main.ts getAbletonManifestExtras) ──

/**
 * Ableton Live projects need an `Ableton Project Info/` directory next to the
 * .als file for Ableton to recognize the extracted folder as a real Project
 * (required for RelativePathType="3" sample references to auto-resolve) —
 * otherwise Ableton treats it as a "Temp Project" and reports missing media
 * even when the referenced sample is present at the correct relative path.
 * Normal file-walk logic skips empty directories, so this directory is
 * special-cased into the manifest even when it has no contents.
 */
export function abletonManifestExtras(projectFilePath: string, projectRoot: string): ManifestEntry[] {
  const extras: ManifestEntry[] = [];
  const infoDirAbs = path.join(projectRoot, 'Ableton Project Info');
  if (fs.existsSync(infoDirAbs) && fs.statSync(infoDirAbs).isDirectory()) {
    extras.push({
      relativePath: 'Ableton Project Info/',
      fileName: 'Ableton Project Info',
      fileSize: 0,
      sha256: null,
      role: 'directory',
      mimeType: null,
      assetId: null,
    });
  }
  return extras;
}

// ── Adapter object ───────────────────────────────────────────────────────────

export const abletonAdapter: DawAdapter = {
  id: 'ableton',
  displayName: 'Ableton Live',
  projectExtensions: ['.als'],
  isProjectFile: (filePath) => filePath.toLowerCase().endsWith('.als'),
  classifyFileRole,
  safeRelativePath,
  manifestExtras: abletonManifestExtras,
  findPreviewCandidate,
  extractMetadata: parseAbletonLiveSet,
  // Ableton is the reference DAW: native detect, package (with the Project Info
  // marker), restore, and same-DAW open all work today. Cross-DAW / plugin scan
  // / fidelity reporting are not implemented yet — reported honestly as false.
  capabilities: () => ({
    detect: true, packageNative: true, restore: true, sameDawOpen: true,
    crossDawReconstruct: false, scanPlugins: false, fidelityReport: false,
  }),
  locateProjectFile,
};
