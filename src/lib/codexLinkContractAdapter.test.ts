import { describe, it, expect } from 'vitest';
import {
  parseAuthoritativeItem, parseListResponse,
  isServerSupportedCollaboratorMode, SERVER_SUPPORTED_COLLABORATOR_MODES,
} from './codexLinkContractAdapter';
import { isAcceptableCanonicalAccountId } from './accountContext';
import { reconcileLink } from './linkReconciliation';
import type { LinkRecord } from './projectLinks';

/** Exact sample item from Codex's WAVI_PROJECT_LINKS_SERVER_AUDIT.md (staging). */
const SAMPLE_ITEM = {
  id: 'project-links-9',
  trackingId: '9f4b77c0e3c2d1aa',
  publicIdentifier: '9f4b77c0e3c2d1aa',
  projectId: 'project-1',
  versionId: 'version-2',
  ownerAccountId: 'did:privy:owner1abc',
  createdAt: '2026-07-22T01:10:00.000Z',
  updatedAt: '2026-07-22T01:10:00.000Z',
  revision: '2026-07-22T01:10:00.000Z',
  expiresAt: null,
  state: { active: true, revoked: false, expired: false },
  permissions: { allowDownload: true, collaboratorMode: 'view', previewEnabled: true, requiresPassword: false },
};

describe('Codex wire adapter (staging-pending contract)', () => {
  it('canonical Privy DID is accepted as an account key; token shapes still rejected', () => {
    expect(isAcceptableCanonicalAccountId('did:privy:owner1abc')).toBe(true);
    expect(isAcceptableCanonicalAccountId('did:privy:cm4x9k2p0001')).toBe(true);
    expect(isAcceptableCanonicalAccountId('wv_abc123def456')).toBe(false);
    expect(isAcceptableCanonicalAccountId('did:privy:')).toBe(false);      // empty suffix
    expect(isAcceptableCanonicalAccountId('user@example.com')).toBe(false);
  });

  it('maps the documented sample item to an AuthoritativeLinkRecord', () => {
    const parsed = parseAuthoritativeItem(SAMPLE_ITEM);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.record).toMatchObject({
      accountId: 'did:privy:owner1abc',
      linkId: 'project-links-9',
      trackingId: '9f4b77c0e3c2d1aa',
      projectId: 'project-1',
      projectVersionId: 'version-2',
      status: 'active',
      createdAt: '2026-07-22T01:10:00.000Z',
      expiresAt: null,
    });
  });

  it('state booleans map to the status enum (revoked wins over expired)', () => {
    const revoked = parseAuthoritativeItem({ ...SAMPLE_ITEM, state: { active: false, revoked: true, expired: false } });
    expect(revoked.kind === 'ok' && revoked.record.status).toBe('revoked');
    const expired = parseAuthoritativeItem({ ...SAMPLE_ITEM, state: { active: false, revoked: false, expired: true } });
    expect(expired.kind === 'ok' && expired.record.status).toBe('expired');
    const both = parseAuthoritativeItem({ ...SAMPLE_ITEM, state: { active: false, revoked: true, expired: true } });
    expect(both.kind === 'ok' && both.record.status).toBe('revoked');
  });

  it('fails closed on missing fields and contradictory state', () => {
    expect(parseAuthoritativeItem({ ...SAMPLE_ITEM, trackingId: undefined }).kind).toBe('malformed');
    expect(parseAuthoritativeItem({ ...SAMPLE_ITEM, versionId: '' }).kind).toBe('malformed');
    expect(parseAuthoritativeItem({}).kind).toBe('malformed');
    // active=true while revoked=true contradicts the server's derivation.
    expect(parseAuthoritativeItem({ ...SAMPLE_ITEM, state: { active: true, revoked: true, expired: false } }).kind).toBe('malformed');
    // all-false is equally contradictory (active must equal !revoked && !expired).
    expect(parseAuthoritativeItem({ ...SAMPLE_ITEM, state: { active: false, revoked: false, expired: false } }).kind).toBe('malformed');
  });

  it('parses the documented list response; pageComplete only when hasMore=false', () => {
    const page1 = parseListResponse({
      accountId: 'did:privy:owner1abc',
      items: [SAMPLE_ITEM],
      pageInfo: { limit: 50, hasMore: true, nextCursor: 'abc', order: 'updatedAtDesc,idDesc', scope: 'owner' },
    });
    expect(page1.kind).toBe('ok');
    if (page1.kind === 'ok') {
      expect(page1.pageComplete).toBe(false); // must NOT drive reconciliation-needed
      expect(page1.nextCursor).toBe('abc');
    }
    const lastPage = parseListResponse({
      accountId: 'did:privy:owner1abc',
      items: [SAMPLE_ITEM],
      pageInfo: { limit: 50, hasMore: false, nextCursor: null, order: 'updatedAtDesc,idDesc', scope: 'owner' },
    });
    expect(lastPage.kind === 'ok' && lastPage.pageComplete).toBe(true);
    // Malformed top-levels fail closed.
    expect(parseListResponse({ items: [SAMPLE_ITEM] }).kind).toBe('malformed');          // no accountId
    expect(parseListResponse({ accountId: 'did:privy:owner1abc' }).kind).toBe('malformed'); // no items
    expect(parseListResponse({ accountId: 'did:privy:owner1abc', items: [{}] }).kind).toBe('malformed');
  });

  it('adapter output feeds reconcileLink end-to-end with the real DID', () => {
    const parsed = parseAuthoritativeItem(SAMPLE_ITEM);
    if (parsed.kind !== 'ok') throw new Error('sample must parse');
    const cached: LinkRecord = {
      tracking_id: '9f4b77c0e3c2d1aa', kind: 'project', project_id: 'project-1',
      version_id: 'version-2', url: 'https://wavi.stream/project-link/9f4b77c0e3c2d1aa',
      created_at: '2026-07-22T01:10:00.000Z',
    };
    expect(reconcileLink(cached, parsed.record, 'did:privy:owner1abc').kind).toBe('server-confirmed');
    expect(reconcileLink(cached, parsed.record, 'did:privy:someoneelse').kind).toBe('account-mismatch-hidden');
    // Binding safety holds across the adapter too.
    const wrongVersion = parseAuthoritativeItem({ ...SAMPLE_ITEM, versionId: 'version-9' });
    if (wrongVersion.kind !== 'ok') throw new Error('must parse');
    expect(reconcileLink(cached, wrongVersion.record, 'did:privy:owner1abc').kind).toBe('binding-conflict');
  });

  it('server supports only view|comment collaborator modes — edit is not offered', () => {
    expect([...SERVER_SUPPORTED_COLLABORATOR_MODES]).toEqual(['view', 'comment']);
    expect(isServerSupportedCollaboratorMode('view')).toBe(true);
    expect(isServerSupportedCollaboratorMode('comment')).toBe(true);
    expect(isServerSupportedCollaboratorMode('edit')).toBe(false);
  });
});
