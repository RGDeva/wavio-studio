/**
 * Portable cross-DAW handoff v1 — the golden paths, against a real filesystem.
 *
 * These run in a real temporary directory because the claims worth proving are
 * filesystem claims: that the derived checkout exists, that the original is
 * untouched, that a truncated write or a disagreeing checksum does not become
 * a silent success, and that no `.flp` is ever conjured from an `.als`.
 *
 * What is NOT tested here is any DAW. Nothing opens Ableton, FL, Logic, Pro
 * Tools or Reaper; this is the handoff layer, and the handoff layer is exactly
 * what it is possible to prove without them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  planPortableHandoff, PACKAGE_DIR, SESSION_FILE, FIDELITY_FILE, README_FILE,
  MARKER_FILE, type HandoffInput, type SourceAsset,
} from './portablePackage';
import { isPortableHandoffDir } from './discovery';
import { materializeHandoff, type MaterializeFs } from './portableMaterialize';
import { adoptionAllowsContribution } from './restoreAdoption';

const NOW = '2026-10-06T12:00:00.000Z';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wavi-handoff-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const realFs: MaterializeFs = {
  mkdirSync: (p, o) => { fs.mkdirSync(p, o); },
  readFileSync: (p) => fs.readFileSync(p),
  writeFileSync: (p, d, e) => { fs.writeFileSync(p, d as any, e as any); },
  statSync: (p) => fs.statSync(p),
  sha256: (d) => crypto.createHash('sha256').update(d).digest('hex'),
};

/** Write a source project directory and return its indexed assets. */
function makeProject(files: Array<[name: string, role: string]>): {
  dir: string; assets: SourceAsset[];
} {
  const dir = path.join(tmp, 'source', 'Song Project');
  fs.mkdirSync(dir, { recursive: true });
  const assets: SourceAsset[] = [];
  for (const [name, role] of files) {
    const abs = path.join(dir, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const body = Buffer.from(`contents of ${name}`);
    fs.writeFileSync(abs, body);
    assets.push({
      absolutePath: abs, relativePath: name, role,
      fileSize: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
    });
  }
  return { dir, assets };
}

function input(over: Partial<HandoffInput> & Pick<HandoffInput, 'sourceProjectDir' | 'assets'>): HandoffInput {
  return {
    handoffRoot: path.join(tmp, 'handoff'),
    projectName: 'Song',
    sourceDawId: 'ableton',
    targetDawId: 'fl-studio',
    bpm: 128,
    sourceVersionLabel: 'v8',
    generatedAt: NOW,
    ...over,
  };
}

function build(inp: HandoffInput) {
  const plan = planPortableHandoff(inp);
  const result = materializeHandoff(plan, realFs);
  const read = (rel: string) => fs.readFileSync(path.join(plan.root, rel), 'utf8');
  return {
    plan, result,
    session: () => JSON.parse(read(SESSION_FILE)),
    fidelity: () => JSON.parse(read(FIDELITY_FILE)),
    readme: () => read(README_FILE),
    ls: (rel = '') => fs.readdirSync(path.join(plan.root, rel)).sort(),
  };
}

/** The §15 fixture. */
const ABLETON_PROJECT: Array<[string, string]> = [
  ['Song.als', 'project'],
  ['vocal.wav', 'audio'],
  ['drums.wav', 'audio'],
  ['bass.wav', 'audio'],
  ['chords.mid', 'midi'],
  ['master.wav', 'audio'],
];

describe('§15A golden path — Ableton → FL Studio', () => {
  it('produces a real derived checkout at the stem-reconstruction tier', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const b = build(input({ sourceProjectDir: dir, assets }));

    expect(b.result.ok).toBe(true);
    expect(b.plan.tier).toBe('stems');
    expect(b.ls()).toEqual(['Song.als', 'midi', 'renders', 'stems', 'wavi']);
    expect(b.ls('stems')).toEqual(['bass.wav', 'drums.wav', 'vocal.wav']);
    expect(b.ls('midi')).toEqual(['chords.mid']);
    expect(b.ls('renders')).toEqual(['master.wav']);
    expect(b.ls(PACKAGE_DIR)).toEqual(['.wavi-portable-handoff', 'PORTABLE.md', 'fidelity.json', 'session.json']);
  });

  it('fabricates NO .flp and NO project.dawproject', () => {
    // The whole honesty claim in one assertion: nothing was converted.
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const b = build(input({ sourceProjectDir: dir, assets }));
    const everything = JSON.stringify(b.result.verified);
    expect(everything).not.toMatch(/\.flp/i);
    expect(everything).not.toMatch(/\.dawproject/i);
    expect(b.fidelity().available.dawproject).toBeNull();
    expect(b.fidelity().available.dawprojectAbsentReason).toMatch(/does not generate one/);
  });

  it('retains the original .als for reference and never modifies the source', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const before = fs.readdirSync(dir).sort();
    const beforeBytes = fs.readFileSync(path.join(dir, 'Song.als'));
    const b = build(input({ sourceProjectDir: dir, assets }));

    expect(fs.existsSync(path.join(b.plan.root, 'Song.als'))).toBe(true);
    // The source directory is byte-for-byte what it was: a derived checkout.
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(dir, 'Song.als'))).toEqual(beforeBytes);
  });

  it('fidelity.json records counts, tempo-bearing tier and explicit losses', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const f = build(input({ sourceProjectDir: dir, assets })).fidelity();
    expect(f.schema).toBe('wavi.fidelity/2');
    expect(f).toMatchObject({ sourceDaw: 'ableton', targetDaw: 'fl-studio', tier: 'stems', sourceVersion: 'v8' });
    expect(f.available).toMatchObject({ stems: 3, midi: 1, renders: 1, structuredImportSupported: false });
    expect(f.losses.join(' ')).toMatch(/Plugin instances/);
    expect(f.losses.join(' ')).toMatch(/Automation/);
    expect(f.checksumMismatches).toEqual([]);
  });

  it('session.json is a metadata sidecar, not a session format', () => {
    // DR-015: no second proprietary session schema. It carries identity,
    // tempo and an inventory — and must carry no track or device state.
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const s = build(input({ sourceProjectDir: dir, assets })).session();
    expect(s.schema).toBe('wavi.session/1');
    expect(s.note).toMatch(/Not a session format/i);
    expect(s.project).toEqual({ name: 'Song', sourceDaw: 'ableton' });
    expect(s.tempo).toEqual({ bpm: 128, source: 'wavi-index' });
    expect(s.assets).toHaveLength(6);
    for (const key of ['tracks', 'devices', 'plugins', 'channels', 'automation', 'clips']) {
      expect(s[key]).toBeUndefined();
    }
  });

  it('every asset in session.json carries real measured bytes and hashes', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const b = build(input({ sourceProjectDir: dir, assets }));
    for (const a of b.session().assets) {
      const onDisk = fs.readFileSync(path.join(b.plan.root, a.path));
      expect(a.bytes).toBe(onDisk.length);
      expect(a.sha256).toBe(crypto.createHash('sha256').update(onDisk).digest('hex'));
    }
  });

  it('PORTABLE.md tells a human what they have and what they do not', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const md = build(input({ sourceProjectDir: dir, assets })).readme();
    expect(md).toContain('Stem reconstruction');
    expect(md).toContain('Tempo: 128 BPM');
    expect(md).toContain('## What is NOT here');
    expect(md).toMatch(/would double the mix/);
    expect(md).toMatch(/DAWproject remains the structured interchange format/);
  });
});

