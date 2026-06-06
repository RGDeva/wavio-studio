/**
 * Project Association Engine — Phase 1 Validation Tests
 *
 * Covers the six canonical file scenarios specified for Phase 1.
 * All tests operate on path strings only — no filesystem I/O.
 * Stats are synthesised inline; classifyFile never reads the disk.
 */

import { describe, it, expect } from 'vitest';
import type { Stats } from 'fs';
import { classifyFile, type ClassifierRole } from './fileClassifier';
import { parseFileName } from './namingParser';

// ── Minimal Stats factory ────────────────────────────────────────────────────

function fakeStat(size = 1_000_000): Stats {
  return {
    size,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    mtime: new Date(),
    ctime: new Date(),
    atime: new Date(),
    birthtime: new Date(),
    dev: 0, ino: 0, mode: 0o644, nlink: 1, uid: 0, gid: 0,
    rdev: 0, blksize: 4096, blocks: 0,
    atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
  } as unknown as Stats;
}

// ── Helper ───────────────────────────────────────────────────────────────────

function classify(filePath: string, size?: number) {
  return classifyFile(filePath, fakeStat(size));
}

// ── 1. FL Studio project file (.flp) ────────────────────────────────────────

describe('DAW project — .flp', () => {
  it('classifies Beat.flp as daw_project with high confidence', () => {
    const result = classify('/Users/rishig/Music/MyProject/Beat.flp');
    expect(result.role).toBe<ClassifierRole>('daw_project');
    expect(result.confidence).toBeGreaterThanOrEqual(0.90);
  });

  it('classifies a deep-nested .flp as daw_project', () => {
    const result = classify('/Users/rishig/Music/Sessions/2024/June/TrackName v3.flp');
    expect(result.role).toBe<ClassifierRole>('daw_project');
    expect(result.confidence).toBeGreaterThanOrEqual(0.90);
  });

  it('signals.byExtension is daw_project for .flp', () => {
    const result = classify('/tmp/test.flp');
    expect(result.signals.byExtension).toBe<ClassifierRole>('daw_project');
  });
});

// ── 2. Exported bounce — "FINAL v2.wav" ─────────────────────────────────────

describe('Bounce/Master — FINAL v2.wav', () => {
  it('classifies "FINAL v2.wav" as master with confidence ≥ 0.80', () => {
    const result = classify('/Users/rishig/Music/MyProject/FINAL v2.wav');
    expect(result.role).toBe<ClassifierRole>('master');
    expect(result.confidence).toBeGreaterThanOrEqual(0.80);
  });

  it('isFinal token is true', () => {
    const result = classify('/Users/rishig/Music/MyProject/FINAL v2.wav');
    expect(result.tokens.isFinal).toBe(true);
  });

  it('versionNumber is 2', () => {
    const result = classify('/Users/rishig/Music/MyProject/FINAL v2.wav');
    expect(result.tokens.versionNumber).toBe(2);
  });

  it('classifies "Beat FINAL.wav" in exports folder as master', () => {
    const result = classify('/Users/rishig/Music/MyProject/exports/Beat FINAL.wav');
    expect(result.role).toBe<ClassifierRole>('master');
    expect(result.tokens.isFinal).toBe(true);
  });

  it('classifies plain "bounce.wav" in bounces folder as bounce', () => {
    const result = classify('/Users/rishig/Music/MyProject/bounces/bounce.wav');
    expect(result.role).toBe<ClassifierRole>('bounce');
  });
});

// ── 3. Stem — Kick.wav inside a stems folder ─────────────────────────────────

describe('Stem — Kick.wav in stems folder', () => {
  it('classifies stems/Kick.wav as stem', () => {
    const result = classify('/Users/rishig/Music/MyProject/stems/Kick.wav');
    expect(result.role).toBe<ClassifierRole>('stem');
  });

  it('stem: confidence ≥ 0.70 for stems-folder + name signal agreement', () => {
    const result = classify('/Users/rishig/Music/MyProject/stems/Kick.wav');
    expect(result.confidence).toBeGreaterThanOrEqual(0.70);
  });

  it('isInStemsFolder is true', () => {
    const result = classify('/Users/rishig/Music/MyProject/stems/Kick.wav');
    expect(result.signals.isInStemsFolder).toBe(true);
  });

  it('name-only stem: Snare.wav without folder hint still signals stem', () => {
    const result = classify('/Users/rishig/Music/MyProject/Snare.wav');
    expect(result.role).toBe<ClassifierRole>('stem');
    expect(result.signals.byNamePattern).toBe('stem');
  });

  it('classifies 808.wav as stem via name pattern', () => {
    const result = classify('/Users/rishig/Music/MyProject/808.wav');
    expect(result.role).toBe<ClassifierRole>('stem');
  });
});

// ── 4. Artwork — coverart.png ────────────────────────────────────────────────

