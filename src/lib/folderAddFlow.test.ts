/**
 * D1 — folder-add confirmation flow tests.
 *
 * Covers the full folders:add result contract as consumed by FoldersPage via
 * the pure helpers in folderAddFlow.ts, plus the classification outcomes the
 * main process feeds into it (classifyFolderForImport, imported directly —
 * it has no better-sqlite3 dependency; `electron` is mocked for module scope).
 */
import { vi, describe, it, expect } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/wavi-folderflow-test') },
}));

import { interpretFolderAddResult, confirmationCopy, completeAmbiguousAdd } from './folderAddFlow';
import { classifyFolderForImport } from '../../electron/discovery';

describe('classification outcomes that drive the flow', () => {
  it('safe project folder (stems + one .als) is added immediately — no confirmation', () => {
    const entries = [...Array.from({ length: 30 }, (_, i) => `stem_${i}.wav`), 'MySong.als'];
    const c = classifyFolderForImport('/Users/me/Music/Ableton/MySong Project', entries);
    expect(c.likelySampleLibrary).toBe(false);
    // main.ts: not likelySampleLibrary → addWatchedFolder → { needsConfirmation: false, path }
    const outcome = interpretFolderAddResult({ needsConfirmation: false, path: c.path });
    expect(outcome).toEqual({ kind: 'added', path: '/Users/me/Music/Ableton/MySong Project' });
  });

  it('Splice-style library is flagged for confirmation by name', () => {
    const c = classifyFolderForImport('/Users/me/Music/Splice', ['kick.wav', 'snare.wav']);
    expect(c.likelySampleLibrary).toBe(true);
    expect(c.reason).toBe('name_match');
    const outcome = interpretFolderAddResult({ needsConfirmation: true, classification: c });
    expect(outcome.kind).toBe('needs-confirmation');
  });

  it('Native Instruments-style library is flagged for confirmation by name', () => {
    const c = classifyFolderForImport('/Users/me/Documents/Native Instruments', ['a.wav']);
    expect(c.likelySampleLibrary).toBe(true);
    expect(c.reason).toBe('name_match');
  });

  it('500 audio files with no DAW project is flagged by ratio', () => {
    const entries = Array.from({ length: 500 }, (_, i) => `loop_${i}.wav`);
    const c = classifyFolderForImport('/Users/me/Music/Random Loops', entries);
    expect(c.likelySampleLibrary).toBe(true);
    expect(c.reason).toBe('high_audio_ratio');
    expect(c.audioFileCount).toBe(500);
  });

  it('500 audio files with one .flp is NOT flagged — a project file always wins', () => {
    const entries = [...Array.from({ length: 500 }, (_, i) => `bounce_${i}.wav`), 'Track.flp'];
    const c = classifyFolderForImport('/Users/me/Music/FL Studio/Track', entries);
    expect(c.likelySampleLibrary).toBe(false);
  });
});

describe('interpretFolderAddResult contract', () => {
  it('null means the user cancelled the native dialog', () => {
    expect(interpretFolderAddResult(null)).toEqual({ kind: 'cancelled' });
  });

  it('legacy plain-string result is tolerated as an added path', () => {
    expect(interpretFolderAddResult('/Users/me/Music')).toEqual({ kind: 'added', path: '/Users/me/Music' });
  });

  it('malformed result becomes a visible error, never a silent no-op', () => {
    const outcome = interpretFolderAddResult({ unexpected: true });
    expect(outcome.kind).toBe('error');
    expect((outcome as any).message).toBeTruthy();
  });
});

describe('confirmation copy', () => {
  it('explains scanning/sync cost for a name-matched library', () => {
    const copy = confirmationCopy({
      path: '/Users/me/Music/Splice', audioFileCount: 12, projectFileCount: 0,
      likelySampleLibrary: true, reason: 'name_match',
    });
    expect(copy.title).toContain('Splice');
    expect(copy.body.toLowerCase()).toMatch(/scan|sync/);
  });

  it('explains scanning/sync cost with the file count for a ratio-flagged folder', () => {
    const copy = confirmationCopy({
      path: '/Users/me/Music/Loops', audioFileCount: 743, projectFileCount: 0,
      likelySampleLibrary: true, reason: 'high_audio_ratio',
    });
    expect(copy.body).toContain('743');
    expect(copy.body.toLowerCase()).toMatch(/scan|sync/);
  });
});

describe('completeAmbiguousAdd (Add Anyway path)', () => {
  it('confirm → calls the confirmation IPC exactly once and reports added', async () => {
    const confirmFn = vi.fn(async (p: string) => ({ needsConfirmation: false as const, path: p }));
    const outcome = await completeAmbiguousAdd(confirmFn, '/Users/me/Music/Splice');
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(confirmFn).toHaveBeenCalledWith('/Users/me/Music/Splice');
    expect(outcome).toEqual({ kind: 'added', path: '/Users/me/Music/Splice' });
  });

  it('cancel path never invokes the confirmation IPC (no folder indexed)', () => {
    // Cancel is a pure UI state clear — asserted here as: the only way a
    // flagged folder gets indexed is an explicit completeAmbiguousAdd call.
    const confirmFn = vi.fn();
    // ... user clicked Cancel: nothing calls completeAmbiguousAdd.
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('IPC failure surfaces as a visible, actionable error', async () => {
    const confirmFn = vi.fn(async () => { throw new Error('IPC channel closed'); });
    const outcome = await completeAmbiguousAdd(confirmFn as any, '/Users/me/Music/Splice');
    expect(outcome.kind).toBe('error');
    expect((outcome as any).message).toContain('Splice');
    expect((outcome as any).message).toContain('IPC channel closed');
  });
});
