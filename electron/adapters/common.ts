import * as path from 'path';
import type { ManifestEntry } from './types';

/**
 * Shared, DAW-agnostic pieces of the adapter contract. Moved verbatim from
 * electron/main.ts (Phase F extraction) — behavior-preserving.
 */

// Files/directories never included in a published Project Pack.
export const PUBLISH_EXCLUDE = [
  /\.DS_Store$/i, /Thumbs\.db$/i, /desktop\.ini$/i,
  /\._[^/]+$/, /\.lck$/i, /\.lock$/i, /~\$/,
  /Ableton Temp Files/i, /^Backups$/i,
  /\.db$/, /\.log$/, /node_modules/,
];

export function safeRelativePath(absoluteFile: string, projectRoot: string): string | null {
  const rel = absoluteFile.startsWith(projectRoot)
    ? absoluteFile.slice(projectRoot.length).replace(/^[/\\]/, '')
    : null;
  if (!rel) return null;
  const parts = rel.split(/[/\\]/);
  if (parts.some(p => PUBLISH_EXCLUDE.some(rx => rx.test(p)))) return null;
  return rel;
}

export function classifyFileRole(fileName: string, classifierRole: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (['.als', '.ptx', '.flp', '.logic', '.logicx', '.nproject', '.cpr', '.rpp'].includes(ext)) return 'project';
  if (classifierRole === 'stem') return 'stem';
  if (classifierRole === 'sample') return 'sample';
  if (ext === '.asd') return 'analysis';
  if (['.wav', '.mp3', '.aiff', '.aif', '.flac', '.m4a', '.ogg', '.aac'].includes(ext)) return 'audio';
  if (ext === '.mid' || ext === '.midi') return 'midi';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'artwork';
  if (['.pdf', '.txt', '.md', '.docx', '.rtf'].includes(ext)) return 'document';
  if (['.zip', '.rar', '.tar', '.gz'].includes(ext)) return 'archive';
  return 'other';
}

// Convention for a dedicated preview bounce: a full-arrangement render placed
// at the project root (never inside Samples/ or a stems folder), named
// preview.<ext> or bounce.<ext>.
export const PREVIEW_FILENAME_RE = /^(preview|bounce)\.(wav|mp3|aiff|aif|flac|m4a)$/i;

export function findPreviewCandidate(syncedFiles: Array<{ file_path: string }>, projectRoot: string): any | null {
  for (const f of syncedFiles) {
    if (path.dirname(f.file_path) !== projectRoot) continue;
    if (PREVIEW_FILENAME_RE.test(path.basename(f.file_path))) return f;
  }
  return null;
}

export type { ManifestEntry };
