/**
 * The handoff surface shows what is there and says what is not.
 *
 * These guard tone as much as content: a green tick beside "your plugin
 * settings are gone" would be a lie told in formatting rather than in words.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveHandoffRows, deriveAvailableLines, handoffHeadline, deriveHandoffProblems,
  dawDisplayName, TIER_LABEL, type HandoffResult,
} from './handoffView';

const STEMS: HandoffResult = {
  ok: true, tier: 'stems', summary: 'Stem handoff: 12 stems, 4 MIDI files, tempo 128 BPM.',
  counts: { stems: 12, midi: 4, renders: 1 },
  nativeProjectIncluded: true, dawprojectIncluded: false,
  losses: ['Plugin instances and their settings', 'Automation curves'],
};

describe('header rows', () => {
  it('reads like §11: source, open with, compatibility', () => {
    const rows = deriveHandoffRows('ableton', 'fl-studio', STEMS);
    expect(rows).toEqual([
      { label: 'Source', value: 'Ableton Live', tone: 'muted' },
      { label: 'Open with', value: 'FL Studio', tone: 'muted' },
      { label: 'Compatibility', value: 'Stem reconstruction', tone: 'muted' },
    ]);
  });

  it('only NATIVE reads as reassuring', () => {
    // Stem reconstruction works and is lossy; the tone must not say otherwise.
    expect(deriveHandoffRows('fl-studio', 'fl-studio', { ok: true, tier: 'native' })[2].tone).toBe('ok');
    expect(deriveHandoffRows('ableton', 'logic', { ok: true, tier: 'stems' })[2].tone).toBe('muted');
    expect(deriveHandoffRows('ableton', 'logic', { ok: true, tier: 'render' })[2].tone).toBe('muted');
    expect(deriveHandoffRows('ableton', 'logic', { ok: true, tier: 'none' })[2].tone).toBe('warn');
  });

  it('flags an unknown source DAW instead of hiding it', () => {
    const rows = deriveHandoffRows(null, 'logic', STEMS);
    expect(rows[0]).toEqual({ label: 'Source', value: 'Unknown DAW', tone: 'warn' });
  });

  it('says "Any DAW" when no target was chosen', () => {
    expect(deriveHandoffRows('ableton', null, STEMS)[1].value).toBe('Any DAW');
  });

  it('reports a failed preparation as failed', () => {
    const rows = deriveHandoffRows('ableton', 'logic', { ok: false, error: 'nope' });
    expect(rows[2]).toEqual({ label: 'Compatibility', value: 'Could not be prepared', tone: 'warn' });
  });
});

describe('what is available', () => {
  it('lists exactly what travelled', () => {
    expect(deriveAvailableLines(STEMS)).toEqual([
      'Original project file (opens in the source DAW only)',
      '12 stems', '4 MIDI files', 'Stereo reference mix',
    ]);
  });

  it('omits zero counts rather than listing absences', () => {
    const r = deriveAvailableLines({ ok: true, tier: 'render', counts: { stems: 0, midi: 0, renders: 1 } });
    expect(r).toEqual(['Stereo reference mix']);
    expect(r.join(' ')).not.toContain('0 ');
  });

  it('singularises honestly', () => {
    expect(deriveAvailableLines({ ok: true, counts: { stems: 1, midi: 1, renders: 0 } }))
      .toEqual(['1 stem', '1 MIDI file']);
  });

  it('names a DAWproject only when one is really included', () => {
    expect(deriveAvailableLines({ ok: true, counts: { stems: 1, midi: 0, renders: 0 }, dawprojectIncluded: true })
      .some((l) => /DAWproject/.test(l))).toBe(true);
    expect(deriveAvailableLines(STEMS).some((l) => /DAWproject/.test(l))).toBe(false);
  });

  it('says nothing travelled when nothing did', () => {
    expect(deriveAvailableLines({ ok: true, tier: 'none', counts: { stems: 0, midi: 0, renders: 0 } }))
      .toEqual(['Nothing usable travelled with this version']);
  });
});

describe('headline', () => {
  it('does not nudge a same-DAW recipient toward a lossy reconstruction', () => {
    expect(handoffHeadline('fl-studio', 'fl-studio', { ok: true, tier: 'native' }))
      .toBe('Opens natively in FL Studio — nothing is lost.');
  });

  it('uses the planner’s own summary otherwise', () => {
    expect(handoffHeadline('ableton', 'fl-studio', STEMS)).toBe(STEMS.summary);
  });

  it('surfaces the real error', () => {
    expect(handoffHeadline('ableton', 'logic', { ok: false, error: 'outside the folders Wavi can write to' }))
      .toMatch(/outside the folders/);
  });

  it('invites rather than claims before anything is prepared', () => {
    expect(handoffHeadline('ableton', 'logic', null)).toMatch(/Prepare a portable handoff/);
  });
});

describe('problems are separated from expected losses', () => {
  it('a missing asset is a problem, not boilerplate', () => {
    const p = deriveHandoffProblems({
      ok: false, failures: [{ path: 'stems/drums.wav', reason: 'source file could not be read' }],
    });
    expect(p).toEqual(['stems/drums.wav — source file could not be read']);
  });

  it('a checksum mismatch says it may be corrupt', () => {
    expect(deriveHandoffProblems({ ok: false, checksumMismatches: ['stems/vocal.wav'] })[0])
      .toMatch(/may be corrupt/);
  });

  it('expected losses are NOT problems', () => {
    // Automation not transferring is the design, not a fault.
    expect(deriveHandoffProblems(STEMS)).toEqual([]);
  });
});

describe('DAW names', () => {
  it('uses product names, not internal ids', () => {
    expect(dawDisplayName('pro-tools')).toBe('Pro Tools');
    expect(dawDisplayName('ableton')).toBe('Ableton Live');
  });

  it('falls back to the id rather than inventing a name', () => {
    expect(dawDisplayName('bitwig')).toBe('bitwig');
  });

  it('uses Wavi’s existing tier vocabulary', () => {
    expect(TIER_LABEL.stems).toBe('Stem reconstruction');
    expect(TIER_LABEL.render).toBe('Render only');
  });
});
