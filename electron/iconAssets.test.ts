import { describe, it, expect } from 'vitest';
import { existsSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

describe('official icon assets exist for packaging', () => {
  it('public/icon.icns exists for macOS packaging', () => {
    const p = join(ROOT, 'public', 'icon.icns');
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(1000);
  });

  it('public/icon.png exists (in-app logo + Linux/Electron fallback)', () => {
    const p = join(ROOT, 'public', 'icon.png');
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(1000);
  });

  it('package.json build.mac.icon points at the official icon', () => {
    const pkg = require(join(ROOT, 'package.json'));
    expect(pkg.build.mac.icon).toBe('public/icon.icns');
  });

  it('package.json appId/productName are set to the Wavi product identity, not Electron defaults', () => {
    const pkg = require(join(ROOT, 'package.json'));
    expect(pkg.build.productName).toBe('Wavi Studio');
    expect(pkg.build.appId).not.toMatch(/electron/i);
    // Production retains the already-distributed bundle id — see deepLinkValidator.ts BUNDLE_IDS comment.
    expect(pkg.build.appId).toBe('com.wavi.studio');
  });
});
