/**
 * Project Association Engine — Phase 2
 *
 * Groups recently classified files into likely project clusters and writes
 * pending suggestions to association_queue. Never moves, renames, or deletes
 * any files on disk. All associations are metadata-only and user-confirmed.
 *
 * Signals used (lightweight only — no audio fingerprinting):
 *   1. Same immediate folder
 *   2. Parent/child folder relationship
 *   3. Shared filename tokens (songHint / artistHint from namingParser)
 *   4. Shared token overlap from rawTokens
 *   5. Close modified timestamps (within TIMESTAMP_WINDOW_MS)
 *   6. File roles: DAW project near bounces/stems elevates confidence
 *   7. Export folder belongs to parent folder DAW project
 */

import crypto from 'crypto';
import path from 'path';
import { parseFileName } from './namingParser';

/** Minimal structural interface covering the subset of better-sqlite3 used here. */
export interface DbLike {
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
}

export type AssociationRelationship =
  | 'same_project'
  | 'stem_of'
  | 'version_of'
  | 'exported_from'
  | 'duplicate_of'
  | 'reference_for';

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_GROUP_SIZE       = 2;     // need at least 2 files to form a group
const MAX_QUEUE_PER_RUN    = 10;    // cap queue insertions per engine run
const TIMESTAMP_WINDOW_MS  = 4 * 60 * 60 * 1000;  // 4 hours
const TOKEN_OVERLAP_MIN    = 1;     // minimum shared meaningful tokens
const MIN_CONFIDENCE       = 0.45;  // groups below this are discarded
const AUTO_CONFIRM_THRESHOLD = 0.92; // only auto-confirm near-certain groups

// Roles that strongly imply belonging to a song project
const SONG_ROLES = new Set([
  'daw_project', 'bounce', 'master', 'stem', 'vocal_take',
  'midi', 'sample', 'beat',
]);

// Stop-words excluded from token comparison
const TOKEN_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to',
  'for', 'v', 'v1', 'v2', 'v3', 'final', 'bounce', 'mix', 'master',
  'stem', 'wav', 'mp3', 'flp', 'als', 'mid', 'new', 'old', 'test',
]);

// ── DB row shapes ─────────────────────────────────────────────────────────────

interface FileRow {
  id: string;
  file_path: string;
  file_name: string;
  file_type: string;
  file_size: number;
  classifier_role: string | null;
  classifier_confidence: number | null;
  name_tokens: string | null;   // JSON-encoded NameTokens
  classification_version: number | null;
  modified_at: string;
  project_id: string | null;
}

// ── Parsed token cache ────────────────────────────────────────────────────────

interface ParsedTokens {
  songHint: string | null;
  artistHint: string | null;
  rawTokens: string[];
  meaningful: Set<string>;   // rawTokens minus stopwords
}

function parseTokens(file: FileRow): ParsedTokens {
  if (file.name_tokens) {
    try {
      const t = JSON.parse(file.name_tokens) as {
        songHint?: string | null;
        artistHint?: string | null;
        rawTokens?: string[];
      };
      const raw = (t.rawTokens ?? []).map(s => s.toLowerCase());
      return {
        songHint:   t.songHint ?? null,
        artistHint: t.artistHint ?? null,
        rawTokens:  raw,
        meaningful: new Set(raw.filter(w => w.length > 2 && !TOKEN_STOPWORDS.has(w))),
      };
    } catch { /* fall through to live parse */ }
  }
  const t = parseFileName(file.file_name);
  const raw = (t.rawTokens ?? []).map(s => s.toLowerCase());
  return {
    songHint:   t.songHint,
    artistHint: t.artistHint,
    rawTokens:  raw,
    meaningful: new Set(raw.filter(w => w.length > 2 && !TOKEN_STOPWORDS.has(w))),
  };
}

// ── Signal scoring ────────────────────────────────────────────────────────────

export interface GroupSignals {
  sameFolder:        boolean;
  parentChildFolder: boolean;
  sharedHint:        string | null;  // the shared artistHint or songHint
  tokenOverlap:      number;         // count of shared meaningful tokens
  timestampProximity: boolean;       // all files within TIMESTAMP_WINDOW_MS
  hasDawProject:     boolean;
  hasExportFile:     boolean;        // bounce/master/stem in group
  exportUnderProject: boolean;       // export folder is child of DAW project folder
  fileCount:         number;
}

