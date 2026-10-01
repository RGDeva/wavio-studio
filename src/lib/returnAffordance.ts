/**
 * Should this project offer "publish my changes back"?
 *
 * The return step is the end of the core loop: a collaborator restores a
 * Project Link, edits in their own DAW, and sends the work back as a CHILD of
 * the version they received. Deciding when to offer that is a product rule
 * with real consequences — offering it to someone without contribute rights
 * produces a server rejection they cannot act on, and hiding it from someone
 * who does have rights strands their work.
 *
 * Pure so the rule is testable without the main process.
 */

export interface AdoptionInfo {
  /** Present when this local project was adopted from a restored checkout. */
  isAdopted: boolean;
  /** Canonical version the checkout came from — the parent of any return. */
  parentVersionId: string | null;
  /** Project-link permission recorded on the checkout ('view' | 'comment'). */
  collaboratorPermission: string | null;
  /** Project name as received, for labelling. */
  projectName?: string | null;
}

export interface ProjectSyncState {
  /** projects.cloud_id — the canonical server project. */
  cloudId: string | null;
  /** Count of this project's files that are synced with a cloud asset. */
  syncedFileCount: number;
}

export type ReturnAffordance =
  | { show: false; reason: 'not-adopted' | 'read-only' }
  | {
      show: true;
      enabled: boolean;
      /** Why it is disabled, phrased for a musician rather than an engineer. */
      blockedReason: string | null;
      label: string;
      parentVersionId: string;
    };

/**
 * Mirrors what the server and manifest builder actually require, so the button
 * is only enabled when a publish can genuinely succeed:
 *   · the project must be adopted from a checkout (it has a parent)
 *   · the link must carry contribute rights ('comment')
 *   · the project must be linked to a canonical server project (cloud_id)
 *   · at least one file must be uploaded, or there is nothing to publish
 */
export function resolveReturnAffordance(
  adoption: AdoptionInfo | null,
  sync: ProjectSyncState,
): ReturnAffordance {
  if (!adoption?.isAdopted || !adoption.parentVersionId) {
    return { show: false, reason: 'not-adopted' };
  }
  // Hidden rather than disabled: a view-only recipient was never offered the
  // right, so presenting a greyed control would just be noise.
  if (adoption.collaboratorPermission !== 'comment') {
    return { show: false, reason: 'read-only' };
  }

  const label = adoption.projectName
    ? `Publish changes back to “${adoption.projectName}”`
    : 'Publish changes back';

  if (!sync.cloudId) {
    return {
      show: true, enabled: false, label, parentVersionId: adoption.parentVersionId,
      blockedReason: 'This project is not linked to the original yet.',
    };
  }
  if (sync.syncedFileCount < 1) {
    return {
      show: true, enabled: false, label, parentVersionId: adoption.parentVersionId,
      blockedReason: 'Sync your changes first — nothing has been uploaded yet.',
    };
  }
  return { show: true, enabled: true, label, parentVersionId: adoption.parentVersionId, blockedReason: null };
}
