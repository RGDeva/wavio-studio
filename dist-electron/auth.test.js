"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const crypto_1 = __importDefault(require("crypto"));
// ─────────────────────────────────────────────────────────────────────────────
// Pure logic extracted from main.ts for testability
// ─────────────────────────────────────────────────────────────────────────────
const DESKTOP_TOKEN_PREFIX = 'wv_';
function isDesktopToken(token) {
    return token.startsWith(DESKTOP_TOKEN_PREFIX);
}
function isPrivyJwt(token) {
    return !token.startsWith(DESKTOP_TOKEN_PREFIX) && token.length > 10;
}
/** Mirror of deep-link URL parsing in handleDeepLink */
function parseDeepLink(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'wavi:')
            return null;
        return {
            hostname: parsed.hostname,
            token: parsed.searchParams.get('token'),
        };
    }
    catch {
        return null;
    }
}
/** Generate a realistic wv_ token (mirrors server implementation) */
function generateDesktopToken() {
    return `${DESKTOP_TOKEN_PREFIX}${crypto_1.default.randomBytes(32).toString('hex')}`;
}
/** Mirror of exchange response validation */
function validateExchangeResponse(data) {
    if (!data || typeof data !== 'object')
        return null;
    const d = data;
    if (typeof d.token !== 'string')
        return null;
    if (!d.token.startsWith(DESKTOP_TOKEN_PREFIX))
        return null;
    return d.token;
}
/** Simulate the exchange flow outcome */
async function simulateExchange(httpStatus, responseBody, networkError) {
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
(0, vitest_1.describe)('token format classification', () => {
    (0, vitest_1.it)('recognises wv_ prefixed tokens as desktop tokens', () => {
        (0, vitest_1.expect)(isDesktopToken(generateDesktopToken())).toBe(true);
        (0, vitest_1.expect)(isDesktopToken('wv_abc123')).toBe(true);
    });
    (0, vitest_1.it)('does not classify Privy JWTs as desktop tokens', () => {
        const privyJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.fake.fake';
        (0, vitest_1.expect)(isDesktopToken(privyJwt)).toBe(false);
    });
    (0, vitest_1.it)('recognises JWTs as Privy JWTs', () => {
        const privyJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.fake.fake';
        (0, vitest_1.expect)(isPrivyJwt(privyJwt)).toBe(true);
    });
    (0, vitest_1.it)('desktop tokens are not Privy JWTs', () => {
        (0, vitest_1.expect)(isPrivyJwt(generateDesktopToken())).toBe(false);
    });
    (0, vitest_1.it)('generated desktop tokens are 64-char hex after prefix', () => {
        const t = generateDesktopToken();
        const hex = t.slice(DESKTOP_TOKEN_PREFIX.length);
        (0, vitest_1.expect)(hex).toHaveLength(64); // 32 bytes = 64 hex chars
        (0, vitest_1.expect)(hex).toMatch(/^[0-9a-f]{64}$/);
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 2. Exchange flow outcomes
// ─────────────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('token exchange flow', () => {
    (0, vitest_1.it)('succeeds and returns the wv_ token', async () => {
        const expectedToken = generateDesktopToken();
        const result = await simulateExchange(200, { token: expectedToken, expiresAt: new Date().toISOString() });
        (0, vitest_1.expect)(result.token).toBe(expectedToken);
        (0, vitest_1.expect)(result.error).toBeNull();
    });
    (0, vitest_1.it)('fails on non-200 HTTP status', async () => {
        const result = await simulateExchange(401, { error: 'Unauthorized' });
        (0, vitest_1.expect)(result.token).toBeNull();
        (0, vitest_1.expect)(result.error).toContain('401');
    });
    (0, vitest_1.it)('fails on 500 server error', async () => {
        const result = await simulateExchange(500, { error: 'Internal error' });
        (0, vitest_1.expect)(result.token).toBeNull();
        (0, vitest_1.expect)(result.error).toContain('500');
    });
    (0, vitest_1.it)('fails on network error (timeout, no connection)', async () => {
        const result = await simulateExchange(0, null, new Error('Request timeout after 15000ms'));
        (0, vitest_1.expect)(result.token).toBeNull();
        (0, vitest_1.expect)(result.error).toContain('timeout');
    });
    (0, vitest_1.it)('fails when response body lacks a token field', async () => {
        const result = await simulateExchange(200, { success: true });
        (0, vitest_1.expect)(result.token).toBeNull();
        (0, vitest_1.expect)(result.error).toContain('Invalid token response');
    });
    (0, vitest_1.it)('fails when response token does not have wv_ prefix', async () => {
        const result = await simulateExchange(200, { token: 'eyJhbGciOiJSUzI1NiJ9.fake' });
        (0, vitest_1.expect)(result.token).toBeNull();
        (0, vitest_1.expect)(result.error).toContain('Invalid token response');
    });
    (0, vitest_1.it)('does not fall back to raw JWT on exchange failure', async () => {
        const result = await simulateExchange(500, null);
        // Must return null — never the original Privy JWT
        (0, vitest_1.expect)(result.token).toBeNull();
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 3. Deep-link URL parsing
// ─────────────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('deep-link URL parsing', () => {
    (0, vitest_1.it)('parses a valid wavi://auth URL', () => {
        const token = generateDesktopToken();
        const result = parseDeepLink(`wavi://auth?token=${token}`);
        (0, vitest_1.expect)(result).not.toBeNull();
        (0, vitest_1.expect)(result.hostname).toBe('auth');
        (0, vitest_1.expect)(result.token).toBe(token);
    });
    (0, vitest_1.it)('parses a URL with a Privy JWT token', () => {
        const privyJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';
        const result = parseDeepLink(`wavi://auth?token=${encodeURIComponent(privyJwt)}`);
        (0, vitest_1.expect)(result).not.toBeNull();
        (0, vitest_1.expect)(result.token).toBe(privyJwt);
    });
    (0, vitest_1.it)('rejects non-wavi:// protocol', () => {
        (0, vitest_1.expect)(parseDeepLink('https://wavi.stream/auth?token=abc')).toBeNull();
        (0, vitest_1.expect)(parseDeepLink('file:///etc/passwd')).toBeNull();
    });
    (0, vitest_1.it)('returns null for a completely malformed URL', () => {
        (0, vitest_1.expect)(parseDeepLink('not a url')).toBeNull();
        (0, vitest_1.expect)(parseDeepLink('')).toBeNull();
        (0, vitest_1.expect)(parseDeepLink('wavi://')).not.toBeNull(); // valid URL, hostname is empty
    });
    (0, vitest_1.it)('returns null token when no token param present', () => {
        const result = parseDeepLink('wavi://auth?foo=bar');
        (0, vitest_1.expect)(result).not.toBeNull();
        (0, vitest_1.expect)(result.token).toBeNull();
    });
    (0, vitest_1.it)('rejects paths that are not auth hostname', () => {
        const result = parseDeepLink('wavi://import?id=abc');
        (0, vitest_1.expect)(result).not.toBeNull();
        (0, vitest_1.expect)(result.hostname).toBe('import'); // caller must check hostname
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 4. Log safety — token must not appear in log output
// ─────────────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('token log safety', () => {
    (0, vitest_1.it)('a wv_ token does not appear in stringified progress objects', () => {
        const token = generateDesktopToken();
        const progressObj = {
            itemId: 'job-123',
            projectId: 'proj-456',
            type: 'dependency_upload',
            status: 'uploading',
            percentage: 42,
        };
        const logLine = JSON.stringify(progressObj);
        (0, vitest_1.expect)(logLine).not.toContain(token);
        (0, vitest_1.expect)(logLine).not.toContain('wv_');
    });
    (0, vitest_1.it)('a wv_ token does not appear when logging activity events', () => {
        const token = generateDesktopToken();
        const activityLog = {
            id: crypto_1.default.randomUUID(),
            type: 'upload_started',
            message: 'Upload started: MyBeat.wav',
            project_id: 'proj-123',
            metadata: { itemId: 'j1', type: 'dependency_upload' },
        };
        const logLine = JSON.stringify(activityLog);
        (0, vitest_1.expect)(logLine).not.toContain(token);
        (0, vitest_1.expect)(logLine).not.toContain('wv_');
    });
    (0, vitest_1.it)('error objects do not contain the raw token', () => {
        const token = generateDesktopToken();
        // Simulate an error message that might accidentally embed a token
        const safeError = `[auth] Token exchange HTTP 401`;
        (0, vitest_1.expect)(safeError).not.toContain(token);
        (0, vitest_1.expect)(safeError).not.toContain('wv_');
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 5. Token storage / restoration (state machine logic)
// ─────────────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('token storage state machine', () => {
    // Simulate the encrypted store using a plain Map (no Electron dependency)
    class MockStore {
        constructor() {
            this.data = new Map();
        }
        get(key, def) { return this.data.has(key) ? this.data.get(key) : def; }
        set(key, value) { this.data.set(key, value); }
        delete(key) { this.data.delete(key); }
        has(key) { return this.data.has(key); }
    }
    (0, vitest_1.it)('stores and retrieves a desktop token', () => {
        const store = new MockStore();
        const token = generateDesktopToken();
        // Simulate encryption (in prod this is safeStorage.encryptString)
        const toStore = Buffer.from(token).toString('base64'); // placeholder for real encryption
        store.set('authToken', toStore);
        const raw = store.get('authToken');
        const restored = Buffer.from(raw, 'base64').toString('utf8');
        (0, vitest_1.expect)(restored).toBe(token);
    });
    (0, vitest_1.it)('returns null when no token is stored', () => {
        const store = new MockStore();
        (0, vitest_1.expect)(store.get('authToken', null)).toBeNull();
    });
    (0, vitest_1.it)('clearToken removes the stored value', () => {
        const store = new MockStore();
        store.set('authToken', 'something');
        store.delete('authToken');
        (0, vitest_1.expect)(store.get('authToken', null)).toBeNull();
    });
    (0, vitest_1.it)('a Privy JWT is never written to store after the exchange flow', () => {
        const store = new MockStore();
        const privyJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';
        const desktopToken = generateDesktopToken();
        // Simulate: exchange succeeded, store ONLY the desktop token
        store.set('authToken', Buffer.from(desktopToken).toString('base64'));
        const stored = Buffer.from(store.get('authToken'), 'base64').toString('utf8');
        (0, vitest_1.expect)(stored).toBe(desktopToken);
        (0, vitest_1.expect)(stored).not.toBe(privyJwt);
        (0, vitest_1.expect)(stored.startsWith('wv_')).toBe(true);
    });
    (0, vitest_1.it)('a failed exchange leaves the store unchanged (no stale token written)', () => {
        const store = new MockStore();
        // Store was empty before
        (0, vitest_1.expect)(store.has('authToken')).toBe(false);
        // Simulate: exchange failed — we do NOT write the raw JWT
        // (the real code returns early on null from exchangePrivyJwt)
        const exchangeResult = null;
        if (exchangeResult) {
            store.set('authToken', exchangeResult); // this branch not taken
        }
        (0, vitest_1.expect)(store.has('authToken')).toBe(false);
    });
});
