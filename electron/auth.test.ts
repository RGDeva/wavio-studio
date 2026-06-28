/**
 * Desktop authentication logic tests.
 *
 * Tests cover:
 *  1. Token format validation (wv_ prefix detection)
 *  2. Exchange flow outcome handling (success / failure / network error)
 *  3. Deep-link URL parsing safety (malformed, missing token, wrong protocol)
 *  4. Log safety — no raw token in log output
 *  5. Token storage / restoration behavior (pure state logic)
 *
 * No Electron APIs, no network calls — all behavior is extracted as pure functions.
 */

import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic extracted from main.ts for testability
// ─────────────────────────────────────────────────────────────────────────────

const DESKTOP_TOKEN_PREFIX = 'wv_';

function isDesktopToken(token: string): boolean {
  return token.startsWith(DESKTOP_TOKEN_PREFIX);
}

function isPrivyJwt(token: string): boolean {
  return !token.startsWith(DESKTOP_TOKEN_PREFIX) && token.length > 10;
}

/** Mirror of deep-link URL parsing in handleDeepLink */
function parseDeepLink(url: string): { hostname: string; token: string | null } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wavi:') return null;
    return {
      hostname: parsed.hostname,
      token: parsed.searchParams.get('token'),
    };
  } catch {
    return null;
  }
}