function scoreGroup(signals: GroupSignals): number {
  let score = 0;

  if (signals.sameFolder)           score += 0.35;
  if (signals.parentChildFolder)    score += 0.20;
  if (signals.sharedHint)           score += 0.20;
  if (signals.tokenOverlap >= 2)    score += 0.15;
  else if (signals.tokenOverlap === 1) score += 0.08;
  if (signals.timestampProximity)   score += 0.10;
  if (signals.hasDawProject && signals.hasExportFile) score += 0.20;
  if (signals.exportUnderProject)   score += 0.25;

  return Math.min(score, 0.99);
}

// ── Grouping helpers ──────────────────────────────────────────────────────────

function immediateFolder(filePath: string): string {
  return path.dirname(filePath);
}

function isParentChild(folderA: string, folderB: string): boolean {
  const a = folderA.endsWith(path.sep) ? folderA : folderA + path.sep;
  const b = folderB.endsWith(path.sep) ? folderB : folderB + path.sep;
  return b.startsWith(a) || a.startsWith(b);
}

function tokenOverlap(a: ParsedTokens, b: ParsedTokens): number {
  let count = 0;
  for (const t of a.meaningful) {
    if (b.meaningful.has(t)) count++;
  }
  return count;
}

function sharedHint(a: ParsedTokens, b: ParsedTokens): string | null {
  if (a.artistHint && b.artistHint &&
      a.artistHint.toLowerCase() === b.artistHint.toLowerCase()) {
    return a.artistHint;
  }
  if (a.songHint && b.songHint) {
    const aw = a.songHint.toLowerCase().split(/\s+/);
    const bw = new Set(b.songHint.toLowerCase().split(/\s+/));
    const shared = aw.filter(w => w.length > 2 && bw.has(w) && !TOKEN_STOPWORDS.has(w));
    if (shared.length > 0) return shared[0];
  }
  return null;
}

function timestampWindow(files: FileRow[]): boolean {
  const times = files.map(f => new Date(f.modified_at).getTime()).filter(t => !isNaN(t));
  if (times.length < 2) return true;
  return Math.max(...times) - Math.min(...times) <= TIMESTAMP_WINDOW_MS;
}

/** Derive a suggested project name for a group of files. */
function suggestProjectName(files: FileRow[], tokens: ParsedTokens[]): string {
  // Prefer the DAW project's base name
  const dawFile = files.find(f => f.classifier_role === 'daw_project');
  if (dawFile) {
    return path.basename(dawFile.file_name, path.extname(dawFile.file_name));
  }
  // Try shared artistHint + songHint
  for (const t of tokens) {
    if (t.artistHint && t.songHint) return `${t.artistHint} - ${t.songHint}`;
    if (t.artistHint) return t.artistHint;
    if (t.songHint) return t.songHint;
  }
  // Fall back to the folder name
  return path.basename(immediateFolder(files[0].file_path));
}

// ── Group dedup key ───────────────────────────────────────────────────────────

/** Stable key for a set of file IDs so we can skip already-queued groups. */
function groupKey(fileIds: string[]): string {
  return [...fileIds].sort().join('|');
}

// ── Main engine ───────────────────────────────────────────────────────────────

export interface EngineRunResult {
  groupsFound:   number;
  groupsQueued:  number;
  groupsSkipped: number; // below threshold or already queued
  autoConfirmed: number;
}

/**
 * Run the association engine against recently classified files in the DB.
 *
 * @param db     Database handle (better-sqlite3 or compatible mock)
 * @param windowMs  look at files modified within this window (default: 7 days)
 */
