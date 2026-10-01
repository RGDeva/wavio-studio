/**
 * Adoption rules for a restored project checkout.
 *
 * These cover the step that was missing entirely: a restore produced only a
 * `restored_projects` row, so the collaborator's edits were invisible to change
 * detection and `publishContributionAuthoritative` could never run (it needs a
 * `projects` row with cloud_id plus `files` rows). The planner is pure, so the
 * rules are tested against the real implementation rather than a copy of it.
 */
import { describe, it, expect } from 'vitest';
import { planRestoreAdoption, adoptionAllowsContribution } from './restoreAdoption';

const DIR = '/Users/x/Music/Restored/Song A';
const ALS = `${DIR}/Song A.als`;

function input(over: Partial<Parameters<typeof planRestoreAdoption>[0]> = {}) {
  let n = 0;
  return {
    restoreId: 'r1',
    projectName: 'Song A',
    dawProjectPath: ALS,
    projectDir: DIR,
    dawType: 'ableton',
    sourceProjectId: 'cloud-proj-1',
    sourceVersionId: 'cloud-ver-7',
    collaboratorPermission: 'comment',
    projectFileSize: 334317,
    restoredAssets: [
      { absolutePath: ALS, fileSize: 334317, sha256: 'a'.repeat(64), role: 'project' },
      { absolutePath: `${DIR}/Samples/kick.wav`, fileSize: 2048, sha256: 'b'.repeat(64), role: 'audio' },
    ],
    now: '2026-09-30T12:00:00.000Z',
    newId: () => `id-${++n}`,
    ...over,
  };
}

describe('planRestoreAdoption — lineage', () => {
  it('carries the restored version across as the PARENT, not as the project itself', () => {
    const plan = planRestoreAdoption(input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // buildPublishManifestBody reads project.cloud_id as the server project to
    // publish into, and the parent is what makes the return a child version.
    expect(plan.cloud).toEqual({ cloudProjectId: 'cloud-proj-1', parentVersionId: 'cloud-ver-7' });
  });

  it('refuses to adopt without a parent version', () => {
    // A publish with no parent could be mistaken for a new root version, which
    // would silently fork history instead of extending it.
    const plan = planRestoreAdoption(input({ sourceVersionId: '' }));
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toMatch(/parent/);
  });

  it('refuses to adopt without a canonical project id', () => {
    expect(planRestoreAdoption(input({ sourceProjectId: '' })).ok).toBe(false);
  });
});

describe('planRestoreAdoption — permission gating', () => {
  it('allows a child version only for the contribute-capable mode', () => {
    // Project-link modes are 'view' | 'comment'; contribution is the 'comment'
    // capability (contributionAllowedForRole in multiplayerService).
    expect(adoptionAllowsContribution('comment')).toBe(true);
    expect(adoptionAllowsContribution('view')).toBe(false);
  });

  it('fails closed on legacy and unknown permissions', () => {
    // main.ts normalises a legacy 'edit' away before it reaches a link, but if
    // one is ever persisted it must not silently grant publish rights.
    for (const perm of ['edit', 'owner', 'contribute', '', null, undefined, 'COMMENT']) {
      expect(adoptionAllowsContribution(perm as string)).toBe(false);
    }
  });

  it('still adopts a view-only checkout, just without publish rights', () => {
    // A read-only recipient should still get a real local project to open and
    // organise — adoption is not the same decision as contribution.
    const plan = planRestoreAdoption(input({ collaboratorPermission: 'view' }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.canPublishChildVersion).toBe(false);
    expect(plan.files.length).toBe(2);
  });
});

describe('planRestoreAdoption — containment', () => {
  it('refuses a project file outside the restored directory', () => {
    const plan = planRestoreAdoption(input({ dawProjectPath: '/Users/x/Elsewhere/Other.als' }));
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toMatch(/outside/);
  });

  it('skips assets that resolve outside the restored directory rather than indexing them', () => {
    // Indexing an outside path would hand it to callers that trust indexed
    // paths (validateSafePath requireIndexed, which shell:openWithApp uses).
    const plan = planRestoreAdoption(input({
      restoredAssets: [
        { absolutePath: ALS, fileSize: 1, sha256: null, role: 'project' },
        { absolutePath: `${DIR}/../../escape.wav`, fileSize: 1, sha256: null, role: 'audio' },
      ],
    }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.files.map((f) => f.file_name)).toEqual(['Song A.als']);
    expect(plan.skipped[0].reason).toMatch(/outside/);
  });

  it('rejects a relative restored directory', () => {
    expect(planRestoreAdoption(input({ projectDir: 'relative/dir' })).ok).toBe(false);
  });
});

describe('planRestoreAdoption — rows it produces', () => {
  it('builds a project row pointing at the DAW file with the restored metadata', () => {
    const plan = planRestoreAdoption(input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.project).toMatchObject({
      project_name: 'Song A',
      file_path: ALS,
      daw_type: 'ableton',
      file_size: 334317,
    });
    expect(plan.watchFolder).toBe(DIR);
  });

  it('indexes assets with checksum, role and derived file_type', () => {
    const plan = planRestoreAdoption(input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const kick = plan.files.find((f) => f.file_name === 'kick.wav')!;
    expect(kick.file_type).toBe('wav');
    expect(kick.role).toBe('audio');
    expect(kick.checksum).toBe('b'.repeat(64));
    expect(kick.project_id).toBe(plan.project.id);
  });

  it('omits checksum when the manifest had none, rather than writing an empty hash', () => {
    const plan = planRestoreAdoption(input({
      restoredAssets: [{ absolutePath: ALS, fileSize: 1, sha256: null, role: 'project' }],
    }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect('checksum' in plan.files[0]).toBe(false);
  });

  it('skips directory markers and duplicate paths', () => {
    const plan = planRestoreAdoption(input({
      restoredAssets: [
        { absolutePath: `${DIR}/Ableton Project Info`, fileSize: 0, sha256: null, role: 'directory' },
        { absolutePath: ALS, fileSize: 1, sha256: null, role: 'project' },
        { absolutePath: ALS, fileSize: 1, sha256: null, role: 'project' },
      ],
    }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.files).toHaveLength(1);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['directory marker', 'duplicate path']);
  });

  it('falls back to the directory name when the link carried no project name', () => {
    const plan = planRestoreAdoption(input({ projectName: '' }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.project.project_name).toBe('Song A');
  });
});
