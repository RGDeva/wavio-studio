/** Links page presentation logic (Phase C). */
import { describe, it, expect } from 'vitest';
import { deriveLinkStatus, linkCapabilities, filterLinks, canDuplicate, linkDisplayName } from './linksView';
import type { LinkListItem } from './api';

const NOW = new Date('2026-07-02T12:00:00Z');

function link(overrides: Partial<LinkListItem> = {}): LinkListItem {
  return {
    tracking_id: 't1', kind: 'listen', project_id: 'p1', project_name: 'My Song',
    asset_id: 'a1', version_id: null, url: 'https://wavi.stream/s/t1', label: null,
    allow_download: 1, collaborator_mode: null, expires_at: null,
    created_at: '2026-07-01T00:00:00Z', revoked_at: null,
    ...overrides,
  };
}

describe('deriveLinkStatus', () => {
  it('active when neither revoked nor expired', () => {
    expect(deriveLinkStatus(link(), NOW)).toBe('active');
  });
  it('expired when expires_at has passed', () => {
    expect(deriveLinkStatus(link({ expires_at: '2026-07-01T00:00:00Z' }), NOW)).toBe('expired');
  });
  it('not expired when expires_at is in the future', () => {
    expect(deriveLinkStatus(link({ expires_at: '2026-08-01T00:00:00Z' }), NOW)).toBe('active');
  });
  it('revoked takes precedence over expired', () => {
    expect(deriveLinkStatus(link({ revoked_at: '2026-07-01T01:00:00Z', expires_at: '2026-06-01T00:00:00Z' }), NOW)).toBe('revoked');
  });
});

describe('linkCapabilities', () => {
  it('listen link with download', () => {
    expect(linkCapabilities(link())).toEqual(['stream_preview', 'download_audio']);
  });
  it('listen link without download', () => {
    expect(linkCapabilities(link({ allow_download: 0 }))).toEqual(['stream_preview']);
  });
  it('project link view-only', () => {
    expect(linkCapabilities(link({ kind: 'project', collaborator_mode: 'view' })))
      .toEqual(['stream_preview', 'download_project_pack', 'open_in_studio']);
  });
  it('project link edit mode gains comment + collaborate', () => {
    expect(linkCapabilities(link({ kind: 'project', collaborator_mode: 'edit' })))
      .toEqual(['stream_preview', 'download_project_pack', 'open_in_studio', 'comment', 'collaborate']);
  });
});

describe('filterLinks', () => {
  const links = [
    link({ tracking_id: 'a', label: 'For the label exec', project_name: 'Alpha' }),
    link({ tracking_id: 'b', kind: 'project', project_name: 'Beta', project_id: 'p2' }),
    link({ tracking_id: 'c', revoked_at: '2026-07-01T00:00:00Z', project_name: 'Gamma' }),
  ];
  it('filters by kind', () => {
    expect(filterLinks(links, { kind: 'project' }, NOW).map(l => l.tracking_id)).toEqual(['b']);
  });
  it('filters by status', () => {
    expect(filterLinks(links, { status: 'revoked' }, NOW).map(l => l.tracking_id)).toEqual(['c']);
    expect(filterLinks(links, { status: 'active' }, NOW).map(l => l.tracking_id)).toEqual(['a', 'b']);
  });
  it('filters by project', () => {
    expect(filterLinks(links, { projectId: 'p2' }, NOW).map(l => l.tracking_id)).toEqual(['b']);
  });
  it('searches label, project name and url', () => {
    expect(filterLinks(links, { query: 'label exec' }, NOW).map(l => l.tracking_id)).toEqual(['a']);
    expect(filterLinks(links, { query: 'gamma' }, NOW).map(l => l.tracking_id)).toEqual(['c']);
  });
  it('empty filters return everything', () => {
    expect(filterLinks(links, {}, NOW)).toHaveLength(3);
  });
});

describe('canDuplicate', () => {
  it('listen link needs a stored asset id', () => {
    expect(canDuplicate(link())).toBe(true);
    expect(canDuplicate(link({ asset_id: null }))).toBe(false); // backfilled legacy row
  });
  it('project link needs a project id', () => {
    expect(canDuplicate(link({ kind: 'project' }))).toBe(true);
    expect(canDuplicate(link({ kind: 'project', project_id: null }))).toBe(false);
  });
});

describe('linkDisplayName', () => {
  it('prefers the internal label', () => {
    expect(linkDisplayName(link({ label: 'A&R demo' }))).toBe('A&R demo');
  });
  it('falls back to project + kind', () => {
    expect(linkDisplayName(link({ kind: 'project' }))).toBe('My Song — Project Link');
  });
  it('falls back to kind alone', () => {
    expect(linkDisplayName(link({ project_name: null }))).toBe('Listen Link');
  });
});
