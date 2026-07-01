import { describe, it, expect, afterEach, vi } from 'vitest';

// config.ts (and the package.json waviQaDefaults it reads) computes every
// exported value ONCE at module-load time, so each test case needs a fresh
// module instance with the desired env vars already set before import.
//
// NODE_ENV is deliberately left as 'development' in every case here: WEB_BASE
// / API_BASE resolution (what this suite verifies) doesn't depend on it, and
// using 'production' would additionally exercise config.ts's CHANNEL export,
// which requires('electron') — outside the scope of this suite and covered
// separately by deepLinkValidator.test.ts's resolveChannel() tests.
async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  const prevEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('WAVI_')) delete (process.env as any)[key];
  }
  Object.assign(process.env, { NODE_ENV: 'development' }, env);
  try {
    return await import('./config');
  } finally {
    process.env = prevEnv;
  }
}

describe('WEB_BASE — single source of truth for generated link base URLs', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('with no overrides resolves to production https://wavi.stream', async () => {
    const { WEB_BASE, API_BASE } = await loadConfig({});
    expect(WEB_BASE).toBe('https://wavi.stream');
    expect(API_BASE).toBe('https://wavi.stream/api');
  });

  it('honors an explicit WAVI_PUBLIC_URL override (e.g. QA env var)', async () => {
    const { WEB_BASE } = await loadConfig({
      WAVI_PUBLIC_URL: 'https://wavio-pe463fc1i-rgdevas-projects.vercel.app',
    });
    expect(WEB_BASE).toBe('https://wavio-pe463fc1i-rgdevas-projects.vercel.app');
  });

  it('derives WEB_BASE from a preview API_BASE when no explicit WAVI_PUBLIC_URL is set', async () => {
    const { WEB_BASE, API_BASE } = await loadConfig({
      WAVI_API_BASE_URL: 'https://wavio-pe463fc1i-rgdevas-projects.vercel.app/api',
    });
    // Must match the SAME deployment as API_BASE — this is the exact bug class
    // from the QA report: apiBase and publicUrl pointing at different deployments.
    expect(WEB_BASE).toBe('https://wavio-pe463fc1i-rgdevas-projects.vercel.app');
    expect(API_BASE.startsWith(WEB_BASE)).toBe(true);
  });

  it('never falls back to a stale hardcoded deployment alias when unconfigured', async () => {
    const { WEB_BASE } = await loadConfig({});
    expect(WEB_BASE).not.toMatch(/wavio-git-/);
    expect(WEB_BASE).toBe('https://wavi.stream');
  });

  it('when QA defaults are baked in, WEB_BASE and API_BASE target the SAME deployment', async () => {
    // Simulates the QA app boot where electron-builder.qa.json bakes
    // waviQaDefaults.apiBase and waviQaDefaults.publicUrl into package.json.
    // The critical invariant: every generated URL (Project Link, preview, archive,
    // resolver) must share the same origin so there is no stale-alias mismatch.
    const qaApiBase = 'https://wavio-aacwv9b08-rgdevas-projects.vercel.app/api';
    const qaPublicUrl = 'https://wavio-aacwv9b08-rgdevas-projects.vercel.app';
    const { WEB_BASE, API_BASE } = await loadConfig({
      WAVI_PUBLIC_URL: qaPublicUrl,
      WAVI_API_BASE_URL: qaApiBase,
    });
    expect(WEB_BASE).toBe(qaPublicUrl);
    expect(API_BASE).toBe(qaApiBase);
    // The web base must be a strict prefix of API_BASE to avoid cross-deployment URLs
    expect(API_BASE.startsWith(WEB_BASE)).toBe(true);
    // Neither must reference the old stale deployment alias
    expect(WEB_BASE).not.toContain('wavio-3ex7vi5zq');
    expect(API_BASE).not.toContain('wavio-3ex7vi5zq');
  });
});