export function runAssociationEngine(
  db: DbLike,
  windowMs = 7 * 24 * 60 * 60 * 1000,
): EngineRunResult {
  const result: EngineRunResult = {
    groupsFound: 0, groupsQueued: 0, groupsSkipped: 0, autoConfirmed: 0,
  };

  // 1. Fetch recently classified files
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const files = db.prepare(`
    SELECT id, file_path, file_name, file_type, file_size,
           classifier_role, classifier_confidence, name_tokens,
           classification_version, modified_at, project_id
    FROM files
    WHERE classification_version > 0
      AND classifier_role IS NOT NULL
      AND classifier_role != 'misc'
      AND modified_at >= ?
    ORDER BY modified_at DESC
    LIMIT 500
  `).all(cutoff) as FileRow[];

  if (files.length < MIN_GROUP_SIZE) return result;

  // 2. Build already-queued key set to prevent duplicates
  const pendingRows = db.prepare(
    "SELECT file_ids FROM association_queue WHERE status = 'pending' LIMIT 200"
  ).all() as Array<{ file_ids: string }>;
  const queuedKeys = new Set(
    pendingRows.map(p => groupKey(JSON.parse(p.file_ids) as string[]))
  );

  // 3. Group by immediate folder
  const byFolder = new Map<string, FileRow[]>();
  for (const f of files) {
    const folder = immediateFolder(f.file_path);
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder)!.push(f);
  }

  let queued = 0;

  // 4. Evaluate each folder cluster + cross-folder parent/child clusters
  const processedGroupKeys = new Set<string>();

  const evaluateGroup = (candidates: FileRow[]) => {
    if (candidates.length < MIN_GROUP_SIZE) return;
    if (queued >= MAX_QUEUE_PER_RUN) return;

    const fileIds = candidates.map(f => f.id);
    const key = groupKey(fileIds);

    if (processedGroupKeys.has(key)) return;
    processedGroupKeys.add(key);

    result.groupsFound++;

    // Skip if already queued
    if (queuedKeys.has(key)) {
      result.groupsSkipped++;
      return;
    }

    // Compute tokens
    const tokens = candidates.map(f => parseTokens(f));

    // Compute signals
    const folders = candidates.map(f => immediateFolder(f.file_path));
    const uniqueFolders = new Set(folders);
    const sameFolder = uniqueFolders.size === 1;

    let parentChildFolder = false;
    if (!sameFolder && uniqueFolders.size === 2) {
      const [fa, fb] = Array.from(uniqueFolders);
      parentChildFolder = isParentChild(fa, fb);
    } else if (!sameFolder) {
      // check if all folders share a common parent within 1 level
      const parents = new Set(folders.map(f => path.dirname(f)));
      parentChildFolder = parents.size === 1;
    }

    // Shared hint: any two files sharing an artist or song hint
    let bestHint: string | null = null;
    for (let i = 0; i < tokens.length && !bestHint; i++) {
      for (let j = i + 1; j < tokens.length && !bestHint; j++) {
        bestHint = sharedHint(tokens[i], tokens[j]);
      }
    }

    // Token overlap: max pairwise overlap
    let maxOverlap = 0;
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        maxOverlap = Math.max(maxOverlap, tokenOverlap(tokens[i], tokens[j]));
      }
    }

    const hasDawProject = candidates.some(f => f.classifier_role === 'daw_project');
    const hasExportFile = candidates.some(f =>
      f.classifier_role === 'bounce' || f.classifier_role === 'master' ||
      f.classifier_role === 'stem'
    );

    // Export-under-project: a bounce/stem folder is a child of a DAW project folder
    let exportUnderProject = false;
    if (hasDawProject && hasExportFile) {
      const dawFolders = candidates
        .filter(f => f.classifier_role === 'daw_project')
        .map(f => immediateFolder(f.file_path));
      const exportFolders = candidates
        .filter(f => f.classifier_role === 'bounce' || f.classifier_role === 'master' || f.classifier_role === 'stem')
        .map(f => immediateFolder(f.file_path));
      exportUnderProject = exportFolders.some(ef =>
        dawFolders.some(df => isParentChild(df, ef))
      );
    }

    const signals: GroupSignals = {
      sameFolder,
      parentChildFolder,
      sharedHint: bestHint,
      tokenOverlap: maxOverlap,
      timestampProximity: timestampWindow(candidates),
      hasDawProject,
      hasExportFile,
      exportUnderProject,
      fileCount: candidates.length,
    };

    const confidence = scoreGroup(signals);

    if (confidence < MIN_CONFIDENCE) {
      result.groupsSkipped++;
      return;
    }

    // Determine relationship type
    const relationship: AssociationRelationship = hasDawProject
      ? 'same_project'
      : exportUnderProject ? 'exported_from'
      : 'same_project';

    const suggestedName = suggestProjectName(candidates, tokens);

    // Suggest a project_id if a DAW project file maps to an existing DB project
    const dawFile = candidates.find(f => f.classifier_role === 'daw_project');
    const suggestedProjectId = dawFile?.project_id ?? null;

    const queueId = crypto.randomUUID();
    db.prepare(`
      INSERT OR IGNORE INTO association_queue
        (id, file_ids, suggested_project_id, relationship, confidence, signals, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', unixepoch())
    `).run(
      queueId,
      JSON.stringify(fileIds),
      suggestedProjectId,
      relationship,
      confidence,
      JSON.stringify({
        ...signals,
        suggestedProjectName: suggestedName,
        fileCount: candidates.length,
        roles: candidates.map(f => f.classifier_role),
      }),
    );

    queuedKeys.add(key); // prevent re-inserting same group in this run
    queued++;
    result.groupsQueued++;

    db.prepare(`
      INSERT INTO activity_log (id, type, message, project_id, file_id, metadata, created_at)
      VALUES (?, ?, ?, NULL, NULL, ?, datetime('now'))
    `).run(
      crypto.randomUUID(),
      'association_suggested',
      `Suggested group: "${suggestedName}" (${candidates.length} files, ${Math.round(confidence * 100)}% confidence)`,
      JSON.stringify({ queueId, confidence, fileCount: candidates.length, suggestedName }),
    );

    // Auto-confirm only extremely high-confidence groups (both DAW + exports in same folder)
    if (confidence >= AUTO_CONFIRM_THRESHOLD) {
      db.prepare(`
        UPDATE association_queue SET status = 'confirmed', resolved_at = unixepoch() WHERE id = ?
      `).run(queueId);
      result.autoConfirmed++;
    }
  };

  // Same-folder groups
  for (const [, folderFiles] of byFolder) {
    // Only include files with song-relevant roles
    const relevant = folderFiles.filter(f => SONG_ROLES.has(f.classifier_role ?? ''));
    evaluateGroup(relevant);
  }

  // Cross-folder parent/child: merge adjacent folder groups
  const folderEntries = Array.from(byFolder.entries());
  for (let i = 0; i < folderEntries.length; i++) {
    for (let j = i + 1; j < folderEntries.length; j++) {
      const [folderA, filesA] = folderEntries[i];
      const [folderB, filesB] = folderEntries[j];
      if (!isParentChild(folderA, folderB)) continue;
      const combined = [...filesA, ...filesB].filter(f => SONG_ROLES.has(f.classifier_role ?? ''));
      evaluateGroup(combined);
    }
  }

  return result;
}

