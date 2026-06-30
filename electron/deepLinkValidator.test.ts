import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  resolveChannel,
  validateDeepLink,
  checkAndRecordReplay,
  PROTOCOL_SCHEMES,
  BUNDLE_IDS,
  APP_NAMES,
  isQaBuildFromPackageJson,
  assertNotProductionUserDataDir,
} from './deepLinkValidator';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('resolveChannel — environment → channel mapping', () => {
  it('dev build always resolves to development regardless of API override', () => {
    expect(resolveChannel({ isDev: true, isDevApi: false })).toBe('development');
    expect(resolveChannel({ isDev: true, isDevApi: true })).toBe('development');
  });

  it('packaged build with a non-production API base resolves to qa', () => {
    expect(resolveChannel({ isDev: false, isDevApi: true })).toBe('qa');
  });

  it('packaged build with no API override resolves to production', () => {
    expect(resolveChannel({ isDev: false, isDevApi: false })).toBe('production');
  });
});

describe('assertNotProductionUserDataDir — last-resort safety net', () => {
  const prodDir = '/Users/x/Library/Application Support/wavio-studio';
  const qaDir = '/Users/x/Library/Application Support/wavio-studio-qa';

  it('is a no-op for a genuine production build, even if paths somehow match', () => {
    expect(assertNotProductionUserDataDir({
      channel: 'production',
      resolvedUserDataDir: prodDir,
      productionUserDataDir: prodDir,
    })).toBeNull();
  });

  it('passes when a QA build correctly resolved to its own directory', () => {
    expect(assertNotProductionUserDataDir({
      channel: 'qa',
      resolvedUserDataDir: qaDir,
      productionUserDataDir: prodDir,
    })).toBeNull();
  });

  it('FATALs when a QA build resolved to the production directory (the incident scenario)', () => {
    const result = assertNotProductionUserDataDir({
      channel: 'qa',
      resolvedUserDataDir: prodDir,
      productionUserDataDir: prodDir,
    });
    expect(result).not.toBeNull();
    expect(result).toMatch(/FATAL/);
    expect(result).toMatch(/qa/);
  });

  it('FATALs when a development build resolved to the production directory', () => {
    const result = assertNotProductionUserDataDir({
      channel: 'development',
      resolvedUserDataDir: prodDir,
      productionUserDataDir: prodDir,
    });
    expect(result).not.toBeNull();
    expect(result).toMatch(/FATAL/);
  });
});

describe('APP_NAMES — userData directory isolation', () => {
  it('every channel has a distinct app name (no two channels can share a default userData dir)', () => {
    const names = Object.values(APP_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });

  it('production keeps the already-distributed default app name', () => {
    expect(APP_NAMES.production).toBe('wavio-studio');
  });

  it('QA and development both differ from production', () => {
    expect(APP_NAMES.qa).not.toBe(APP_NAMES.production);
    expect(APP_NAMES.development).not.toBe(APP_NAMES.production);
  });
});

describe('isQaBuildFromPackageJson', () => {
  it('detects a QA build via the baked waviQaDefaults marker', () => {
    expect(isQaBuildFromPackageJson({ waviQaDefaults: { apiBase: 'x', publicUrl: 'y' } })).toBe(true);
  });

  it('a production package.json (no marker) is not detected as QA', () => {
    expect(isQaBuildFromPackageJson({})).toBe(false);
  });

  it('does not depend on any env var — pure function of the package.json shape', () => {
    // Regression guard for the incident: a real cold launch carries no env
    // vars, so this detection must work from package.json content alone.
    const originalEnv = { ...process.env };
    delete process.env.WAVI_QA_OVERRIDE;
    delete process.env.WAVI_USER_DATA_DIR;
    expect(isQaBuildFromPackageJson({ waviQaDefaults: { apiBase: 'x' } })).toBe(true);
    process.env = originalEnv;
  });
});

describe('environment → protocol scheme / bundle id mapping', () => {
  it('maps each channel to its own scheme', () => {
    expect(PROTOCOL_SCHEMES.production).toBe('wavi');
    expect(PROTOCOL_SCHEMES.qa).toBe('wavi-qa');
    expect(PROTOCOL_SCHEMES.development).toBe('wavi-dev');
  });

  it('maps each channel to its own bundle id', () => {
    expect(BUNDLE_IDS.production).toBe('com.wavi.studio');
    expect(BUNDLE_IDS.qa).toBe('stream.wavi.studio.qa');
    expect(BUNDLE_IDS.development).toBe('stream.wavi.studio.dev');
  });
});

describe('validateDeepLink', () => {
  it('accepts a well-formed production callback', () => {
    const r = validateDeepLink('wavi://auth/callback?token=abcdefghijklmnop', 'wavi');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe('abcdefghijklmnop');
  });

  it('accepts a well-formed QA callback against the qa scheme', () => {
    const r = validateDeepLink('wavi-qa://auth/callback?token=abcdefghijklmnop', 'wavi-qa');
    expect(r.ok).toBe(true);
  });

  it('production build rejects a QA-scheme callback', () => {
    const r = validateDeepLink('wavi-qa://auth/callback?token=abcdefghijklmnop', 'wavi');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('scheme-mismatch');
  });

  it('QA build rejects a production-scheme callback', () => {
    const r = validateDeepLink('wavi://auth/callback?token=abcdefghijklmnop', 'wavi-qa');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('scheme-mismatch');
  });

  it('rejects a malformed callback path (wrong host)', () => {
    const r = validateDeepLink('wavi://not-auth/callback?token=abcdefghijklmnop', 'wavi');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed-path');
  });

  it('rejects a malformed callback path (wrong subpath)', () => {
    const r = validateDeepLink('wavi://auth/something-else?token=abcdefghijklmnop', 'wavi');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed-path');
  });

  it('accepts the legacy bare-host path for backward compatibility', () => {
    const r = validateDeepLink('wavi://auth?token=abcdefghijklmnop', 'wavi');
    expect(r.ok).toBe(true);
  });

  it('rejects a missing credential', () => {
    const r = validateDeepLink('wavi://auth/callback', 'wavi');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing-credential');
  });

  it('rejects a too-short credential', () => {
    const r = validateDeepLink('wavi://auth/callback?token=short', 'wavi');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing-credential');
  });

  it('rejects an unparseable URL', () => {
    const r = validateDeepLink('not a url at all', 'wavi');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-url');
  });
});

describe('checkAndRecordReplay', () => {
  it('first use of a token is not a replay', () => {
    const seen = new Set<string>();
    expect(checkAndRecordReplay('token-a', seen, sha256)).toBe(false);
  });

  it('second use of the same token is flagged as a replay', () => {
    const seen = new Set<string>();
    checkAndRecordReplay('token-a', seen, sha256);
    expect(checkAndRecordReplay('token-a', seen, sha256)).toBe(true);
  });

  it('different tokens are independently tracked', () => {
    const seen = new Set<string>();
    expect(checkAndRecordReplay('token-a', seen, sha256)).toBe(false);
    expect(checkAndRecordReplay('token-b', seen, sha256)).toBe(false);
    expect(checkAndRecordReplay('token-a', seen, sha256)).toBe(true);
  });

  it('caps set size so it cannot grow unbounded', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) checkAndRecordReplay(`token-${i}`, seen, sha256, 50);
    expect(seen.size).toBeLessThanOrEqual(50);
  });
});