describe('§15B golden path — FL Studio → Ableton (the inverse)', () => {
  it('behaves identically through the same planner, with no bespoke path', () => {
    const { dir, assets } = makeProject([
      ['Song.flp', 'project'],
      ['lead.wav', 'audio'], ['kick.wav', 'audio'], ['snare.wav', 'audio'],
      ['melody.mid', 'midi'],
      ['bounce.wav', 'audio'],
    ]);
    const b = build(input({
      sourceProjectDir: dir, assets, sourceDawId: 'fl-studio', targetDawId: 'ableton',
    }));
    expect(b.result.ok).toBe(true);
    expect(b.plan.tier).toBe('stems');
    expect(fs.existsSync(path.join(b.plan.root, 'Song.flp'))).toBe(true);
    expect(b.ls('stems')).toEqual(['kick.wav', 'lead.wav', 'snare.wav']);
    expect(b.ls('renders')).toEqual(['bounce.wav']);
    // No .als conjured in the other direction either.
    expect(JSON.stringify(b.result.verified)).not.toMatch(/\.als/i);
    expect(b.fidelity()).toMatchObject({ sourceDaw: 'fl-studio', targetDaw: 'ableton' });
  });
});

describe('§15C same DAW — native stays preferred', () => {
  it('FL → FL is the native tier and the .flp is right there at the root', () => {
    const { dir, assets } = makeProject([
      ['Song.flp', 'project'], ['lead.wav', 'audio'], ['kick.wav', 'audio'],
    ]);
    const b = build(input({
      sourceProjectDir: dir, assets, sourceDawId: 'fl-studio', targetDawId: 'fl-studio',
    }));
    expect(b.plan.tier).toBe('native');
    expect(fs.existsSync(path.join(b.plan.root, 'Song.flp'))).toBe(true);
    expect(b.fidelity().tier).toBe('native');
    // Nothing is lost, so nothing is claimed lost.
    expect(b.fidelity().losses).toEqual([]);
    expect(b.readme()).toContain('Opens natively');
  });

  it('a native handoff does not pretend the tempo matters for reconstruction', () => {
    const { dir, assets } = makeProject([['Song.flp', 'project']]);
    const b = build(input({
      sourceProjectDir: dir, assets, sourceDawId: 'fl-studio', targetDawId: 'fl-studio', bpm: null,
    }));
    expect(b.plan.tier).toBe('native');
    expect(b.plan.warnings.join(' ')).not.toMatch(/aligned by ear/);
  });
});