// ── Confirm helper (called from IPC on user confirm) ─────────────────────────

/**
 * When user confirms a queue item, write asset_associations rows for every
 * file pair in the group. Never touches the filesystem.
 */
export function confirmQueueItem(
  db: DbLike,
  queueId: string,
  fileIds: string[],
  relationship: AssociationRelationship,
  confidence: number,
): void {
  const upsert = db.prepare(`
    INSERT INTO asset_associations
      (id, source_file_id, target_file_id, relationship, confidence, confirmed_by, confirmed_at)
    VALUES (?, ?, ?, ?, ?, 'user', unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      confidence   = excluded.confidence,
      confirmed_by = excluded.confirmed_by,
      confirmed_at = excluded.confirmed_at
  `);

  for (let i = 0; i < fileIds.length; i++) {
    for (let j = i + 1; j < fileIds.length; j++) {
      upsert.run(crypto.randomUUID(), fileIds[i], fileIds[j], relationship, confidence);
    }
  }

  db.prepare(`
    INSERT INTO activity_log (id, type, message, project_id, file_id, metadata, created_at)
    VALUES (?, 'association_confirmed', ?, NULL, NULL, ?, datetime('now'))
  `).run(
    crypto.randomUUID(),
    `User confirmed group: ${fileIds.length} files`,
    JSON.stringify({ queueId, fileCount: fileIds.length, relationship }),
  );
}
