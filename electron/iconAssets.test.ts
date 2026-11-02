/**
 * The app icon is a real icon, not the logo in a square.
 *
 * The defect this exists to catch: `public/icon.png` used to be the full Wavi
 * WORDMARK — a wide logo centred in a 1024×1024 transparent canvas with ~70%
 * of the tile empty. It is a perfectly good logo and a bad app icon: in the
 * Dock it renders as a sliver of unreadable text, and at 32px it is a smudge.
 *
 * Asserting "a file exists and is bigger than 1KB" would not have caught that,
 * because the wordmark passed exactly those checks. So these assert the
 * properties that actually distinguish an icon from a logo.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
// @ts-expect-error — plain ESM generator shared with `npm run icon:generate`
import { renderIcon, encodePng } from '../scripts/make-icon.mjs';

const ROOT = join(__dirname, '..');
const ICON = join(ROOT, 'public', 'icon.png');

/** Width/height straight out of the PNG IHDR. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('the macOS icon master', () => {
  it('exists and is the 1024×1024 square macOS wants', () => {
    expect(existsSync(ICON)).toBe(true);
    expect(statSync(ICON).size).toBeGreaterThan(1000);
    const { width, height } = pngSize(readFileSync(ICON));
    expect(width).toBe(1024);
    expect(height).toBe(1024);
  });

  it('is exactly what the generator produces, byte for byte', () => {
    // Provenance and drift in one assertion: the committed icon cannot be a
    // stale export someone dropped in, and `npm run icon:generate` cannot
    // quietly start producing something else.
    const committed = readFileSync(ICON);
    const generated = encodePng(renderIcon(1024), 1024) as Buffer;
    expect(createHash('sha256').update(committed).digest('hex'))
      .toBe(createHash('sha256').update(generated).digest('hex'));
  });

  it('the generator is deterministic', () => {
    // An icon that regenerates differently each build would churn the repo and
    // make the byte-for-byte check above useless.
    const a = encodePng(renderIcon(256), 256) as Buffer;
    const b = encodePng(renderIcon(256), 256) as Buffer;
    expect(a.equals(b)).toBe(true);
  });

  it('fills its tile — the wordmark defect, stated as a property', () => {
    // The mark must occupy a serious fraction of the canvas. The old wordmark
    // left roughly 70% of the tile empty; a real icon does not.
    const px = renderIcon(256) as Buffer;
    let opaque = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 200) opaque++;
    const coverage = opaque / (256 * 256);
    expect(coverage).toBeGreaterThan(0.55);
  });

  it('is not a white rectangle — it carries the brand gradient', () => {
    // Guards against a regression to flat art: the tile must actually vary in
    // colour across its diagonal.
    const size = 256;
    const px = renderIcon(size) as Buffer;
    const at = (x: number, y: number) => {
      const i = (y * size + x) * 4;
      return [px[i], px[i + 1], px[i + 2]];
    };
    const tl = at(Math.round(size * 0.22), Math.round(size * 0.22));
    const br = at(Math.round(size * 0.78), Math.round(size * 0.78));
    const delta = Math.abs(tl[0] - br[0]) + Math.abs(tl[1] - br[1]) + Math.abs(tl[2] - br[2]);
    expect(delta).toBeGreaterThan(60);
  });
});

describe('packaging points at the icon master', () => {
  it('every mac build config uses the 1024 PNG, from which electron-builder derives the .icns', () => {
    // Previously these pointed at a committed public/icon.icns built from the
    // wordmark. One stale binary overriding the real art is exactly the kind
    // of thing nobody notices until a user sees the Dock.
    for (const f of ['package.json', 'electron-builder.qa.json', 'electron-builder.staging.json']) {
      const cfg = JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
      const mac = f === 'package.json' ? cfg.build.mac : cfg.mac;
      expect(mac.icon, `${f} mac.icon`).toBe('public/icon.png');
    }
  });

  it('the stale wordmark .icns is gone, so it cannot be pointed at again', () => {
    expect(existsSync(join(ROOT, 'public', 'icon.icns'))).toBe(false);
  });

  it('the wordmark is kept for in-app use, where it belongs', () => {
    expect(existsSync(join(ROOT, 'public', 'icon-wordmark.png'))).toBe(true);
  });

  it('appId/productName remain the Wavi product identity, not Electron defaults', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.build.productName).toBe('Wavi Studio');
    expect(pkg.build.appId).not.toMatch(/electron/i);
    // Production retains the already-distributed bundle id — see deepLinkValidator.ts BUNDLE_IDS.
    expect(pkg.build.appId).toBe('com.wavi.studio');
  });
});

describe('QA build userData isolation (electron-builder.qa.json)', () => {
  it('the QA build config declares waviQaDefaults, used to detect a QA build independent of env vars', () => {
    const qaConfig = JSON.parse(readFileSync(join(ROOT, 'electron-builder.qa.json'), 'utf8'));
    expect(qaConfig.extraMetadata?.waviQaDefaults?.apiBase).toMatch(/^https:\/\//);
    expect(qaConfig.extraMetadata?.waviQaDefaults?.publicUrl).toMatch(/^https:\/\//);
    // appId must differ from production so it never shares a default userData
    // directory — see the incident note in deepLinkValidator.ts BUNDLE_IDS.
    expect(qaConfig.appId).not.toBe('com.wavi.studio');
  });
});
