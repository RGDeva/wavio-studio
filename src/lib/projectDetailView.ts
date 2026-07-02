/**
 * Pure presentation logic for Project Detail — kept out of the component so
 * it is unit-testable under node vitest (no renderer test environment).
 */

export interface DetailFile {
  id: string;
  file_name: string;
  file_path: string;
  file_type?: string;
  file_size: number;
  sync_status: string;
  cloud_asset_id?: string | null;
  cloud_url?: string | null;
  checksum?: string | null;
  classifier_role?: string | null;
  role?: string | null;
  modified_at?: string | null;
  local_status?: string | null;
}

export const ROLE_ORDER = ['project', 'audio', 'stem', 'sample', 'midi', 'artwork', 'document', 'archive', 'missing', 'other'];

export const ROLE_LABELS: Record<string, string> = {
  project: 'DAW Project Files',
  audio: 'Audio',
  stem: 'Stems',
  sample: 'Samples',
  midi: 'MIDI',
  artwork: 'Artwork',
  document: 'Documents',
  archive: 'Archives',
  missing: 'Missing Files',
  other: 'Other Files',
};

const PROJECT_EXTS = ['.als', '.ptx', '.flp', '.logic', '.logicx', '.nproject', '.cpr', '.rpp'];
const AUDIO_EXTS = ['.wav', '.mp3', '.aiff', '.aif', '.flac', '.m4a', '.ogg', '.aac'];

export function deriveRole(file: DetailFile): string {
  const ext = '.' + (file.file_name.split('.').pop()?.toLowerCase() ?? '');
  if (file.local_status === 'missing') return 'missing';
  if (PROJECT_EXTS.includes(ext)) return 'project';
  const cr = file.classifier_role ?? file.role ?? 'misc';
  if (cr === 'stem') return 'stem';
  if (cr === 'sample') return 'sample';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  if (ext === '.mid' || ext === '.midi') return 'midi';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'artwork';
  if (['.pdf', '.txt', '.md', '.docx', '.rtf'].includes(ext)) return 'document';
  if (['.zip', '.rar', '.tar', '.gz'].includes(ext)) return 'archive';
  return 'other';
}

export function groupFilesByRole(files: DetailFile[]): Array<{ role: string; files: DetailFile[] }> {
  const groups: Record<string, DetailFile[]> = {};
  for (const f of files) {
    const role = deriveRole(f);
    (groups[role] ??= []).push(f);
  }
  return ROLE_ORDER.filter((r) => groups[r]?.length).map((r) => ({ role: r, files: groups[r] }));
}

/**
 * Picks the best playable bounce for the hero player: prefer explicit
 * master/mix/bounce roles, then any present audio file; newest wins within a
 * tier. Missing-on-disk files are never playable.
 */
export function pickLatestBounce(files: DetailFile[]): DetailFile | null {
  const present = files.filter(
    (f) => f.local_status !== 'missing' && AUDIO_EXTS.includes('.' + (f.file_name.split('.').pop()?.toLowerCase() ?? '')),
  );
  if (present.length === 0) return null;
  const tier = (f: DetailFile) => {
    const r = f.classifier_role ?? f.role ?? '';
    if (r === 'master' || r === 'mix' || r === 'bounce') return 0;
    if (r === 'stem') return 2; // stems are the least representative single file
    return 1;
  };
  return [...present].sort((a, b) => {
    const t = tier(a) - tier(b);
    if (t !== 0) return t;
    return new Date(b.modified_at ?? 0).getTime() - new Date(a.modified_at ?? 0).getTime();
  })[0];
}

/** Options for a new Listen Link, converted from the UI's expiry choices. */
export function expiryToIso(choice: 'never' | '24h' | '7d' | '30d', now: Date = new Date()): string | undefined {
  if (choice === 'never') return undefined;
  const ms = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 }[choice];
  return new Date(now.getTime() + ms).toISOString();
}

/** Best shareable synced audio asset for a Listen Link (mirrors Dashboard's legacy picker). */
export function pickShareAsset(files: DetailFile[]): DetailFile | null {
  const synced = files.filter((f) => f.sync_status === 'synced' && (f.cloud_url || f.cloud_asset_id));
  return (
    synced.find((f) => f.role === 'master' || f.role === 'mix') ??
    synced.find((f) => ['wav', 'mp3', 'flac', 'aiff', 'aif'].includes(f.file_type ?? '')) ??
    synced[0] ??
    null
  );
}
