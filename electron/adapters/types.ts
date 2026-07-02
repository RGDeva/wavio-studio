/**
 * DAW adapter contract (Phase F — see docs/WAVI_DAW_ADAPTER_ARCHITECTURE.md).
 *
 * This interface is deliberately honest to what the application implements
 * TODAY: detection, classification, pack-exclusion rules, manifest assembly
 * helpers and lightweight metadata extraction. Packaging/restore/launch are
 * currently generic (server ZIP builder + restore:start + shell.openPath) and
 * will move behind adapter methods when a second native DAW needs different
 * behavior — no speculative methods are declared before then.
 *
 * Adapters must be importable OUTSIDE the Electron main process (pure
 * fs/path/zlib/crypto) so vitest can exercise them directly.
 */

export interface ManifestEntry {
  relativePath: string;
  fileName: string;
  fileSize: number;
  sha256: string | null;
  role: string;
  mimeType: string | null;
  assetId: string | null;
}

export interface DawAdapter {
  id: 'ableton' | 'generic' | string;
  displayName: string;

  /** Project-file extensions this adapter claims (lowercase, with dot). */
  projectExtensions: string[];

  isProjectFile(filePath: string): boolean;

  /** Role classification used in published manifests. Total: always returns a role. */
  classifyFileRole(fileName: string, classifierRole: string): string;

  /**
   * Project-relative path for publishing, or null when the file must not be
   * packed (outside the root, or matches cache/backup/temp exclusions).
   * Never returns an absolute path — privacy invariant.
   */
  safeRelativePath(absoluteFile: string, projectRoot: string): string | null;

  /**
   * DAW-specific manifest entries beyond the file walk (e.g. Ableton's
   * `Ableton Project Info/` directory marker). Deterministic for a given
   * on-disk state.
   */
  manifestExtras(projectFilePath: string, projectRoot: string): ManifestEntry[];

  /** Dedicated preview bounce at the project root, if the convention matches. */
  findPreviewCandidate(syncedFiles: Array<{ file_path: string }>, projectRoot: string): any | null;

  /** Lightweight metadata from the project file itself (best-effort). */
  extractMetadata(projectFilePath: string): Promise<{ bpm: number; key: string }>;
}
