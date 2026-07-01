import type { FolderClassification } from './api';

/**
 * Pure interpretation of the folders:add / folders:addPath IPC result contract,
 * kept out of FoldersPage so the flow is unit-testable under node vitest
 * (the repo has no renderer/browser test environment).
 *
 * Contract (electron/main.ts):
 *   - null                                  → user cancelled the native dialog
 *   - { needsConfirmation: true, classification } → folder NOT added; renderer
 *     must show a confirmation and call folders:confirmAmbiguous to proceed
 *   - { needsConfirmation: false, path }    → folder added
 *   - legacy string                         → folder added (pre-contract shape,
 *     tolerated defensively so an old main process can't strand the UI)
 */
export type FolderAddOutcome =
  | { kind: 'cancelled' }
  | { kind: 'added'; path: string }
  | { kind: 'needs-confirmation'; classification: FolderClassification }
  | { kind: 'error'; message: string };

export function interpretFolderAddResult(result: unknown): FolderAddOutcome {
  if (result === null || result === undefined) return { kind: 'cancelled' };
  if (typeof result === 'string') return { kind: 'added', path: result };
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (r.needsConfirmation === true && r.classification && typeof r.classification === 'object') {
      return { kind: 'needs-confirmation', classification: r.classification as FolderClassification };
    }
    if (r.needsConfirmation === false && typeof r.path === 'string') {
      return { kind: 'added', path: r.path };
    }
  }
  return { kind: 'error', message: 'Unexpected response while adding the folder. Please try again.' };
}

/** User-facing copy for the ambiguous-folder confirmation. */
export function confirmationCopy(c: FolderClassification): { title: string; body: string } {
  const folderName = c.path.split('/').pop() || c.path;
  if (c.reason === 'name_match') {
    return {
      title: `“${folderName}” looks like a sample library`,
      body:
        `This folder's name matches a known sample-pack or plugin-content vendor. ` +
        `Indexing it will scan and hash every file inside, which can create a very large amount of ` +
        `scanning and sync work for content you probably don't need to back up. ` +
        `Sample libraries are never uploaded automatically, but indexing them still costs time, CPU, and database size.`,
    };
  }
  return {
    title: `“${folderName}” contains a lot of loose audio`,
    body:
      `This folder has ${c.audioFileCount.toLocaleString()} audio files and no DAW project files, ` +
      `which usually means a sample or loop collection rather than your own projects. ` +
      `Indexing it will scan and hash every file, which can create excessive scanning and sync work. ` +
      `If these are your own recordings, it's safe to add anyway.`,
  };
}

/**
 * Completes an ambiguous add after the user chose "Add Anyway".
 * Wraps the IPC call so a main-process failure surfaces as an outcome
 * instead of an unhandled rejection.
 */
export async function completeAmbiguousAdd(
  confirmFn: (folderPath: string) => Promise<{ needsConfirmation: false; path: string }>,
  folderPath: string,
): Promise<FolderAddOutcome> {
  try {
    const result = await confirmFn(folderPath);
    return interpretFolderAddResult(result);
  } catch (e) {
    return {
      kind: 'error',
      message: `Could not add “${folderPath.split('/').pop() || folderPath}”: ${(e as Error)?.message ?? 'unknown error'}`,
    };
  }
}
