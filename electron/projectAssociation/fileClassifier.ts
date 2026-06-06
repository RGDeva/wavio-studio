/**
 * File Classifier — Project Association Engine Phase 1
 *
 * Classifies a file into one of the canonical music-production roles using:
 *   1. File extension
 *   2. Filename patterns
 *   3. Parent folder name (path context)
 *
 * No audio fingerprinting, no I/O beyond the path string and fs.Stats.
 * Never moves, renames, or deletes files.
 */

import path from 'path';
import type { Stats } from 'fs';
import { parseFileName, type RoleSignal } from './namingParser';

// ── Role types ──────────────────────────────────────────────────────────────

export type ClassifierRole =
  | 'daw_project'
  | 'bounce'
  | 'master'
  | 'stem'
  | 'vocal_take'
  | 'midi'
  | 'reference'
  | 'artwork'
  | 'lyrics'
  | 'plugin_preset'
  | 'sample'
  | 'beat'
  | 'misc';

export interface FileClassification {
  role: ClassifierRole;
  /** 0.0–1.0 confidence in the assigned role */
  confidence: number;
  /** The individual signals that contributed to this classification */
  signals: ClassificationSignals;
  /** Parsed naming tokens */
  tokens: ReturnType<typeof parseFileName>;
}

export interface ClassificationSignals {
  byExtension: ClassifierRole | null;
  byFolderName: ClassifierRole | null;
  byNamePattern: RoleSignal | null;
  isFinalFlag: boolean;
  isInStemsFolder: boolean;
  isInExportFolder: boolean;
  isInVocalsFolder: boolean;
  isInMidiFolder: boolean;
  isInArtworkFolder: boolean;
  isInLyricsFolder: boolean;
  isInReferencesFolder: boolean;
  isInPresetsFolder: boolean;
}

// ── Extension maps ───────────────────────────────────────────────────────────

const DAW_EXTENSIONS = new Set([
  '.flp', '.als', '.logic', '.logicx', '.rpp', '.ptx', '.ptf',
  '.cpr', '.band', '.sesx', '.song', '.reason', '.bwproject', '.npr',
]);

const AUDIO_EXTENSIONS = new Set([
  '.wav', '.aiff', '.aif', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus',
]);

const MIDI_EXTENSIONS = new Set(['.mid', '.midi', '.smf']);

const ARTWORK_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.psd', '.ai', '.svg',
]);

const LYRICS_EXTENSIONS = new Set([
  '.txt', '.doc', '.docx', '.pages', '.rtf', '.md', '.pdf',
]);

const PRESET_EXTENSIONS = new Set([
  '.fxp', '.fxb', '.nki', '.nkm', '.nkx', '.nkc', '.aupreset', '.vstpreset',
  '.xln', '.pchk', '.trkpreset', '.logicx',
]);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.m4v']);

// ── Folder name sets ─────────────────────────────────────────────────────────

const STEMS_FOLDERS    = new Set(['stems', 'stem', 'multitrack', 'multitracks', 'tracks', 'parts', 'elements', 'bounced stems', 'exported stems']);
const EXPORT_FOLDERS   = new Set(['exports', 'export', 'bounces', 'bounce', 'renders', 'render', 'mixdowns', 'mixdown', 'audio']);
const MASTERS_FOLDERS  = new Set(['masters', 'master', 'mastered', 'mastering', 'distribution', 'dist', 'release']);
const VOCALS_FOLDERS   = new Set(['vocals', 'vocal', 'vox', 'voice', 'takes', 'comps', 'adlibs', 'background vocals', 'bgv', 'harmonies']);
const MIDI_FOLDERS     = new Set(['midi', 'mid', 'patterns', 'sequences', 'piano rolls']);
const ARTWORK_FOLDERS  = new Set(['artwork', 'art', 'cover', 'covers', 'artwork', 'assets', 'graphics', 'images', 'photos']);
const LYRICS_FOLDERS   = new Set(['lyrics', 'lyric', 'words', 'notes', 'docs', 'documents', 'text', 'writing']);
const REFERENCE_FOLDERS = new Set(['reference', 'references', 'ref', 'inspo', 'inspiration', 'comps', 'benchmarks']);
const PRESETS_FOLDERS  = new Set(['presets', 'preset', 'patches', 'banks', 'plugins', 'fx', 'sounds']);
const SAMPLES_FOLDERS  = new Set(['samples', 'sample', 'loops', 'loop', 'one-shots', 'oneshots', 'drums', 'beats', 'instruments']);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns folder-name segments of the path (from the filename up to depth 4).
 * We look at these folder names to give path-context signals.
 */