describe('§15D render-only fallback', () => {
  it('a lone master is the render tier and claims no reconstruction', () => {
    const { dir, assets } = makeProject([['master.wav', 'audio']]);
    const b = build(input({ sourceProjectDir: dir, assets }));
    expect(b.plan.tier).toBe('render');
    expect(b.ls('renders')).toEqual(['master.wav']);
    expect(b.result.verified.every((v) => v.bucket === 'renders')).toBe(true);
    expect(b.fidelity().available).toMatchObject({ stems: 0, midi: 0, renders: 1 });
    expect(b.plan.warnings.join(' ')).toMatch(/Only a mixdown is available/);
    expect(b.readme()).toContain('Mixdown only');
  });

  it('does NOT promote a tier from a filename that merely looks like a stem', () => {
    // "stem-ish" naming is not evidence. One audio file is one audio file.
    const { dir, assets } = makeProject([['stems-final-master.wav', 'audio']]);
    const b = build(input({ sourceProjectDir: dir, assets }));
    expect(b.plan.tier).not.toBe('stems');
    expect(b.plan.tier).toBe('render');
  });
});

describe('§15E missing and corrupt assets fail honestly', () => {
  it('an indexed file that is gone is a reported failure, not a silent success', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    fs.rmSync(path.join(dir, 'drums.wav'));
    const b = build(input({ sourceProjectDir: dir, assets }));

    expect(b.result.ok).toBe(false);
    expect(b.result.failures).toEqual([{ path: 'stems/drums.wav', reason: 'source file could not be read' }]);
    // The rest still arrived, and the metadata describes only what did.
    expect(b.ls('stems')).toEqual(['bass.wav', 'vocal.wav']);
    expect(b.session().assets.map((a: any) => a.path)).not.toContain('stems/drums.wav');
  });

  it('a checksum that disagrees marks the asset unreliable and fails the handoff', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    // Wavi recorded one thing; the bytes on disk say another — a corrupt
    // download must not become a valid handoff.
    const tampered = assets.map((a) =>
      a.relativePath === 'vocal.wav' ? { ...a, sha256: 'f'.repeat(64) } : a);
    const b = build(input({ sourceProjectDir: dir, assets: tampered }));

    expect(b.result.ok).toBe(false);
    expect(b.result.checksumMismatches).toEqual(['stems/vocal.wav']);
    expect(b.fidelity().checksumMismatches).toEqual(['stems/vocal.wav']);
    expect(b.fidelity().warnings.join(' ')).toMatch(/did not match the checksum/);
    expect(b.readme()).toMatch(/checksum mismatch, unreliable/);
    // Still recorded per-asset, so a tool reading session.json sees it too.
    const vocal = b.session().assets.find((a: any) => a.path === 'stems/vocal.wav');
    expect(vocal.checksumMismatch).toBe(true);
  });

  it('an asset with no recorded checksum is still hashed, just not compared', () => {
    const { dir, assets } = makeProject([['master.wav', 'audio']]);
    const b = build(input({ sourceProjectDir: dir, assets: assets.map((a) => ({ ...a, sha256: null })) }));
    expect(b.result.ok).toBe(true);
    expect(b.session().assets[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('§8 path safety — the derived checkout cannot escape', () => {
  it('refuses a root inside the source project, which could overwrite the original', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const plan = planPortableHandoff(input({
      sourceProjectDir: dir, assets, handoffRoot: path.join(dir, 'portable'),
    }));
    expect(plan.refusal).toMatch(/outside the original project folder/);
    expect(plan.copies).toEqual([]);
    expect(materializeHandoff(plan, realFs).error).toBeTruthy();
  });

  it('refuses a root that CONTAINS the source project', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const plan = planPortableHandoff(input({
      sourceProjectDir: dir, assets, handoffRoot: path.dirname(dir),
    }));
    expect(plan.refusal).toBeTruthy();
  });

  it('refuses a relative root', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    expect(planPortableHandoff(input({
      sourceProjectDir: dir, assets, handoffRoot: 'somewhere',
    })).refusal).toMatch(/absolute path/);
  });

  it('rejects traversal and absolute asset paths rather than following them', () => {
    const { dir, assets } = makeProject([['master.wav', 'audio']]);
    const hostile: SourceAsset[] = [
      ...assets,
      { absolutePath: '/etc/passwd', relativePath: '../../../etc/passwd', role: 'audio' },
      { absolutePath: '/etc/hosts', relativePath: '/etc/hosts', role: 'audio' },
      { absolutePath: path.join(dir, 'x'), relativePath: 'sub/../../escape.wav', role: 'audio' },
    ];
    const b = build(input({ sourceProjectDir: dir, assets: hostile }));
    expect(b.result.ok).toBe(true);
    expect(b.plan.rejected.length).toBe(3);
    expect(JSON.stringify(b.result.verified)).not.toMatch(/passwd|hosts|escape/);
    // The refusal is written down, not merely acted on.
    expect(b.fidelity().rejected).toHaveLength(3);
  });

  it('a filename collision renames rather than silently losing a stem', () => {
    const dir = path.join(tmp, 'source', 'Song Project');
    fs.mkdirSync(path.join(dir, 'A'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'B'), { recursive: true });
    for (const sub of ['A', 'B']) fs.writeFileSync(path.join(dir, sub, 'vocal.wav'), Buffer.from(sub));
    const assets: SourceAsset[] = ['A', 'B'].map((sub) => ({
      absolutePath: path.join(dir, sub, 'vocal.wav'),
      relativePath: `${sub}/vocal.wav`, role: 'stem',
    }));
    const b = build(input({ sourceProjectDir: dir, assets }));
    expect(b.ls('stems')).toEqual(['vocal-2.wav', 'vocal.wav']);
    expect(b.result.verified).toHaveLength(2);
  });

  it('a previous wavi/ package is never folded into the next one', () => {
    const { dir, assets } = makeProject([['master.wav', 'audio']]);
    const withOld: SourceAsset[] = [
      ...assets,
      { absolutePath: path.join(dir, 'wavi', 'fidelity.json'), relativePath: 'wavi/fidelity.json', role: 'analysis' },
    ];
    const b = build(input({ sourceProjectDir: dir, assets: withOld }));
    expect(JSON.stringify(b.result.verified)).not.toContain('fidelity.json');
  });
});

describe('§12 fidelity honesty', () => {
  it('says so when the source DAW is unknown', () => {
    const { dir, assets } = makeProject([['master.wav', 'audio']]);
    const b = build(input({ sourceProjectDir: dir, assets, sourceDawId: null }));
    expect(b.plan.warnings.join(' ')).toMatch(/DAW this project was made in is unknown/);
    expect(b.fidelity().sourceDaw).toBeNull();
    expect(b.readme()).toContain('Made in: unknown DAW');
  });

  it('says so when there is no MIDI', () => {
    const { dir, assets } = makeProject([['a.wav', 'audio'], ['b.wav', 'audio']]);
    const b = build(input({ sourceProjectDir: dir, assets }));
    expect(b.plan.warnings.join(' ')).toMatch(/No MIDI travelled/);
    expect(b.fidelity().available.midi).toBe(0);
  });

  it('says so when the tempo is unknown, rather than guessing one', () => {
    const { dir, assets } = makeProject([['a.wav', 'audio'], ['b.wav', 'audio'], ['c.wav', 'audio']]);
    const b = build(input({ sourceProjectDir: dir, assets, bpm: null }));
    expect(b.plan.tier).toBe('stems');
    expect(b.plan.warnings.join(' ')).toMatch(/aligned by ear/);
    expect(b.session().tempo).toBeNull();
    expect(b.readme()).toContain('Tempo: not recorded');
  });

  it('never claims plugin dependencies were checked, because they are not', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const deps = build(input({ sourceProjectDir: dir, assets })).fidelity().dependencies;
    expect(deps.scanned).toBe(false);
    expect(deps.known).toEqual([]);
    expect(deps.note).toMatch(/empty rather than complete/);
  });

  it('never promotes the structured tier without real DAWproject import support', () => {
    // A .dawproject travelling with the project is included and listed — but
    // none of Wavi's five target DAWs imports it, so the tier does not rise.
    const { dir, assets } = makeProject([
      ['Song.als', 'project'], ['project.dawproject', 'analysis'],
      ['a.wav', 'audio'], ['b.wav', 'audio'],
    ]);
    const b = build(input({ sourceProjectDir: dir, assets }));
    expect(b.plan.tier).toBe('stems');
    expect(b.result.verified.some((v) => v.to === 'project.dawproject')).toBe(true);
    expect(b.fidelity().available.dawproject).toBe('project.dawproject');
    expect(b.fidelity().available.structuredImportSupported).toBe(false);
    expect(b.fidelity().losses.join(' ')).toMatch(/cannot import it natively/);
  });

  it('nothing usable is reported as nothing usable', () => {
    const dir = path.join(tmp, 'source', 'Song Project');
    fs.mkdirSync(dir, { recursive: true });
    const b = build(input({ sourceProjectDir: dir, assets: [] }));
    expect(b.plan.tier).toBe('none');
    expect(b.plan.warnings.join(' ')).toMatch(/No usable assets/);
    expect(b.readme()).toContain('No usable assets travelled');
  });
});