describe('Artwork — coverart.png', () => {
  it('classifies coverart.png as artwork', () => {
    const result = classify('/Users/rishig/Music/MyProject/coverart.png');
    expect(result.role).toBe<ClassifierRole>('artwork');
  });

  it('confidence ≥ 0.90 (extension is deterministic for image types)', () => {
    const result = classify('/Users/rishig/Music/MyProject/coverart.png');
    expect(result.confidence).toBeGreaterThanOrEqual(0.90);
  });

  it('byExtension signal is artwork', () => {
    const result = classify('/Users/rishig/Music/MyProject/cover.jpg');
    expect(result.signals.byExtension).toBe<ClassifierRole>('artwork');
  });

  it('classifies thumbnail.jpeg as artwork', () => {
    const result = classify('/Users/rishig/Music/MyProject/thumbnail.jpeg');
    expect(result.role).toBe<ClassifierRole>('artwork');
  });

  it('artwork name token detected for "coverart"', () => {
    const tokens = parseFileName('coverart.png');
    expect(tokens.roleSignal).toBe('artwork');
  });
});

// ── 5. Lyrics — "lyrics draft.txt" ──────────────────────────────────────────

describe('Lyrics — lyrics draft.txt', () => {
  it('classifies "lyrics draft.txt" as lyrics', () => {
    const result = classify('/Users/rishig/Music/MyProject/lyrics draft.txt');
    expect(result.role).toBe<ClassifierRole>('lyrics');
  });

  it('roleSignal is lyrics from name', () => {
    const result = classify('/Users/rishig/Music/MyProject/lyrics draft.txt');
    expect(result.signals.byNamePattern).toBe('lyrics');
  });

  it('classifies .txt in lyrics folder as lyrics', () => {
    const result = classify('/Users/rishig/Music/MyProject/lyrics/verse1.txt');
    expect(result.role).toBe<ClassifierRole>('lyrics');
    expect(result.signals.isInLyricsFolder).toBe(true);
  });

  it('classifies generic notes.txt (no lyrics signal) as lyrics (text-file default)', () => {
    const result = classify('/Users/rishig/Music/MyProject/notes.txt');
    expect(result.role).toBe<ClassifierRole>('lyrics');
  });

  it('classifies verse_hook.docx as lyrics via name signal', () => {
    const result = classify('/Users/rishig/Music/MyProject/verse_hook.docx');
    expect(result.role).toBe<ClassifierRole>('lyrics');
  });
});

// ── 6. MIDI file — .mid ──────────────────────────────────────────────────────

describe('MIDI — .mid', () => {
  it('classifies melody.mid as midi', () => {
    const result = classify('/Users/rishig/Music/MyProject/melody.mid');
    expect(result.role).toBe<ClassifierRole>('midi');
  });

  it('confidence ≥ 0.90 (extension is deterministic for .mid)', () => {
    const result = classify('/Users/rishig/Music/MyProject/melody.mid');
    expect(result.confidence).toBeGreaterThanOrEqual(0.90);
  });

  it('classifies chord_progression.midi as midi', () => {
    const result = classify('/Users/rishig/Music/MyProject/chord_progression.midi');
    expect(result.role).toBe<ClassifierRole>('midi');
  });

  it('byExtension signal is midi', () => {
    const result = classify('/Users/rishig/Music/Patterns/drums.mid');
    expect(result.signals.byExtension).toBe<ClassifierRole>('midi');
  });

  it('isInMidiFolder signal when inside midi folder', () => {
    const result = classify('/Users/rishig/Music/MyProject/midi/arp.mid');
    expect(result.signals.isInMidiFolder).toBe(true);
  });
});

// ── 7. Naming parser — token extraction ─────────────────────────────────────

describe('parseFileName — token extraction', () => {
  it('extracts versionNumber from "v2"', () => {
    const t = parseFileName('FINAL v2.wav');
    expect(t.versionNumber).toBe(2);
  });

  it('extracts isFinal from "FINAL"', () => {
    const t = parseFileName('FINAL v2.wav');
    expect(t.isFinal).toBe(true);
  });

  it('extracts roleSignal bounce from "Drake type beat BOUNCE 2 loud FINAL v2.wav"', () => {
    const t = parseFileName('Drake type beat BOUNCE 2 loud FINAL v2.wav');
    expect(t.roleSignal).toBe('bounce');
    expect(t.isFinal).toBe(true);
    expect(t.versionNumber).toBe(2);
  });

  it('extracts roleSignal stem from "Kick.wav"', () => {
    const t = parseFileName('Kick.wav');
    expect(t.roleSignal).toBe('stem');
  });

  it('returns null roleSignal for generic name with no signal words', () => {
    const t = parseFileName('session1.flp');
    expect(t.roleSignal).toBeNull();
  });

  it('extracts descriptor "rough" from "rough mix v3.wav"', () => {
    const t = parseFileName('rough mix v3.wav');
    expect(t.descriptors).toContain('rough');
  });
});
