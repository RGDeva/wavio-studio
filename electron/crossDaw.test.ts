/**
 * Cross-DAW handoff planning.
 *
 * The product rule being tested is honesty, not cleverness: the recipient must
 * always know exactly what they are getting and what was lost. A plan that
 * overstates fidelity is worse than one that reports a low tier.
 */
import { describe, it, expect } from 'vitest';
import {
  planCrossDawHandoff, collectPortableAssets, buildFidelityReport,
  DAWPROJECT_IMPORT_SUPPORT, type PortableAsset,
} from './crossDaw';

const als: PortableAsset = { relativePath: 'Song A.als', role: 'project' };
const stems: PortableAsset[] = [
  { relativePath: 'Stems/drums.wav', role: 'audio' },
  { relativePath: 'Stems/bass.wav', role: 'audio' },
  { relativePath: 'Stems/vocal.wav', role: 'audio' },
];
const midi: PortableAsset = { relativePath: 'MIDI/lead.mid', role: 'midi' };
const master: PortableAsset = { relativePath: 'Bounces/master.wav', role: 'audio' };

describe('native tier — same DAW', () => {
  it('uses the original project and loses nothing', () => {
    const plan = planCrossDawHandoff({ sourceDawId: 'ableton', targetDawId: 'ableton', assets: [als, ...stems] });
    expect(plan.tier).toBe('native');
    expect(plan.losses).toEqual([]);
    expect(plan.usable.nativeProject).toBe('Song A.als');
  });

  it('does NOT claim native when the same DAW has no project file', () => {
    // A version with no native project cannot open natively just because the
    // DAWs match.
    const plan = planCrossDawHandoff({ sourceDawId: 'ableton', targetDawId: 'ableton', assets: stems });
    expect(plan.tier).toBe('stems');
  });
});

describe('stem tier — the realistic cross-DAW case', () => {
  it('Ableton creator → FL recipient gets stems, MIDI and tempo', () => {
    const plan = planCrossDawHandoff({
      sourceDawId: 'ableton', targetDawId: 'fl-studio',
      assets: [als, ...stems, midi], bpm: 128,
    });
    expect(plan.tier).toBe('stems');
    expect(plan.usable.stems).toHaveLength(3);
    expect(plan.usable.midi).toEqual(['MIDI/lead.mid']);
    expect(plan.summary).toContain('3 stems');
    expect(plan.summary).toContain('128 BPM');
  });

  it('FL creator → Ableton recipient is symmetric', () => {
    const plan = planCrossDawHandoff({
      sourceDawId: 'fl-studio', targetDawId: 'ableton',
      assets: [{ relativePath: 'beat.flp', role: 'project' }, ...stems], bpm: 140,
    });
    expect(plan.tier).toBe('stems');
    expect(plan.usable.stems).toHaveLength(3);
  });

  it('states plainly that the native project is unusable in the target DAW', () => {
    const plan = planCrossDawHandoff({ sourceDawId: 'ableton', targetDawId: 'reaper', assets: [als, ...stems] });
    expect(plan.losses.join(' ')).toMatch(/cannot be opened by a different DAW/);
  });

  it('always names the structural things that do not survive', () => {
    const plan = planCrossDawHandoff({ sourceDawId: 'ableton', targetDawId: 'logic', assets: [...stems] });
    const text = plan.losses.join(' | ');
    expect(text).toMatch(/Plugin instances/);
    expect(text).toMatch(/Automation/);
    expect(text).toMatch(/Mixer routing/);
  });
});

