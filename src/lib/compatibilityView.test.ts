import { describe, it, expect } from 'vitest';
import { deriveCompatibilityRows, compatibilityHeadline, DawCapabilityReport } from './compatibilityView';

const ableton: DawCapabilityReport = {
  id: 'ableton',
  displayName: 'Ableton Live',
  capabilities: {
    detect: true, packageNative: true, restore: true, sameDawOpen: true,
    crossDawReconstruct: false, scanPlugins: false, fidelityReport: false,
  },
};

const generic: DawCapabilityReport = {
  id: 'generic',
  displayName: 'DAW project',
  capabilities: {
    detect: false, packageNative: false, restore: true, sameDawOpen: false,
    crossDawReconstruct: false, scanPlugins: false, fidelityReport: false,
  },
};

describe('deriveCompatibilityRows', () => {
  it('Ableton: native open available, packaging included, cross-DAW planned', () => {
    const rows = deriveCompatibilityRows(ableton);
    expect(rows.find(r => r.label === 'Open in Ableton Live')).toEqual({ label: 'Open in Ableton Live', value: 'Available', tone: 'ok' });
    expect(rows.find(r => r.label === 'Native packaging')).toMatchObject({ value: 'Included', tone: 'ok' });
    expect(rows.find(r => r.label === 'Cross-DAW reconstruction')).toMatchObject({ value: 'Planned', tone: 'muted' });
  });

  it('generic DAW: no native open, project-pack only', () => {
    const rows = deriveCompatibilityRows(generic);
    expect(rows.find(r => r.label === 'Open in DAW')).toEqual({ label: 'Open in DAW', value: 'Project Pack only', tone: 'muted' });
    expect(rows.find(r => r.label === 'Native packaging')).toMatchObject({ value: 'Generic pack', tone: 'muted' });
  });

  it('never reports available for unimplemented capabilities (honesty rule)', () => {
    for (const r of [ableton, generic]) {
      const rows = deriveCompatibilityRows(r);
      expect(rows.find(x => x.label === 'Plugin scan')!.value).toBe('Not yet');
      expect(rows.find(x => x.label === 'Fidelity report')!.value).toBe('Not yet');
      expect(rows.find(x => x.label === 'Cross-DAW reconstruction')!.value).toBe('Planned');
    }
  });

  it('null report → no rows and an unavailable headline', () => {
    expect(deriveCompatibilityRows(null)).toEqual([]);
    expect(compatibilityHeadline(null)).toBe('Compatibility unavailable');
  });

  it('headline reflects native vs universal', () => {
    expect(compatibilityHeadline(ableton)).toBe('Native open in Ableton Live');
    expect(compatibilityHeadline(generic)).toBe('Universal Project Pack (DAW project)');
  });
});