function parentFolderNames(filePath: string, depth = 4): string[] {
  const parts: string[] = [];
  let current = path.dirname(filePath);
  for (let i = 0; i < depth; i++) {
    const base = path.basename(current).toLowerCase();
    if (!base || base === '.' || base === '/') break;
    parts.push(base);
    current = path.dirname(current);
  }
  return parts;
}

function folderHit(folders: string[], targetSet: Set<string>): boolean {
  return folders.some(f => targetSet.has(f));
}

/** Map folder context → role */
function roleFromFolder(folders: string[]): ClassifierRole | null {
  if (folderHit(folders, STEMS_FOLDERS))    return 'stem';
  if (folderHit(folders, MASTERS_FOLDERS))  return 'master';
  if (folderHit(folders, VOCALS_FOLDERS))   return 'vocal_take';
  if (folderHit(folders, MIDI_FOLDERS))     return 'midi';
  if (folderHit(folders, ARTWORK_FOLDERS))  return 'artwork';
  if (folderHit(folders, LYRICS_FOLDERS))   return 'lyrics';
  if (folderHit(folders, REFERENCE_FOLDERS))return 'reference';
  if (folderHit(folders, PRESETS_FOLDERS))  return 'plugin_preset';
  if (folderHit(folders, SAMPLES_FOLDERS))  return 'sample';
  if (folderHit(folders, EXPORT_FOLDERS))   return 'bounce';
  return null;
}

/** Map extension → role (high confidence) */
function roleFromExtension(ext: string): ClassifierRole | null {
  if (DAW_EXTENSIONS.has(ext))    return 'daw_project';
  if (MIDI_EXTENSIONS.has(ext))   return 'midi';
  if (ARTWORK_EXTENSIONS.has(ext))return 'artwork';
  if (PRESET_EXTENSIONS.has(ext)) return 'plugin_preset';
  if (LYRICS_EXTENSIONS.has(ext)) return 'lyrics';
  if (VIDEO_EXTENSIONS.has(ext))  return 'misc';
  return null;  // audio/unknown — need more signals
}

/** Map naming parser RoleSignal → ClassifierRole */
function roleSignalToClassifierRole(s: RoleSignal): ClassifierRole {
  const map: Record<RoleSignal, ClassifierRole> = {
    daw_project: 'daw_project',
    bounce: 'bounce',
    master: 'master',
    stem: 'stem',
    vocal_take: 'vocal_take',
    midi: 'midi',
    reference: 'reference',
    artwork: 'artwork',
    lyrics: 'lyrics',
    plugin_preset: 'plugin_preset',
    mix: 'bounce',
    sample: 'sample',
    beat: 'beat',
  };
  return map[s];
}

// ── Confidence scoring ───────────────────────────────────────────────────────
//
// Agreement between signals increases confidence:
//   extension alone (DAW/MIDI/artwork/preset) → 0.95
//   name + folder agree → 0.90
//   name + final flag agree → 0.85
//   name only → 0.70
//   folder only → 0.60
//   fallback → 0.40