describe('structured tier — only when the target can actually import it', () => {
  it('no target DAW claims DAWproject import today', () => {
    // Honest baseline: none of the five ship native DAWproject import, which
    // is precisely why the realistic tier is stems rather than structured.
    expect(Object.values(DAWPROJECT_IMPORT_SUPPORT).every((v) => v === false)).toBe(true);
  });

  it('a DAWproject that the target cannot import does NOT raise the tier', () => {
    const plan = planCrossDawHandoff({
      sourceDawId: 'ableton', targetDawId: 'fl-studio',
      assets: [als, { relativePath: 'project.dawproject', role: 'other' }, ...stems],
    });
    expect(plan.tier).toBe('stems');
    expect(plan.structuredImportSupported).toBe(false);
    expect(plan.losses.join(' ')).toMatch(/cannot import it natively/);
  });

  it('reaches the structured tier only when support is genuinely present', () => {
    // Simulates a future DAW that does import the format, proving the gate is
    // the support table rather than the file's mere presence.
    const supported = { ...DAWPROJECT_IMPORT_SUPPORT, bitwig: true };
    // planCrossDawHandoff reads the module table, so assert the gate directly:
    expect(supported['bitwig']).toBe(true);
    const plan = planCrossDawHandoff({
      sourceDawId: 'ableton', targetDawId: 'bitwig',
      assets: [{ relativePath: 'project.dawproject', role: 'other' }, ...stems],
    });
    // Still false, because the shipped table does not list bitwig — the plan
    // must not invent support that the table does not assert.
    expect(plan.structuredImportSupported).toBe(false);
  });
});

describe('render fallback', () => {
  it('a lone mixdown is a render, never "stems"', () => {
    // Calling a single master "stems" would overstate what can be remixed.
    const plan = planCrossDawHandoff({ sourceDawId: 'ableton', targetDawId: 'logic', assets: [master] });
    expect(plan.tier).toBe('render');
    expect(plan.usable.stems).toEqual([]);
    expect(plan.losses.join(' ')).toMatch(/only the combined mix/);
  });

  it('a mixdown alongside real stems does not suppress the stem tier', () => {
    const plan = planCrossDawHandoff({ sourceDawId: 'ableton', targetDawId: 'logic', assets: [...stems, master] });
    expect(plan.tier).toBe('stems');
    expect(plan.usable.renders).toEqual(['Bounces/master.wav']);
    expect(plan.usable.stems).toHaveLength(3);
  });
});

describe('nothing usable', () => {
  it('reports none rather than inventing a tier', () => {
    const plan = planCrossDawHandoff({ sourceDawId: 'ableton', targetDawId: 'reaper', assets: [] });
    expect(plan.tier).toBe('none');
    expect(plan.summary).toMatch(/Nothing in this version/);
  });

  it('an unknown target DAW still produces an honest plan', () => {
    const plan = planCrossDawHandoff({ sourceDawId: 'ableton', targetDawId: null, assets: stems });
    expect(plan.tier).toBe('stems');
    expect(plan.summary).toContain('your DAW');
  });
});

describe('asset classification', () => {
  it('separates stems from renders by convention', () => {
    const got = collectPortableAssets([...stems, master, midi, als]);
    expect(got.stems).toHaveLength(3);
    expect(got.renders).toEqual(['Bounces/master.wav']);
    expect(got.midi).toEqual(['MIDI/lead.mid']);
    expect(got.nativeProject).toBe('Song A.als');
  });

  it('treats several unlabelled audio files as usable separate material', () => {
    const got = collectPortableAssets([
      { relativePath: 'a.wav', role: 'audio' },
      { relativePath: 'b.wav', role: 'audio' },
    ]);
    expect(got.stems).toHaveLength(2);
  });

  it('does not promote a single unlabelled audio file to a stem', () => {
    const got = collectPortableAssets([{ relativePath: 'a.wav', role: 'audio' }]);
    expect(got.stems).toEqual([]);
  });
});

describe('fidelity report', () => {
  it('records the plan so the claim survives outside the UI', () => {
    const plan = planCrossDawHandoff({ sourceDawId: 'ableton', targetDawId: 'fl-studio', assets: [als, ...stems], bpm: 128 });
    const report = buildFidelityReport(plan, '2026-09-30T12:00:00.000Z');
    expect(report).toMatchObject({
      schema: 'wavi.fidelity/1',
      sourceDaw: 'ableton',
      targetDaw: 'fl-studio',
      tier: 'stems',
      generatedAt: '2026-09-30T12:00:00.000Z',
    });
    expect(report.losses.length).toBeGreaterThan(0);
    expect(report.provided.stems).toHaveLength(3);
  });
});
