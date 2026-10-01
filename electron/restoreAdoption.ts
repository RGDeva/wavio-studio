/**
 * Adoption: turn a RESTORED project into a first-class local Wavi project.
 *
 * The gap this closes
 * -------------------
 * `restore:start` downloaded, verified and recorded a checkout in
 * `restored_projects` — and stopped there. Nothing was written to `projects`
 * or `files`, and the restored directory was never watched. Three
 * consequences, all of which broke the "collaborator sends work back" step:
 *
 *   1. Change detection never looked at the restored folder, so edits the
 *      collaborator made were invisible to Wavi.
 *   2. `publishContributionAuthoritative()` takes a `localProjectId` and calls
 *      `buildPublishManifestBody()`, which requires a `projects` row carrying
 *      `cloud_id` plus `files` rows that are `synced` with a `cloud_asset_id`.
 *      A restored checkout had none of those, so publishing a child version
 *      was structurally impossible rather than merely unwired.
 *   3. Anything gated on an indexed path (`validateSafePath(…,
 *      { requireIndexed: true })`, which `shell:openWithApp` uses) rejected
 *      restored files.
 *
 * Adoption writes the rows that make a restored checkout behave like any
 * other local project, and carries the lineage across so a later publish is a
 * CHILD of the version that was received — never an overwrite of it.
 *
 * This module is a pure planner: it performs no I/O and imports nothing from
 * Electron, so the rules below are directly testable. The caller applies the
 * plan.
 */
import * as path from 'path';

/** Permission recorded on the restored checkout (project-link vocabulary). */
export type CollaboratorPermission = string | null | undefined;

export interface RestoredAsset {
  /** Absolute path on disk after extraction. */
  absolutePath: string;
  fileSize: number;
  sha256: string | null;
  /** Manifest role, e.g. 'project' | 'audio' | 'midi' | 'directory'. */
  role?: string | null;
}

export interface RestoreAdoptionInput {
  restoreId: string;
  projectName: string;
  /** Absolute path to the located DAW project file (.als/.flp/…). */
  dawProjectPath: string;
  /** Absolute path to the restored project directory. */
  projectDir: string;
  dawType: string | null;
  /** Canonical server project the link resolved to. */
  sourceProjectId: string;
  /** Canonical server version that was restored — the PARENT of any return. */
  sourceVersionId: string;
  collaboratorPermission: CollaboratorPermission;
  restoredAssets: RestoredAsset[];
  projectFileSize: number;
  now: string;
  newId: () => string;
}

export interface AdoptedProjectRow {
  id: string;
  project_name: string;
  file_path: string;
  daw_type: string;
  file_size: number;
  created_at: string;
  modified_at: string;
}

export interface AdoptedFileRow {
  id: string;
  project_id: string;
  file_path: string;
  file_name: string;
  file_type: string;
  file_size: number;
  checksum?: string;
  role?: string | null;
  created_at: string;
  modified_at: string;
}

export interface RestoreAdoptionPlan {
  ok: true;
  project: AdoptedProjectRow;
  files: AdoptedFileRow[];
  /** Written via updateProjectSyncStatus so a later publish targets the right server project. */
  cloud: { cloudProjectId: string; parentVersionId: string };
  /** Directory to start watching so the collaborator's edits are detected. */
  watchFolder: string;
  /**
   * Whether this checkout may be published back as a child version.
   *
   * Project-link collaborator modes are 'view' | 'comment'; contribution is
   * the 'comment' capability (see contributionAllowedForRole in
   * multiplayerService). Anything else — including the legacy 'edit' string
   * that main.ts normalises away, and an absent value — fails closed to
   * read-only. Adoption still happens: a view-only recipient benefits from a
   * real local project for opening and organisation; they simply cannot
   * publish.
   */
  canPublishChildVersion: boolean;
  skipped: Array<{ absolutePath: string; reason: string }>;
}

export type RestoreAdoptionResult = RestoreAdoptionPlan | { ok: false; reason: string };

/** Contribution is the 'comment' capability; everything else is read-only. */
export function adoptionAllowsContribution(permission: CollaboratorPermission): boolean {
  return permission === 'comment';
}

function isInside(dir: string, candidate: string): boolean {
  const root = path.resolve(dir);
  const abs = path.resolve(candidate);
  return abs === root || abs.startsWith(root + path.sep);
}

/**
 * Build the rows needed to adopt a restored checkout.
 *
 * Fails closed rather than adopting something half-formed: an empty or
 * relative directory, a project file outside the restored directory, or a
 * missing canonical identifier all abort. Assets that resolve outside the
 * restored directory are skipped rather than indexed — the same containment
 * rule restore extraction applies, enforced again here because indexing an
 * outside path would hand it to code that trusts indexed paths.
 */
export function planRestoreAdoption(input: RestoreAdoptionInput): RestoreAdoptionResult {
  if (!input.projectDir || !path.isAbsolute(input.projectDir)) {
    return { ok: false, reason: 'restored project directory must be an absolute path' };
  }
  if (!input.dawProjectPath || !path.isAbsolute(input.dawProjectPath)) {
    return { ok: false, reason: 'DAW project path must be an absolute path' };
  }
  if (!isInside(input.projectDir, input.dawProjectPath)) {
    return { ok: false, reason: 'DAW project file resolves outside the restored directory' };
  }
  if (!input.sourceProjectId) {
    return { ok: false, reason: 'restored checkout has no canonical project id to adopt against' };
  }
  if (!input.sourceVersionId) {
    // Without a parent, a later publish could not be expressed as a child and
    // would risk being treated as a new root version.
    return { ok: false, reason: 'restored checkout has no canonical version id to use as the parent' };
  }

  const projectId = input.newId();
  const project: AdoptedProjectRow = {
    id: projectId,
    project_name: input.projectName || path.basename(input.projectDir),
    file_path: input.dawProjectPath,
    daw_type: input.dawType || 'unknown',
    file_size: input.projectFileSize,
    created_at: input.now,
    modified_at: input.now,
  };

  const files: AdoptedFileRow[] = [];
  const skipped: Array<{ absolutePath: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const asset of input.restoredAssets) {
    if (asset.role === 'directory') {
      skipped.push({ absolutePath: asset.absolutePath, reason: 'directory marker' });
      continue;
    }
    if (!path.isAbsolute(asset.absolutePath) || !isInside(input.projectDir, asset.absolutePath)) {
      skipped.push({ absolutePath: asset.absolutePath, reason: 'outside the restored directory' });
      continue;
    }
    const resolved = path.resolve(asset.absolutePath);
    if (seen.has(resolved)) {
      skipped.push({ absolutePath: asset.absolutePath, reason: 'duplicate path' });
      continue;
    }
    seen.add(resolved);

    const fileName = path.basename(resolved);
    files.push({
      id: input.newId(),
      project_id: projectId,
      file_path: resolved,
      file_name: fileName,
      file_type: path.extname(fileName).replace(/^\./, '').toLowerCase(),
      file_size: asset.fileSize,
      ...(asset.sha256 ? { checksum: asset.sha256 } : {}),
      role: asset.role ?? null,
      created_at: input.now,
      modified_at: input.now,
    });
  }

  return {
    ok: true,
    project,
    files,
    cloud: { cloudProjectId: input.sourceProjectId, parentVersionId: input.sourceVersionId },
    watchFolder: path.resolve(input.projectDir),
    canPublishChildVersion: adoptionAllowsContribution(input.collaboratorPermission),
    skipped,
  };
}
