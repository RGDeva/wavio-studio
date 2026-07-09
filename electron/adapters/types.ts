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

/**
 * Honest capability report for the compatibility UI / assistant. Reflects what
 * the app supports TODAY for this DAW — not aspirational. `sameDawOpen` means
 * the native project restores and opens in its own DAW; cross-DAW / plugin scan
 * / fidelity reporting stay false until actually implemented.
 */
export interface DawCapabilities {
  detect: boolean;
  packageNative: boolean;
  restore: boolean;
  sameDawOpen: boolean;
  crossDawReconstruct: boolean;
  scanPlugins: boolean;
  fidelityReport: boolean;
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

  /** Honest capability report (reflects today's support). */
  capabilities(): DawCapabilities;

  /**
   * Locate the DAW project file inside a restored directory when no explicit
   * role='project' manifest entry resolved on disk. Behavior-preserving
   * fallback extracted from restore:start — same recursive walk and extension
   * set the flow used inline.
   */
  locateProjectFile(restoredDir: string): string | null;
}