function scoreConfidence(
  extRole: ClassifierRole | null,
  folderRole: ClassifierRole | null,
  nameRole: ClassifierRole | null,
  finalFlag: boolean,
  assignedRole: ClassifierRole,
): number {
  // Extension is deterministic for DAW/MIDI/artwork/preset
  if (extRole !== null && extRole === assignedRole && extRole !== 'bounce' && extRole !== 'misc') {
    return 0.95;
  }

  const agreeing = [extRole, folderRole, nameRole].filter(r => r === assignedRole).length;

  if (agreeing >= 3) return 0.95;
  if (agreeing === 2) return finalFlag ? 0.90 : 0.85;
  if (agreeing === 1 && finalFlag && assignedRole === 'master') return 0.85;
  if (agreeing === 1) return folderRole === assignedRole ? 0.65 : 0.72;

  // isFinal alone is a strong enough signal to warrant meaningful confidence
  if (finalFlag && assignedRole === 'master') return 0.82;

  return 0.40;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify a single file by extension, name, and path context.
 *
 * @param filePath  Absolute path to the file
 * @param stat      fs.Stats for the file (caller owns the stat call — no I/O here)
 */
export function classifyFile(filePath: string, stat: Stats): FileClassification {
  const fileName = path.basename(filePath);
  const ext      = path.extname(fileName).toLowerCase();
  const folders  = parentFolderNames(filePath);
  const tokens   = parseFileName(fileName);

  // ── Signal 1: Extension ──
  const extRole = roleFromExtension(ext);

  // ── Signal 2: Folder context ──
  const folderRole = roleFromFolder(folders);
  const isInStemsFolder     = folderHit(folders, STEMS_FOLDERS);
  const isInExportFolder    = folderHit(folders, EXPORT_FOLDERS);
  const isInVocalsFolder    = folderHit(folders, VOCALS_FOLDERS);
  const isInMidiFolder      = folderHit(folders, MIDI_FOLDERS);
  const isInArtworkFolder   = folderHit(folders, ARTWORK_FOLDERS);
  const isInLyricsFolder    = folderHit(folders, LYRICS_FOLDERS);
  const isInReferencesFolder = folderHit(folders, REFERENCE_FOLDERS);
  const isInPresetsFolder   = folderHit(folders, PRESETS_FOLDERS);

  // ── Signal 3: Name pattern ──
  const nameRole = tokens.roleSignal
    ? roleSignalToClassifierRole(tokens.roleSignal)
    : null;

  const signals: ClassificationSignals = {
    byExtension:          extRole,
    byFolderName:         folderRole,
    byNamePattern:        tokens.roleSignal,
    isFinalFlag:          tokens.isFinal,
    isInStemsFolder,
    isInExportFolder,
    isInVocalsFolder,
    isInMidiFolder,
    isInArtworkFolder,
    isInLyricsFolder,
    isInReferencesFolder,
    isInPresetsFolder,
  };

  // ── Role resolution: extension wins for unambiguous types ──
  let role: ClassifierRole;

  if (extRole === 'daw_project' || extRole === 'midi' || extRole === 'plugin_preset') {
    role = extRole;
  } else if (extRole === 'artwork') {
    // Artwork extension in artwork folder → high confidence artwork
    role = 'artwork';
  } else if (extRole === 'lyrics') {
    // Text files: name pattern or lyrics folder overrides
    role = (folderRole === 'lyrics' || nameRole === 'lyrics') ? 'lyrics' : 'lyrics';
  } else if (AUDIO_EXTENSIONS.has(ext)) {
    // Audio files: use priority order — name > folder > misc.
    //
    // Master promotion rules (checked first):
    //   1. nameRole is explicitly 'master'
    //   2. isFinal with no conflicting name signal that should override (stem/vocal/reference/sample)
    //   3. isFinal inside an export/bounce folder — always master regardless of beat/mix name
    const blocksMaster = new Set<typeof nameRole>(['stem', 'vocal_take', 'reference', 'sample', 'midi']);
    const isFinalMaster = tokens.isFinal && !blocksMaster.has(nameRole);

    if (nameRole === 'master' || isFinalMaster) {
      role = 'master';
    } else if (nameRole === 'vocal_take' || isInVocalsFolder) {
      role = 'vocal_take';
    } else if (nameRole === 'stem' || isInStemsFolder) {
      role = 'stem';
    } else if (nameRole === 'reference' || isInReferencesFolder) {
      role = 'reference';
    } else if (nameRole === 'sample' || folderRole === 'sample') {
      role = 'sample';
    } else if (nameRole === 'beat') {
      role = 'beat';
    } else if (nameRole === 'bounce' || isInExportFolder) {
      role = 'bounce';
    } else {
      // No strong signal — still an audio file, classify as bounce (most common standalone audio)
      role = 'bounce';
    }
  } else {
    role = extRole ?? folderRole ?? nameRole ?? 'misc';
  }

  // Artwork extension always wins for image files
  if (ARTWORK_EXTENSIONS.has(ext)) role = 'artwork';

  const confidence = scoreConfidence(extRole, folderRole, nameRole, tokens.isFinal, role);

  return { role, confidence, signals, tokens };
}