describe('§14 lineage — the return path still works', () => {
  it('carries the canonical parent refs into the handoff metadata', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const b = build(input({
      sourceProjectDir: dir, assets,
      lineage: { sourceProjectRef: 'srv-proj-1', sourceVersionRef: 'srv-ver-8' },
    }));
    // A child version published later must be a child of THIS version, so the
    // handoff has to remember which one it came from.
    expect(b.session().lineage).toEqual({
      sourceVersion: 'v8', sourceProjectRef: 'srv-proj-1', sourceVersionRef: 'srv-ver-8',
    });
  });

  it('building a handoff does not alter who may publish back', () => {
    // The contribution rule is unchanged and still lives in one place; a
    // portable checkout does not become a licence to publish.
    expect(adoptionAllowsContribution('comment')).toBe(true);
    expect(adoptionAllowsContribution('view')).toBe(false);
    expect(adoptionAllowsContribution(null)).toBe(false);
  });

  it('records no lineage rather than a fake one for a project of your own', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const b = build(input({ sourceProjectDir: dir, assets, lineage: null, sourceVersionLabel: null }));
    expect(b.session().lineage).toEqual({
      sourceVersion: null, sourceProjectRef: null, sourceVersionRef: null,
    });
  });
});

describe('privacy — the package carries nothing it should not', () => {
  it('no absolute paths, tokens, DIDs or internal ids reach the written files', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const b = build(input({
      sourceProjectDir: dir, assets,
      lineage: { sourceProjectRef: 'srv-proj-1', sourceVersionRef: 'srv-ver-8' },
    }));
    for (const rel of [SESSION_FILE, FIDELITY_FILE, README_FILE]) {
      const text = fs.readFileSync(path.join(b.plan.root, rel), 'utf8');
      expect(text).not.toContain(tmp);              // no absolute source paths
      expect(text).not.toContain(os.homedir());
      expect(text).not.toMatch(/did:privy|Bearer |invt_|eyJ[A-Za-z0-9_-]{10,}/);
    }
  });

  it('asset paths are package-relative, so the package can be moved anywhere', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const b = build(input({ sourceProjectDir: dir, assets }));
    for (const a of b.session().assets) {
      expect(path.isAbsolute(a.path)).toBe(false);
      expect(a.path).not.toContain('..');
    }
  });
});

