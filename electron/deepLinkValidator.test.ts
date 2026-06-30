import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  resolveChannel,
  validateDeepLink,
  checkAndRecordReplay,
  PROTOCOL_SCHEMES,
  BUNDLE_IDS,
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
