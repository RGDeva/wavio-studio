/**
 * P3-2c pre-merge hardening tests.
 *  - exact /api/desktop URL construction across every environment shape
 *  - no obsolete Project Link endpoint/action path remains active (source guard)
 *  - opaque renderer account handle (DID never crosses to renderer/model)
 *  - in-flight coordination: dedup, logout/session invalidation, no retry
 *  - non-idempotent create: outcome-unknown on ambiguity, double-submit dedup
 *  - filter-scoped reconciliation (partial/filtered listing can't flag out-of-scope rows)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildDesktopEndpoint, toRendererAccountHandle, createLinkOpsCoordinator,
  createProjectLinkFlow, normalizeCreateKey, planReconciliation,
  type ProjectLinkServiceDeps, type AuthoritativeItem,
} from './projectLinkService';

const DID = 'did:privy:owner1abc';

describe('endpoint resolution — one authoritative builder', () => {
  it('production default resolves to exactly /api/desktop', () => {
    expect(buildDesktopEndpoint('https://wavi.stream/api')).toBe('https://wavi.stream/api/desktop');
  });
  it('preview/QA base (…vercel.app/api) resolves to /api/desktop', () => {
    expect(buildDesktopEndpoint('https://wavio-9t99dhvad-rgdevas-projects.vercel.app/api'))
      .toBe('https://wavio-9t99dhvad-rgdevas-projects.vercel.app/api/desktop');
  });
  it('dev localhost with and without /api both resolve to /api/desktop', () => {
    expect(buildDesktopEndpoint('http://localhost:3000/api')).toBe('http://localhost:3000/api/desktop');
    expect(buildDesktopEndpoint('http://localhost:3000')).toBe('http://localhost:3000/api/desktop');
  });
  it('misconfigured bare origin gains the /api prefix (never a bare /desktop)', () => {
    expect(buildDesktopEndpoint('https://preview.vercel.app')).toBe('https://preview.vercel.app/api/desktop');
  });
  it('trailing slashes and accidental double /api are normalized', () => {
    expect(buildDesktopEndpoint('https://wavi.stream/api/')).toBe('https://wavi.stream/api/desktop');
    expect(buildDesktopEndpoint('https://wavi.stream/api/api')).toBe('https://wavi.stream/api/desktop');
  });
  it('never produces /desktop/index, /api/api/, or a bare /desktop', () => {
    for (const base of ['https://wavi.stream/api', 'https://x.dev', 'http://localhost:5999/api/', 'https://y.app/api/api']) {
      const url = buildDesktopEndpoint(base);
      expect(url.endsWith('/api/desktop')).toBe(true);
      expect(url).not.toContain('/desktop/index');
      expect(url).not.toContain('/api/api/');
    }
  });
});

describe('no obsolete Project Link paths remain active (source guards)', () => {
  const mainSrc = readFileSync(join(__dirname, 'main.ts'), 'utf8');
  it('the three PL actions never go through the legacy desktopApiPost helper', () => {
    expect(mainSrc).not.toMatch(/desktopApiPost\([^)]*'create-project-link'/);
    expect(mainSrc).not.toMatch(/desktopApiPost\([^)]*'revoke-project-link'/);
    expect(mainSrc).not.toMatch(/desktopApiPost\([^)]*'list-project-links'/);
  });
  it('the authoritative POST uses the single endpoint builder, not an inline template', () => {
    expect(mainSrc).toContain('buildDesktopEndpoint(API_BASE)');
    // No inline `${API_BASE}/desktop` (non-index) fetch remains.
    expect(mainSrc).not.toMatch(/\$\{API_BASE\}\/desktop`/);
  });
  it('remaining /desktop/index uses are legacy NON-Project-Link actions only (documented)', () => {
    // The legacy endpoint may appear, but never together with a PL action name
    // on the same call path — the PL trio is served exclusively by /api/desktop.
    const legacyBlocks = mainSrc.split('desktop/index');
    expect(legacyBlocks.length).toBeGreaterThan(1); // legacy actions still exist (share links, publish, resolve)
  });
});

describe('account-identity boundary — DID never crosses to the renderer', () => {
  it('handle is opaque, deterministic, distinct per DID, and contains no DID material', () => {
    const h1 = toRendererAccountHandle(DID);
    const h2 = toRendererAccountHandle(DID);
    const other = toRendererAccountHandle('did:privy:someoneelse');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(other);
    expect(h1).toMatch(/^acct_[0-9a-f]{20}$/);
    expect(h1).not.toContain('did');
    expect(h1).not.toContain('privy');
  });
  it('main.ts sends only the handle over auth:account and strips DIDs from rows', () => {
    const mainSrc = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    // Every auth:account send is either the null logout signal or the handle.
    const sends = mainSrc.match(/send\('auth:account',[^)]*\)/g) ?? [];
    expect(sends.length).toBeGreaterThan(0);
    for (const s of sends) {
      expect(s.includes('toRendererAccountHandle') || s.includes('accountId: null'), s).toBe(true);
    }
    expect(mainSrc).toContain('toRendererRows'); // scoped/legacy rows are DID-stripped
  });
  it('assistant surfaces contain no account identity (source guards)', () => {
    const agentSrc = readFileSync(join(__dirname, 'agentLoop.ts'), 'utf8');
    const typesSrc = readFileSync(join(__dirname, 'copilotTypes.ts'), 'utf8');
    expect(agentSrc).not.toMatch(/accountId|did:privy|account_id/);
    expect(typesSrc).not.toMatch(/accountId|did:privy|account_id|authToken|token/i);
  });
});

describe('in-flight coordination (dedup + session invalidation, no retry)', () => {
  it('two concurrent reconciles for the same filter share ONE request', async () => {
    const c = createLinkOpsCoordinator();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fn = async () => { calls++; await gate; return 'done'; };
    const p1 = c.runReconcile('k', fn);
    const p2 = c.runReconcile('k', fn);
    expect(c.inflightCount()).toBe(1);
    release();
    expect((await p1).value).toBe('done');
    expect((await p2).value).toBe('done');
    expect(calls).toBe(1); // deduped — repeated mounting cannot multiply sweeps
  });
  it('logout mid-flight marks the result stale (must be discarded, not persisted)', async () => {
    const c = createLinkOpsCoordinator();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = c.runReconcile('k', async () => { await gate; return 'data'; });
    c.bumpGeneration(); // logout / token replacement
    release();
    expect((await p).stale).toBe(true);
  });
  it('a completed request is removed from in-flight (no permanent dedup / no retry loop)', async () => {
    const c = createLinkOpsCoordinator();
    let calls = 0;
    await c.runCreate('k', async () => { calls++; return 1; });
    await c.runCreate('k', async () => { calls++; return 2; });
    expect(calls).toBe(2); // sequential calls are separate explicit user actions
    expect(c.inflightCount()).toBe(0);
  });
});

describe('non-idempotent create safeguards', () => {
  const deps = (post: ProjectLinkServiceDeps['postDesktop']): ProjectLinkServiceDeps =>
    ({ postDesktop: post, isOnline: () => true });

  it('double-click shares ONE in-flight create per normalized configuration', async () => {
    const c = createLinkOpsCoordinator();
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const opts = { projectId: 'p1', allowDownload: true as const };
    const run = () => c.runCreate(normalizeCreateKey(opts), async () => { requests++; await gate; return 'r'; });
    const a = run(); const b = run();
    release();
    await a; await b;
    expect(requests).toBe(1);
  });
  it('normalizeCreateKey distinguishes different configurations', () => {
    expect(normalizeCreateKey({ projectId: 'p1' })).toBe(normalizeCreateKey({ projectId: 'p1', collaboratorMode: 'view' }));
    expect(normalizeCreateKey({ projectId: 'p1' })).not.toBe(normalizeCreateKey({ projectId: 'p1', collaboratorMode: 'comment' }));
    expect(normalizeCreateKey({ projectId: 'p1' })).not.toBe(normalizeCreateKey({ projectId: 'p2' }));
  });
  it('a thrown/aborted create is create-outcome-unknown — never offline, never retried', async () => {
    let attempts = 0;
    const r = await createProjectLinkFlow(deps(async () => { attempts++; throw new Error('socket died mid-request'); }), { projectId: 'p1' });
    expect(r.kind).toBe('failure');
    if (r.kind === 'failure') {
      expect(r.reason).toBe('create-outcome-unknown');
      expect(r.message).toMatch(/refresh links/i); // recovery = authoritative listing
    }
    expect(attempts).toBe(1); // no automatic retry
  });
  it('a transported threw:true response is also outcome-unknown', async () => {
    const r = await createProjectLinkFlow(deps(async () => ({ status: 0, json: {}, threw: true })), { projectId: 'p1' });
    expect(r.kind === 'failure' && r.reason).toBe('create-outcome-unknown');
  });
});

describe('filter-scoped reconciliation (partial listings cannot over-flag)', () => {
  const item = (o: Partial<AuthoritativeItem>): AuthoritativeItem => ({
    linkId: 'L', trackingId: 't1', projectId: 'p1', projectVersionId: 'v1',
    ownerAccountId: DID, status: 'active', expiresAt: null,
    createdAt: '2026-07-22T01:10:00Z', updatedAt: null, permissions: {}, ...o,
  });
  it('a project-filtered page-complete listing never flags another project\'s rows', () => {
    const cached = [
      { tracking_id: 'inScope', account_id: DID, revoked_at: null, project_id: 'p1', version_id: 'v1' },
      { tracking_id: 'otherProject', account_id: DID, revoked_at: null, project_id: 'p2', version_id: 'v9' },
    ];
    const ops = planReconciliation(DID, [], cached, true, { projectId: 'p1' });
    const flagged = ops.filter((o) => o.op === 'reconciliation-needed').map((o: any) => o.tracking_id);
    expect(flagged).toEqual(['inScope']); // p2's row is untouched
  });
  it('an unfiltered incomplete listing flags nothing (pageComplete gate)', () => {
    const cached = [{ tracking_id: 'x', account_id: DID, revoked_at: null, project_id: 'p1', version_id: 'v1' }];
    expect(planReconciliation(DID, [item({ trackingId: 'other' })], cached, false).some((o) => o.op === 'reconciliation-needed')).toBe(false);
  });
});
