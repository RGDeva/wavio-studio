/**
 * SPIKE ONLY — proves the DAWproject adoption concept on real upstream input.
 * Fixture: the Bitwig-authored example project.xml from the dawproject README
 * (upstream commit ee4dcdde75940f30e14e55401a26955a58b8322b). NOT production.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseXml, writeXml, assertNoDoctype, XmlSecurityError, XmlNode } from './miniXml';

const fixture = readFileSync(join(__dirname, '__fixtures__', 'bitwig-example.project.xml'), 'utf8');

// Minimal semantic extraction — the shape a real reader would map into the
// Session IR. Proves the interchange fields survive parse.
interface MiniIR {
  version: string;
  application: { name: string; version: string };
  tempo?: number;
  timeSig?: { num: number; denom: number };
  tracks: { id: string; name: string; contentType?: string }[];
  noteCount: number;
  warpCount: number;
}

function toIR(root: XmlNode): MiniIR {
  const find = (n: XmlNode, tag: string): XmlNode | undefined => {
    if (n.tag === tag) return n;
    for (const c of n.children) { const r = find(c, tag); if (r) return r; }
    return undefined;
  };
  const findAll = (n: XmlNode, tag: string, acc: XmlNode[] = []): XmlNode[] => {
    if (n.tag === tag) acc.push(n);
    for (const c of n.children) findAll(c, tag, acc);
    return acc;
  };
  const app = find(root, 'Application')!;
  const tempo = find(root, 'Tempo');
  const ts = find(root, 'TimeSignature');
  // top-level tracks under Structure
  const structure = root.children.find((c) => c.tag === 'Structure');
  const tracks = (structure?.children ?? []).filter((c) => c.tag === 'Track').map((t) => ({
    id: t.attrs.id, name: t.attrs.name, contentType: t.attrs.contentType,
  }));
  return {
    version: root.attrs.version,
    application: { name: app.attrs.name, version: app.attrs.version },
    tempo: tempo ? parseFloat(tempo.attrs.value) : undefined,
    timeSig: ts ? { num: parseInt(ts.attrs.numerator), denom: parseInt(ts.attrs.denominator) } : undefined,
    tracks,
    noteCount: findAll(root, 'Note').length,
    warpCount: findAll(root, 'Warp').length,
  };
}

describe('DAWproject spike — round-trip of the Bitwig example', () => {
  it('parses the real upstream fixture into a semantic IR', () => {
    const ir = toIR(parseXml(fixture));
    expect(ir.version).toBe('1.0');
    expect(ir.application).toEqual({ name: 'Bitwig Studio', version: '5.0' });
    expect(ir.tempo).toBeCloseTo(149.0, 3);
    expect(ir.timeSig).toEqual({ num: 4, denom: 4 });
    expect(ir.tracks.map((t) => t.name)).toEqual(['Bass', 'Drumloop', 'Master']);
    expect(ir.noteCount).toBe(9);   // the Bass MIDI clip
    expect(ir.warpCount).toBe(2);   // the Drumloop audio warp markers
  });

  it('re-emits and re-parses with identical semantic content (lossless round-trip)', () => {
    const ir1 = toIR(parseXml(fixture));
    const reemitted = writeXml(parseXml(fixture));
    const ir2 = toIR(parseXml(reemitted));
    expect(ir2).toEqual(ir1);
  });

  it('preserves warp markers — a field the v1 JSON schema called "not convertible"', () => {
    const ir = toIR(parseXml(fixture));
    // Evidence for DR-015: DAWproject represents warping directly.
    expect(ir.warpCount).toBeGreaterThan(0);
  });
});

describe('DAWproject spike — security rejection', () => {
  it('rejects a DOCTYPE/XXE payload before parsing', () => {
    const xxe = `<?xml version="1.0"?>
      <!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
      <Project version="1.0">&xxe;</Project>`;
    expect(() => assertNoDoctype(xxe)).toThrow(XmlSecurityError);
    expect(() => parseXml(xxe)).toThrow(XmlSecurityError);
  });

  it('rejects pathologically deep nesting (depth cap)', () => {
    const deep = '<a>'.repeat(100) + '</a>'.repeat(100);
    expect(() => parseXml(`<Root>${deep}</Root>`)).toThrow(XmlSecurityError);
  });
});