describe('repeatability', () => {
  it('rebuilding over an existing handoff converges rather than accumulating', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const first = build(input({ sourceProjectDir: dir, assets }));
    const second = build(input({ sourceProjectDir: dir, assets }));
    expect(second.result.ok).toBe(true);
    expect(second.ls('stems')).toEqual(first.ls('stems'));
    expect(second.ls()).toEqual(first.ls());
    // Crucially not vocal-2.wav: a rebuild must not treat its own output as a
    // new collision.
    expect(second.ls('stems')).not.toContain('vocal-2.wav');
  });
});

describe('§13 the derived checkout is not mistaken for an original project', () => {
  it('discovery skips a handoff folder, so no duplicate project appears', () => {
    // Without this, a handoff built inside a watched folder is discovered as a
    // brand-new project carrying a COPY of someone else's project file — which
    // would then sync and publish as if it were original work.
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const b = build(input({ sourceProjectDir: dir, assets }));
    expect(fs.existsSync(path.join(b.plan.root, MARKER_FILE))).toBe(true);
    expect(isPortableHandoffDir(b.plan.root, (p) => fs.existsSync(p))).toBe(true);
    // And the original project folder is still very much a project.
    expect(isPortableHandoffDir(dir, (p) => fs.existsSync(p))).toBe(false);
  });

  it('the marker explains itself, so deleting it is an informed choice', () => {
    const { dir, assets } = makeProject(ABLETON_PROJECT);
    const b = build(input({ sourceProjectDir: dir, assets }));
    const text = fs.readFileSync(path.join(b.plan.root, MARKER_FILE), 'utf8');
    expect(text).toMatch(/DERIVED checkout, not an original project/);
    expect(text).toMatch(/Deleting this file/);
  });
});
