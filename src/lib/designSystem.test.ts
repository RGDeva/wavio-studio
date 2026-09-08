/**
 * P3-1d — design-system invariants.
 *
 * This is polish work, so the risk is not that a feature breaks; it is that the
 * system silently erodes back into ad-hoc values. These tests pin the vocabulary
 * so the next contributor gets a failure rather than a slow drift.
 *
 * They are static assertions over source. Visual confirmation still needs a run
 * of the app, which this host cannot do (see ENV-1 in the handoff doc) — that is
 * recorded honestly rather than implied by a passing suite.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TEXT_MAP, CONTRAST_REPAIRED, SIZE_MAP } from '../../scripts/ui-token-map.mjs';

const ROOT = path.resolve(__dirname, '../..');

function tsxFiles(dir = path.join(ROOT, 'src')): string[] {
  const out: string[] = [];
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); }
      else if (f.endsWith('.tsx')) out.push(f);
    }
  })(dir);
  return out;
}
const ALL = tsxFiles().map((f) => ({ rel: path.relative(ROOT, f), body: fs.readFileSync(f, 'utf8') }));

describe('no ad-hoc colour values survive', () => {
  it('no raw white/opacity utilities anywhere in the renderer', () => {
    // 635 of these existed before P3-1d, across 38 distinct opacities.
    const offenders = ALL.filter((f) => /(text|bg|border)-white\/\[?[0-9.]+\]?/.test(f.body));
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  it('no raw Tailwind palette colours — status meaning comes from tokens', () => {
    const re = /(bg|text|border)-(emerald|red|green|amber|blue|yellow|orange|cyan|purple|violet)-[0-9]{3}/;
    const offenders = ALL.filter((f) => re.test(f.body));
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  it('no type below the readable floor', () => {
    const offenders = ALL.filter((f) => /text-\[(8|9|10)px\]/.test(f.body));
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });
});

describe('the token vocabulary is defined once', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'src/design/tokens.css'), 'utf8');
  const tw = fs.readFileSync(path.join(ROOT, 'tailwind.config.js'), 'utf8');

  it('declares the five-step text hierarchy and nothing more', () => {
    for (const t of ['--fg:', '--fg-secondary:', '--fg-tertiary:', '--fg-quaternary:', '--fg-disabled:']) {
      expect(tokens, t).toContain(t);
    }
    const steps = [...tokens.matchAll(/^\s*--fg(-[a-z]+)?:/gm)].length;
    expect(steps, 'a sixth step means the layout is doing the hierarchy\'s job').toBe(5);
  });

  it('declares the named type scale', () => {
    for (const t of ['--text-meta:', '--text-body:', '--text-title:', '--text-heading:']) {
      expect(tokens, t).toContain(t);
    }
  });

  it('exposes the hierarchy and scale through Tailwind', () => {
    for (const k of ['fg:', 'secondary:', 'tertiary:', 'quaternary:', 'disabled:']) expect(tw).toContain(k);
    for (const k of ['meta:', 'body:', 'title:', 'heading:']) expect(tw).toContain(k);
    for (const k of ['layer-1', 'layer-2', 'layer-3', 'layer-4', 'hairline']) expect(tw).toContain(k);
  });
});

describe('the contrast repair is deliberate and recorded', () => {
  it('every low opacity maps up to the readable tier, never to disabled', () => {
    // The old values rendered meaningful labels below a readable ratio on
    // near-black. Mapping them to `disabled` would have preserved the defect
    // under a nicer name.
    for (const op of CONTRAST_REPAIRED) {
      expect(TEXT_MAP[op], String(op)).toBe('text-fg-quaternary');
    }
  });

  it('quaternary sits well above the opacities it replaced', () => {
    const tokens = fs.readFileSync(path.join(ROOT, 'src/design/tokens.css'), 'utf8');
    const m = tokens.match(/--fg-quaternary:\s*0 0% (\d+)%/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(45);
  });

  it('the size map only ever raises size', () => {
    for (const [from, to] of Object.entries(SIZE_MAP)) {
      const px = Number(from.match(/(\d+)px/)![1]);
      expect(to).toBe('text-meta');   // 11px floor
      expect(px).toBeLessThanOrEqual(11);
    }
  });
});

describe('the mapping is reviewable, not buried in a one-off command', () => {
  it('lives in a committed module a human can read and a test can pin', () => {
    expect(fs.existsSync(path.join(ROOT, 'scripts/ui-token-map.mjs'))).toBe(true);
    expect(Object.keys(TEXT_MAP).length).toBeGreaterThan(10);
  });
});
