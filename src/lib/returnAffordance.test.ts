/**
 * When to offer "publish my changes back".
 *
 * Getting this wrong has two distinct costs: offering it without contribute
 * rights produces a server rejection the user cannot act on, and withholding
 * it from someone who does have rights strands their work. The conditions
 * below mirror what buildPublishManifestBody and the server actually require.
 */
import { describe, it, expect } from 'vitest';
import { resolveReturnAffordance, type AdoptionInfo } from './returnAffordance';

const adopted: AdoptionInfo = {
  isAdopted: true,
  parentVersionId: 'cloud-ver-7',
  collaboratorPermission: 'comment',
  projectName: 'Song A',
};
const synced = { cloudId: 'cloud-proj-1', syncedFileCount: 3 };

describe('resolveReturnAffordance', () => {
  it('offers the return when the checkout carries contribute rights and work is synced', () => {
    const r = resolveReturnAffordance(adopted, synced);
    expect(r).toMatchObject({ show: true, enabled: true, blockedReason: null, parentVersionId: 'cloud-ver-7' });
    expect(r.show && r.label).toContain('Song A');
  });

  it('hides it entirely for an ordinary local project', () => {
    // A project the user made themselves has no parent to contribute to.
    expect(resolveReturnAffordance(null, synced)).toEqual({ show: false, reason: 'not-adopted' });
    expect(resolveReturnAffordance({ ...adopted, isAdopted: false }, synced))
      .toEqual({ show: false, reason: 'not-adopted' });
  });

  it('hides it when the checkout has no parent version', () => {
    expect(resolveReturnAffordance({ ...adopted, parentVersionId: null }, synced))
      .toEqual({ show: false, reason: 'not-adopted' });
  });

  it('HIDES rather than disables it for a view-only recipient', () => {
    // They were never granted the right, so a greyed-out control would be
    // noise rather than guidance.
    expect(resolveReturnAffordance({ ...adopted, collaboratorPermission: 'view' }, synced))
      .toEqual({ show: false, reason: 'read-only' });
  });

  it('fails closed on an unknown or missing permission', () => {
    for (const p of ['edit', 'owner', 'contribute', '', null]) {
      expect(resolveReturnAffordance({ ...adopted, collaboratorPermission: p }, synced).show).toBe(false);
    }
  });

  it('shows but disables when nothing has been uploaded yet', () => {
    // The manifest builder refuses a project with no synced file, so enabling
    // the button here would guarantee a failure.
    const r = resolveReturnAffordance(adopted, { ...synced, syncedFileCount: 0 });
    expect(r).toMatchObject({ show: true, enabled: false });
    expect(r.show && r.blockedReason).toMatch(/Sync your changes first/);
  });

  it('shows but disables when the project is not linked to the original', () => {
    const r = resolveReturnAffordance(adopted, { ...synced, cloudId: null });
    expect(r).toMatchObject({ show: true, enabled: false });
    expect(r.show && r.blockedReason).toMatch(/not linked to the original/);
  });

  it('falls back to a generic label when the project name is missing', () => {
    const r = resolveReturnAffordance({ ...adopted, projectName: null }, synced);
    expect(r.show && r.label).toBe('Publish changes back');
  });
});
