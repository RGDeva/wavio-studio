"use strict";
/**
 * Project Association Engine — Phase 1 Validation Tests
 *
 * Covers the six canonical file scenarios specified for Phase 1.
 * All tests operate on path strings only — no filesystem I/O.
 * Stats are synthesised inline; classifyFile never reads the disk.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const fileClassifier_1 = require("./fileClassifier");
const namingParser_1 = require("./namingParser");
// ── Minimal Stats factory ────────────────────────────────────────────────────
function fakeStat(size = 1000000) {
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
    };
}
// ── Helper ───────────────────────────────────────────────────────────────────
function classify(filePath, size) {
    return (0, fileClassifier_1.classifyFile)(filePath, fakeStat(size));
}
// ── 1. FL Studio project file (.flp) ────────────────────────────────────────
(0, vitest_1.describe)('DAW project — .flp', () => {
    (0, vitest_1.it)('classifies Beat.flp as daw_project with high confidence', () => {
        const result = classify('/Users/rishig/Music/MyProject/Beat.flp');
        (0, vitest_1.expect)(result.role).toBe('daw_project');
        (0, vitest_1.expect)(result.confidence).toBeGreaterThanOrEqual(0.90);
    });
    (0, vitest_1.it)('classifies a deep-nested .flp as daw_project', () => {
        const result = classify('/Users/rishig/Music/Sessions/2024/June/TrackName v3.flp');
        (0, vitest_1.expect)(result.role).toBe('daw_project');
        (0, vitest_1.expect)(result.confidence).toBeGreaterThanOrEqual(0.90);
    });
    (0, vitest_1.it)('signals.byExtension is daw_project for .flp', () => {
        const result = classify('/tmp/test.flp');
        (0, vitest_1.expect)(result.signals.byExtension).toBe('daw_project');
    });
});
// ── 2. Exported bounce — "FINAL v2.wav" ─────────────────────────────────────
(0, vitest_1.describe)('Bounce/Master — FINAL v2.wav', () => {
    (0, vitest_1.it)('classifies "FINAL v2.wav" as master with confidence ≥ 0.80', () => {
        const result = classify('/Users/rishig/Music/MyProject/FINAL v2.wav');
        (0, vitest_1.expect)(result.role).toBe('master');
        (0, vitest_1.expect)(result.confidence).toBeGreaterThanOrEqual(0.80);
    });
    (0, vitest_1.it)('isFinal token is true', () => {
        const result = classify('/Users/rishig/Music/MyProject/FINAL v2.wav');
        (0, vitest_1.expect)(result.tokens.isFinal).toBe(true);
    });
    (0, vitest_1.it)('versionNumber is 2', () => {
        const result = classify('/Users/rishig/Music/MyProject/FINAL v2.wav');
        (0, vitest_1.expect)(result.tokens.versionNumber).toBe(2);
    });
    (0, vitest_1.it)('classifies "Beat FINAL.wav" in exports folder as master', () => {
        const result = classify('/Users/rishig/Music/MyProject/exports/Beat FINAL.wav');
        (0, vitest_1.expect)(result.role).toBe('master');
        (0, vitest_1.expect)(result.tokens.isFinal).toBe(true);
    });
    (0, vitest_1.it)('classifies plain "bounce.wav" in bounces folder as bounce', () => {
        const result = classify('/Users/rishig/Music/MyProject/bounces/bounce.wav');
        (0, vitest_1.expect)(result.role).toBe('bounce');
    });
});
// ── 3. Stem — Kick.wav inside a stems folder ─────────────────────────────────
(0, vitest_1.describe)('Stem — Kick.wav in stems folder', () => {
    (0, vitest_1.it)('classifies stems/Kick.wav as stem', () => {
        const result = classify('/Users/rishig/Music/MyProject/stems/Kick.wav');
        (0, vitest_1.expect)(result.role).toBe('stem');
    });
    (0, vitest_1.it)('stem: confidence ≥ 0.70 for stems-folder + name signal agreement', () => {
        const result = classify('/Users/rishig/Music/MyProject/stems/Kick.wav');
        (0, vitest_1.expect)(result.confidence).toBeGreaterThanOrEqual(0.70);
    });
    (0, vitest_1.it)('isInStemsFolder is true', () => {
        const result = classify('/Users/rishig/Music/MyProject/stems/Kick.wav');
        (0, vitest_1.expect)(result.signals.isInStemsFolder).toBe(true);
    });
    (0, vitest_1.it)('name-only stem: Snare.wav without folder hint still signals stem', () => {
        const result = classify('/Users/rishig/Music/MyProject/Snare.wav');
        (0, vitest_1.expect)(result.role).toBe('stem');
        (0, vitest_1.expect)(result.signals.byNamePattern).toBe('stem');
    });
    (0, vitest_1.it)('classifies 808.wav as stem via name pattern', () => {
        const result = classify('/Users/rishig/Music/MyProject/808.wav');
        (0, vitest_1.expect)(result.role).toBe('stem');
    });
});
// ── 4. Artwork — coverart.png ────────────────────────────────────────────────
(0, vitest_1.describe)('Artwork — coverart.png', () => {
    (0, vitest_1.it)('classifies coverart.png as artwork', () => {
        const result = classify('/Users/rishig/Music/MyProject/coverart.png');
        (0, vitest_1.expect)(result.role).toBe('artwork');
    });
    (0, vitest_1.it)('confidence ≥ 0.90 (extension is deterministic for image types)', () => {
        const result = classify('/Users/rishig/Music/MyProject/coverart.png');
        (0, vitest_1.expect)(result.confidence).toBeGreaterThanOrEqual(0.90);
    });
    (0, vitest_1.it)('byExtension signal is artwork', () => {
        const result = classify('/Users/rishig/Music/MyProject/cover.jpg');
        (0, vitest_1.expect)(result.signals.byExtension).toBe('artwork');
    });
    (0, vitest_1.it)('classifies thumbnail.jpeg as artwork', () => {
        const result = classify('/Users/rishig/Music/MyProject/thumbnail.jpeg');
        (0, vitest_1.expect)(result.role).toBe('artwork');
    });
    (0, vitest_1.it)('artwork name token detected for "coverart"', () => {
        const tokens = (0, namingParser_1.parseFileName)('coverart.png');
        (0, vitest_1.expect)(tokens.roleSignal).toBe('artwork');
    });
});
// ── 5. Lyrics — "lyrics draft.txt" ──────────────────────────────────────────
(0, vitest_1.describe)('Lyrics — lyrics draft.txt', () => {
    (0, vitest_1.it)('classifies "lyrics draft.txt" as lyrics', () => {
        const result = classify('/Users/rishig/Music/MyProject/lyrics draft.txt');
        (0, vitest_1.expect)(result.role).toBe('lyrics');
    });
    (0, vitest_1.it)('roleSignal is lyrics from name', () => {
        const result = classify('/Users/rishig/Music/MyProject/lyrics draft.txt');
        (0, vitest_1.expect)(result.signals.byNamePattern).toBe('lyrics');
    });
    (0, vitest_1.it)('classifies .txt in lyrics folder as lyrics', () => {
        const result = classify('/Users/rishig/Music/MyProject/lyrics/verse1.txt');
        (0, vitest_1.expect)(result.role).toBe('lyrics');
        (0, vitest_1.expect)(result.signals.isInLyricsFolder).toBe(true);
    });
    (0, vitest_1.it)('classifies generic notes.txt (no lyrics signal) as lyrics (text-file default)', () => {
        const result = classify('/Users/rishig/Music/MyProject/notes.txt');
        (0, vitest_1.expect)(result.role).toBe('lyrics');
    });
    (0, vitest_1.it)('classifies verse_hook.docx as lyrics via name signal', () => {
        const result = classify('/Users/rishig/Music/MyProject/verse_hook.docx');
        (0, vitest_1.expect)(result.role).toBe('lyrics');
    });
});
// ── 6. MIDI file — .mid ──────────────────────────────────────────────────────
(0, vitest_1.describe)('MIDI — .mid', () => {
    (0, vitest_1.it)('classifies melody.mid as midi', () => {
        const result = classify('/Users/rishig/Music/MyProject/melody.mid');
        (0, vitest_1.expect)(result.role).toBe('midi');
    });
    (0, vitest_1.it)('confidence ≥ 0.90 (extension is deterministic for .mid)', () => {
        const result = classify('/Users/rishig/Music/MyProject/melody.mid');
        (0, vitest_1.expect)(result.confidence).toBeGreaterThanOrEqual(0.90);
    });
    (0, vitest_1.it)('classifies chord_progression.midi as midi', () => {
        const result = classify('/Users/rishig/Music/MyProject/chord_progression.midi');
        (0, vitest_1.expect)(result.role).toBe('midi');
    });
    (0, vitest_1.it)('byExtension signal is midi', () => {
        const result = classify('/Users/rishig/Music/Patterns/drums.mid');
        (0, vitest_1.expect)(result.signals.byExtension).toBe('midi');
    });
    (0, vitest_1.it)('isInMidiFolder signal when inside midi folder', () => {
        const result = classify('/Users/rishig/Music/MyProject/midi/arp.mid');
        (0, vitest_1.expect)(result.signals.isInMidiFolder).toBe(true);
    });
});
// ── 7. Naming parser — token extraction ─────────────────────────────────────
(0, vitest_1.describe)('parseFileName — token extraction', () => {
    (0, vitest_1.it)('extracts versionNumber from "v2"', () => {
        const t = (0, namingParser_1.parseFileName)('FINAL v2.wav');
        (0, vitest_1.expect)(t.versionNumber).toBe(2);
    });
    (0, vitest_1.it)('extracts isFinal from "FINAL"', () => {
        const t = (0, namingParser_1.parseFileName)('FINAL v2.wav');
        (0, vitest_1.expect)(t.isFinal).toBe(true);
    });
    (0, vitest_1.it)('extracts roleSignal bounce from "Drake type beat BOUNCE 2 loud FINAL v2.wav"', () => {
        const t = (0, namingParser_1.parseFileName)('Drake type beat BOUNCE 2 loud FINAL v2.wav');
        (0, vitest_1.expect)(t.roleSignal).toBe('bounce');
        (0, vitest_1.expect)(t.isFinal).toBe(true);
        (0, vitest_1.expect)(t.versionNumber).toBe(2);
    });
    (0, vitest_1.it)('extracts roleSignal stem from "Kick.wav"', () => {
        const t = (0, namingParser_1.parseFileName)('Kick.wav');
        (0, vitest_1.expect)(t.roleSignal).toBe('stem');
    });
    (0, vitest_1.it)('returns null roleSignal for generic name with no signal words', () => {
        const t = (0, namingParser_1.parseFileName)('session1.flp');
        (0, vitest_1.expect)(t.roleSignal).toBeNull();
    });
    (0, vitest_1.it)('extracts descriptor "rough" from "rough mix v3.wav"', () => {
        const t = (0, namingParser_1.parseFileName)('rough mix v3.wav');
        (0, vitest_1.expect)(t.descriptors).toContain('rough');
    });
});
