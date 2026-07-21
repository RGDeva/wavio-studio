/** Project Detail presentation logic (Phase D). */
import { describe, it, expect } from 'vitest';
import { deriveRole, groupFilesByRole, pickLatestBounce, expiryToIso, pickShareAsset, buildBounceMediaUrl, deriveProjectSummary, formatFileSize, DetailFile } from './projectDetailView';

function f(overrides: Partial<DetailFile> = {}): DetailFile {
  return {
    id: crypto.randomUUID(), file_name: 'a.wav', file_path: '/p/a.wav',
    file_type: 'wav', file_size: 100, sync_status: 'pending',
    modified_at: '2026-07-01T00:00:00Z', local_status: 'present',
    ...overrides,
  };
}

describe('deriveProjectSummary (§6.2 at-a-glance facts)', () => {
  it('counts roles, completeness, size from a mixed project', () => {
    const files = [
      f({ file_name: 'Song.als', sync_status: 'synced' }),                          // project, synced
      f({ file_name: 'master.wav', classifier_role: 'master', sync_status: 'synced', file_size: 1000 }), // bounce, synced
      f({ file_name: 'kick.wav', classifier_role: 'stem', sync_status: 'synced' }), // stem, synced
      f({ file_name: 'snare.wav', classifier_role: 'stem', sync_status: 'pending' }), // stem, not synced
      f({ file_name: 'melody.mid', sync_status: 'pending' }),                        // midi
      f({ file_name: 'cover.png', sync_status: 'synced' }),                          // artwork, synced
      f({ file_name: 'gone.wav', classifier_role: 'stem', local_status: 'missing' }), // missing stem
    ];
    const s = deriveProjectSummary(files);
    expect(s.hasNativeProject).toBe(true);
    expect(s.hasBounce).toBe(true);
    expect(s.stemCount).toBe(2);   // present stems by role (missing → 'missing' role)
    expect(s.midiCount).toBe(1);
    expect(s.artworkCount).toBe(1);
    expect(s.missingCount).toBe(1);
    expect(s.totalFiles).toBe(7);
    // complete = not missing AND synced → Song.als, master, kick, cover = 4/7
    expect(s.packageCompleteness).toBe(Math.round((4 / 7) * 100));
  });

  it('empty project → zeros, 0% completeness, no native/bounce', () => {
    const s = deriveProjectSummary([]);
    expect(s).toMatchObject({ hasNativeProject: false, hasBounce: false, totalFiles: 0, packageCompleteness: 0 });
  });

  it('missing files are excluded from completeness even if marked synced', () => {
    const s = deriveProjectSummary([f({ local_status: 'missing', sync_status: 'synced' })]);
    expect(s.packageCompleteness).toBe(0);
    expect(s.missingCount).toBe(1);
  });
});

describe('formatFileSize', () => {
  it('formats bytes across units', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
});

describe('buildBounceMediaUrl (renderer gets an opaque url, never a raw path)', () => {
  it('builds an id-only wavi-media url', () => {
    const url = buildBounceMediaUrl('proj-1', f({ id: 'asset-9', file_path: '/Users/me/Music/x.wav' }));
    expect(url).toBe('wavi-media://asset/proj-1/asset-9');
    expect(url).not.toContain('/Users');
    expect(url).not.toContain('.wav');
  });
  it('returns null for missing bounce, missing-on-disk, or unsafe ids', () => {
    expect(buildBounceMediaUrl('proj-1', null)).toBeNull();
    expect(buildBounceMediaUrl('proj-1', f({ id: 'a', local_status: 'missing' }))).toBeNull();
    expect(buildBounceMediaUrl('proj-1', f({ id: '../etc/passwd' }))).toBeNull();
    expect(buildBounceMediaUrl(undefined, f({ id: 'a' }))).toBeNull();
  });
});

describe('deriveRole', () => {
  it('missing beats everything', () => {
    expect(deriveRole(f({ file_name: 'x.als', local_status: 'missing' }))).toBe('missing');
  });
  it('DAW project files by extension', () => {
    expect(deriveRole(f({ file_name: 'Song.als' }))).toBe('project');
    expect(deriveRole(f({ file_name: 'beat.flp' }))).toBe('project');
  });
  it('classifier stem/sample win over generic audio', () => {
    expect(deriveRole(f({ classifier_role: 'stem' }))).toBe('stem');
    expect(deriveRole(f({ classifier_role: 'sample' }))).toBe('sample');
    expect(deriveRole(f())).toBe('audio');
  });
});

describe('groupFilesByRole', () => {
  it('groups in canonical order and skips empty roles', () => {
    const groups = groupFilesByRole([
      f({ file_name: 'kick.wav', classifier_role: 'sample' }),
      f({ file_name: 'Song.als' }),
      f({ file_name: 'mix.wav' }),
    ]);
    expect(groups.map((g) => g.role)).toEqual(['project', 'audio', 'sample']);
  });
});

describe('pickLatestBounce', () => {
  it('prefers master/mix/bounce roles over plain audio and stems', () => {
    const master = f({ file_name: 'final.wav', role: 'master', modified_at: '2026-01-01T00:00:00Z' });
    const newerPlain = f({ file_name: 'idea.wav', modified_at: '2026-06-01T00:00:00Z' });
    const stem = f({ file_name: 'drums.wav', classifier_role: 'stem', modified_at: '2026-06-30T00:00:00Z' });
    expect(pickLatestBounce([newerPlain, stem, master])?.file_name).toBe('final.wav');
  });
  it('falls back to the newest plain audio, never a missing file', () => {
    const gone = f({ file_name: 'gone.wav', local_status: 'missing', modified_at: '2026-06-30T00:00:00Z' });
    const older = f({ file_name: 'older.wav', modified_at: '2026-05-01T00:00:00Z' });
    const newer = f({ file_name: 'newer.wav', modified_at: '2026-06-01T00:00:00Z' });
    expect(pickLatestBounce([gone, older, newer])?.file_name).toBe('newer.wav');
  });
  it('null when no audio present', () => {
    expect(pickLatestBounce([f({ file_name: 'Song.als' })])).toBeNull();
  });
});

describe('expiryToIso', () => {
  const now = new Date('2026-07-02T00:00:00Z');
  it('never → undefined', () => expect(expiryToIso('never', now)).toBeUndefined());
  it('24h → +1 day', () => expect(expiryToIso('24h', now)).toBe('2026-07-03T00:00:00.000Z'));
  it('7d → +7 days', () => expect(expiryToIso('7d', now)).toBe('2026-07-09T00:00:00.000Z'));
});

describe('pickShareAsset', () => {
  it('prefers synced master/mix', () => {
    const files = [
      f({ file_name: 'raw.wav', sync_status: 'synced', cloud_asset_id: 'a1' }),
      f({ file_name: 'mix.wav', sync_status: 'synced', cloud_asset_id: 'a2', role: 'mix' }),
    ];
    expect(pickShareAsset(files)?.file_name).toBe('mix.wav');
  });
  it('requires a synced cloud asset', () => {
    expect(pickShareAsset([f({ sync_status: 'pending' })])).toBeNull();
  });
});