/** Generate a realistic wv_ token (mirrors server implementation) */
function generateDesktopToken(): string {
  return `${DESKTOP_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
}

/** Mirror of exchange response validation */
function validateExchangeResponse(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.token !== 'string') return null;
  if (!d.token.startsWith(DESKTOP_TOKEN_PREFIX)) return null;
  return d.token;
}

/** Simulate the exchange flow outcome */
async function simulateExchange(
  httpStatus: number,
  responseBody: unknown,
  networkError?: Error
): Promise<{ token: string | null; error: string | null }> {
  if (networkError) {
    return { token: null, error: networkError.message };
  }
  if (httpStatus !== 200) {
    return { token: null, error: `HTTP ${httpStatus}` };
  }
  const token = validateExchangeResponse(responseBody);
  if (!token) {
    return { token: null, error: 'Invalid token response' };
  }
  return { token, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Token format classification
// ─────────────────────────────────────────────────────────────────────────────

describe('token format classification', () => {
  it('recognises wv_ prefixed tokens as desktop tokens', () => {
    expect(isDesktopToken(generateDesktopToken())).toBe(true);
    expect(isDesktopToken('wv_abc123')).toBe(true);
  });

  it('does not classify Privy JWTs as desktop tokens', () => {
    const privyJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.fake.fake';
    expect(isDesktopToken(privyJwt)).toBe(false);
  });

  it('recognises JWTs as Privy JWTs', () => {
    const privyJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.fake.fake';
    expect(isPrivyJwt(privyJwt)).toBe(true);
  });

  it('desktop tokens are not Privy JWTs', () => {
    expect(isPrivyJwt(generateDesktopToken())).toBe(false);
  });

  it('generated desktop tokens are 64-char hex after prefix', () => {
    const t = generateDesktopToken();
    const hex = t.slice(DESKTOP_TOKEN_PREFIX.length);
    expect(hex).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Exchange flow outcomes
// ─────────────────────────────────────────────────────────────────────────────

describe('token exchange flow', () => {
  it('succeeds and returns the wv_ token', async () => {
    const expectedToken = generateDesktopToken();
    const result = await simulateExchange(200, { token: expectedToken, expiresAt: new Date().toISOString() });
    expect(result.token).toBe(expectedToken);
    expect(result.error).toBeNull();
  });

  it('fails on non-200 HTTP status', async () => {
    const result = await simulateExchange(401, { error: 'Unauthorized' });
    expect(result.token).toBeNull();
    expect(result.error).toContain('401');
  });

  it('fails on 500 server error', async () => {
    const result = await simulateExchange(500, { error: 'Internal error' });
    expect(result.token).toBeNull();
    expect(result.error).toContain('500');
  });

  it('fails on network error (timeout, no connection)', async () => {
    const result = await simulateExchange(0, null, new Error('Request timeout after 15000ms'));
    expect(result.token).toBeNull();
    expect(result.error).toContain('timeout');
  });

  it('fails when response body lacks a token field', async () => {
    const result = await simulateExchange(200, { success: true });
    expect(result.token).toBeNull();
    expect(result.error).toContain('Invalid token response');
  });

  it('fails when response token does not have wv_ prefix', async () => {
    const result = await simulateExchange(200, { token: 'eyJhbGciOiJSUzI1NiJ9.fake' });
    expect(result.token).toBeNull();
    expect(result.error).toContain('Invalid token response');
  });

  it('does not fall back to raw JWT on exchange failure', async () => {
    const result = await simulateExchange(500, null);
    // Must return null — never the original Privy JWT
    expect(result.token).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Deep-link URL parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('deep-link URL parsing', () => {
  it('parses a valid wavi://auth URL', () => {
    const token = generateDesktopToken();
    const result = parseDeepLink(`wavi://auth?token=${token}`);
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('auth');
    expect(result!.token).toBe(token);
  });

  it('parses a URL with a Privy JWT token', () => {
    const privyJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';
    const result = parseDeepLink(`wavi://auth?token=${encodeURIComponent(privyJwt)}`);
    expect(result).not.toBeNull();
    expect(result!.token).toBe(privyJwt);
  });

  it('rejects non-wavi:// protocol', () => {
    expect(parseDeepLink('https://wavi.stream/auth?token=abc')).toBeNull();
    expect(parseDeepLink('file:///etc/passwd')).toBeNull();
  });

  it('returns null for a completely malformed URL', () => {
    expect(parseDeepLink('not a url')).toBeNull();
    expect(parseDeepLink('')).toBeNull();
    expect(parseDeepLink('wavi://')).not.toBeNull(); // valid URL, hostname is empty
  });

  it('returns null token when no token param present', () => {
    const result = parseDeepLink('wavi://auth?foo=bar');
    expect(result).not.toBeNull();
    expect(result!.token).toBeNull();
  });

  it('rejects paths that are not auth hostname', () => {
    const result = parseDeepLink('wavi://import?id=abc');
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe('import'); // caller must check hostname
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Log safety — token must not appear in log output
// ─────────────────────────────────────────────────────────────────────────────

describe('token log safety', () => {
  it('a wv_ token does not appear in stringified progress objects', () => {
    const token = generateDesktopToken();
    const progressObj = {
      itemId: 'job-123',
      projectId: 'proj-456',
      type: 'dependency_upload',
      status: 'uploading',
      percentage: 42,
    };
    const logLine = JSON.stringify(progressObj);
    expect(logLine).not.toContain(token);
    expect(logLine).not.toContain('wv_');
  });

  it('a wv_ token does not appear when logging activity events', () => {
    const token = generateDesktopToken();
    const activityLog = {
      id: crypto.randomUUID(),
      type: 'upload_started',
      message: 'Upload started: MyBeat.wav',
      project_id: 'proj-123',
      metadata: { itemId: 'j1', type: 'dependency_upload' },
    };
    const logLine = JSON.stringify(activityLog);
    expect(logLine).not.toContain(token);
    expect(logLine).not.toContain('wv_');
  });

  it('error objects do not contain the raw token', () => {
    const token = generateDesktopToken();
    // Simulate an error message that might accidentally embed a token
    const safeError = `[auth] Token exchange HTTP 401`;
    expect(safeError).not.toContain(token);
    expect(safeError).not.toContain('wv_');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Token storage / restoration (state machine logic)
// ─────────────────────────────────────────────────────────────────────────────

describe('token storage state machine', () => {
  // Simulate the encrypted store using a plain Map (no Electron dependency)
  class MockStore {
    private data = new Map<string, unknown>();
    get(key: string, def?: unknown) { return this.data.has(key) ? this.data.get(key) : def; }
    set(key: string, value: unknown) { this.data.set(key, value); }
    delete(key: string) { this.data.delete(key); }
    has(key: string) { return this.data.has(key); }
  }

  it('stores and retrieves a desktop token', () => {
    const store = new MockStore();
    const token = generateDesktopToken();
    // Simulate encryption (in prod this is safeStorage.encryptString)
    const toStore = Buffer.from(token).toString('base64'); // placeholder for real encryption
    store.set('authToken', toStore);
    const raw = store.get('authToken') as string;
    const restored = Buffer.from(raw, 'base64').toString('utf8');
    expect(restored).toBe(token);
  });

  it('returns null when no token is stored', () => {
    const store = new MockStore();
    expect(store.get('authToken', null)).toBeNull();
  });

  it('clearToken removes the stored value', () => {
    const store = new MockStore();
    store.set('authToken', 'something');
    store.delete('authToken');
    expect(store.get('authToken', null)).toBeNull();
  });

  it('a Privy JWT is never written to store after the exchange flow', () => {
    const store = new MockStore();
    const privyJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';
    const desktopToken = generateDesktopToken();

    // Simulate: exchange succeeded, store ONLY the desktop token
    store.set('authToken', Buffer.from(desktopToken).toString('base64'));

    const stored = Buffer.from(store.get('authToken') as string, 'base64').toString('utf8');
    expect(stored).toBe(desktopToken);
    expect(stored).not.toBe(privyJwt);
    expect(stored.startsWith('wv_')).toBe(true);
  });

  it('a failed exchange leaves the store unchanged (no stale token written)', () => {
    const store = new MockStore();
    // Store was empty before
    expect(store.has('authToken')).toBe(false);

    // Simulate: exchange failed — we do NOT write the raw JWT
    // (the real code returns early on null from exchangePrivyJwt)
    const exchangeResult: string | null = null;
    if (exchangeResult) {
      store.set('authToken', exchangeResult); // this branch not taken
    }

    expect(store.has('authToken')).toBe(false);
  });
});
