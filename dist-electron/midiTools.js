"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateMidiMelody = generateMidiMelody;
exports.generateChordProgression = generateChordProgression;
exports.generateDrumPattern = generateDrumPattern;
exports.revealProjectFolder = revealProjectFolder;
exports.explainImportToFlStudio = explainImportToFlStudio;
exports.summarizeProjectContext = summarizeProjectContext;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const electron_1 = require("electron");
// ── MIDI file writer (pure Node.js, no external deps required) ────────────────
// Implements a minimal but valid Standard MIDI File (SMF) format 0
function writeMidiFile(notes, tempo, ticksPerBeat) {
    const microsecondsPerBeat = Math.round(60000000 / tempo);
    // Helper: write variable-length quantity
    function vlq(n) {
        if (n < 0x80)
            return [n];
        const bytes = [];
        let v = n;
        bytes.unshift(v & 0x7f);
        v >>= 7;
        while (v > 0) {
            bytes.unshift((v & 0x7f) | 0x80);
            v >>= 7;
        }
        return bytes;
    }
    // Build MIDI events
    const events = [];
    // Tempo event at tick 0
    events.push({
        tick: 0,
        data: [0xff, 0x51, 0x03,
            (microsecondsPerBeat >> 16) & 0xff,
            (microsecondsPerBeat >> 8) & 0xff,
            microsecondsPerBeat & 0xff,
        ],
    });
    // Note on/off events
    for (const note of notes) {
        const ch = note.channel & 0x0f;
        events.push({ tick: note.startTick, data: [0x90 | ch, note.pitch & 0x7f, note.velocity & 0x7f] });
        events.push({ tick: note.startTick + note.durationTicks, data: [0x80 | ch, note.pitch & 0x7f, 0x00] });
    }
    // Sort by tick
    events.sort((a, b) => a.tick - b.tick);
    // Encode as delta-time + event bytes
    const trackBytes = [];
    let currentTick = 0;
    for (const event of events) {
        const delta = event.tick - currentTick;
        currentTick = event.tick;
        trackBytes.push(...vlq(delta), ...event.data);
    }
    // End of track
    trackBytes.push(0x00, 0xff, 0x2f, 0x00);
    // Track chunk
    const trackLen = trackBytes.length;
    const trackChunk = [
        0x4d, 0x54, 0x72, 0x6b, // "MTrk"
        (trackLen >> 24) & 0xff, (trackLen >> 16) & 0xff, (trackLen >> 8) & 0xff, trackLen & 0xff,
        ...trackBytes,
    ];
    // Header chunk
    const headerChunk = [
        0x4d, 0x54, 0x68, 0x64, // "MThd"
        0x00, 0x00, 0x00, 0x06, // chunk length = 6
        0x00, 0x00, // format 0
        0x00, 0x01, // 1 track
        (ticksPerBeat >> 8) & 0xff, ticksPerBeat & 0xff,
    ];
    return Buffer.from([...headerChunk, ...trackChunk]);
}
// ── Scale/chord definitions ───────────────────────────────────────────────────
const NOTE_MAP = {
    C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
    'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};
const SCALE_INTERVALS = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 2, 4, 7, 9],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    blues: [0, 3, 5, 6, 7, 10],
};
const CHORD_INTERVALS = {
    major: [0, 4, 7],
    minor: [0, 3, 7],
    dim: [0, 3, 6],
    aug: [0, 4, 8],
    maj7: [0, 4, 7, 11],
    min7: [0, 3, 7, 10],
    dom7: [0, 4, 7, 10],
};
function noteToMidi(key, octave) {
    return (octave + 1) * 12 + (NOTE_MAP[key] ?? 0);
}
function scaleNotes(key, scale, octave = 4) {
    const root = NOTE_MAP[key] ?? 0;
    const intervals = SCALE_INTERVALS[scale] ?? SCALE_INTERVALS.minor;
    return intervals.map((i) => ((octave + 1) * 12) + root + i);
}
// ── Output directory ──────────────────────────────────────────────────────────
function getMidiOutputDir(projectFolder) {
    const base = projectFolder
        ?? path_1.default.join(electron_1.app.getPath('music'), 'Wavi', 'MIDI');
    const dir = path_1.default.join(base, 'Wavi_MIDI');
    fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
function timestampedFilename(prefix) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${prefix}_${ts}.mid`;
}
function saveFile(dir, filename, buffer) {
    const filePath = path_1.default.join(dir, filename);
    // Never overwrite
    if (fs_1.default.existsSync(filePath)) {
        const alt = filePath.replace('.mid', `_${Date.now()}.mid`);
        fs_1.default.writeFileSync(alt, buffer);
        return alt;
    }
    fs_1.default.writeFileSync(filePath, buffer);
    return filePath;
}
const FL_STUDIO_GUIDE = `FL Studio Import:
1. Open FL Studio → File menu → Import → MIDI file
2. Or drag the .mid file directly into the Playlist or Piano Roll
3. In the dialog, choose "Merge" or "New pattern"
4. Assign the pattern to a channel with your synth/instrument loaded
5. Press F5 or click Play to hear it`;
// ── Tool implementations ──────────────────────────────────────────────────────
function generateMidiMelody(params) {
    try {
        const key = params.key ?? 'C';
        const scale = params.scale ?? 'minor';
        const tempo = Math.min(Math.max(params.tempo ?? 120, 40), 300);
        const bars = Math.min(Math.max(params.bars ?? 4, 1), 16);
        const ticksPerBeat = 480;
        const ticksPerBar = ticksPerBeat * 4;
        const totalTicks = ticksPerBar * bars;
        const notes = scaleNotes(key, scale, 4);
        // Deterministic melody using a pseudo-random walk
        const melody = [];
        let tick = 0;
        let noteIdx = 0;
        const durations = [ticksPerBeat / 2, ticksPerBeat, ticksPerBeat * 2, ticksPerBeat / 4];
        let seed = NOTE_MAP[key] ?? 0;
        const rand = () => { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; };
        while (tick < totalTicks) {
            const dur = durations[Math.floor(rand() * durations.length)];
            if (tick + dur > totalTicks)
                break;
            const step = Math.floor(rand() * 5) - 2; // -2 to +2 steps
            noteIdx = Math.max(0, Math.min(notes.length - 1, noteIdx + step));
            const pitch = notes[noteIdx];
            const velocity = 60 + Math.floor(rand() * 30);
            // Add occasional rest
            if (rand() > 0.8) {
                tick += ticksPerBeat / 2;
                continue;
            }
            melody.push({ pitch, startTick: tick, durationTicks: dur - 20, velocity, channel: 0 });
            tick += dur;
        }
        const buffer = writeMidiFile(melody, tempo, ticksPerBeat);
        const dir = getMidiOutputDir(params.projectFolder ?? null);
        const filename = timestampedFilename(`melody_${key.toLowerCase()}_${scale}`);
        const filePath = saveFile(dir, filename, buffer);
        return {
            status: 'done',
            filePath,
            description: `${bars}-bar ${key} ${scale} melody at ${tempo} BPM. ${melody.length} notes. Saved to ${filePath}`,
            importGuide: FL_STUDIO_GUIDE,
            metadata: { key, scale, tempo, bars, noteCount: melody.length },
        };
    }
    catch (err) {
        return { status: 'error', error: String(err) };
    }
}
function generateChordProgression(params) {
    try {
        const key = params.key ?? 'C';
        const scale = params.scale ?? 'minor';
        const tempo = Math.min(Math.max(params.tempo ?? 120, 40), 300);
        const bars = Math.min(Math.max(params.bars ?? 4, 1), 16);
        const ticksPerBeat = 480;
        const ticksPerBar = ticksPerBeat * 4;
        const root = NOTE_MAP[key] ?? 0;
        const scaleIntervals = SCALE_INTERVALS[scale] ?? SCALE_INTERVALS.minor;
        // Progression: roman numerals → scale degrees
        const progressionStr = params.progression ?? (scale === 'minor' ? 'i-VI-III-VII' : 'I-V-vi-IV');
        const DEGREE_MAP = {
            i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6,
            I: 0, II: 1, III: 2, IV: 3, V: 4, VI: 5, VII: 6,
        };
        const chordQuality = (degree) => {
            const isMinor = degree === degree.toLowerCase();
            return isMinor ? CHORD_INTERVALS.minor : CHORD_INTERVALS.major;
        };
        const degrees = progressionStr.split(/[-,\s]+/).filter(Boolean);
        const notes = [];
        const ticksPerChord = ticksPerBar * Math.max(1, Math.floor(bars / degrees.length));
        degrees.forEach((deg, i) => {
            const degIdx = DEGREE_MAP[deg] ?? 0;
            const scaleStep = scaleIntervals[degIdx % scaleIntervals.length];
            const chordRoot = 48 + root + scaleStep; // octave 3-4
            const intervals = chordQuality(deg);
            const tick = i * ticksPerChord;
            intervals.forEach((interval) => {
                notes.push({
                    pitch: chordRoot + interval,
                    startTick: tick,
                    durationTicks: ticksPerChord - 20,
                    velocity: 70,
                    channel: 0,
                });
            });
        });
        const buffer = writeMidiFile(notes, tempo, ticksPerBeat);
        const dir = getMidiOutputDir(params.projectFolder ?? null);
        const prog = progressionStr.replace(/[^a-zA-Z0-9-]/g, '_');
        const filename = timestampedFilename(`chords_${key.toLowerCase()}_${prog}`);
        const filePath = saveFile(dir, filename, buffer);
        return {
            status: 'done',
            filePath,
            description: `${progressionStr} in ${key} ${scale} at ${tempo} BPM. Saved to ${filePath}`,
            importGuide: FL_STUDIO_GUIDE,
            metadata: { key, scale, tempo, bars, progression: progressionStr },
        };
    }
    catch (err) {
        return { status: 'error', error: String(err) };
    }
}
function generateDrumPattern(params) {
    try {
        const patternType = params.pattern_type ?? 'trap';
        const tempo = Math.min(Math.max(params.tempo ?? 140, 40), 300);
        const bars = Math.min(Math.max(params.bars ?? 2, 1), 8);
        const ticksPerBeat = 480;
        const ticksPerBar = ticksPerBeat * 4;
        const step = ticksPerBeat / 4; // 16th note
        // GM drum map
        const KICK = 36, SNARE = 38, HIHAT = 42, OPEN_HAT = 46, CLAP = 39, RIDE = 51, CRASH = 49;
        const PATTERNS = {
            trap: {
                [KICK]: [0, 6, 10, 14],
                [SNARE]: [4, 12],
                [HIHAT]: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
                [CLAP]: [4, 12],
                [OPEN_HAT]: [8],
            },
            house: {
                [KICK]: [0, 4, 8, 12],
                [SNARE]: [4, 12],
                [HIHAT]: [2, 6, 10, 14],
                [OPEN_HAT]: [0, 8],
                [CLAP]: [4, 12],
            },
            techno: {
                [KICK]: [0, 4, 8, 12],
                [SNARE]: [2, 6, 10, 14],
                [HIHAT]: [0, 2, 4, 6, 8, 10, 12, 14],
                [RIDE]: [1, 3, 5, 7, 9, 11, 13, 15],
                [CRASH]: [0],
            },
            boom_bap: {
                [KICK]: [0, 6, 10],
                [SNARE]: [4, 12],
                [HIHAT]: [0, 3, 6, 9, 12, 15],
                [OPEN_HAT]: [2, 8],
            },
        };
        const grid = PATTERNS[patternType] ?? PATTERNS.trap;
        const notes = [];
        for (let bar = 0; bar < bars; bar++) {
            const barOffset = bar * ticksPerBar;
            for (const [pitchStr, steps] of Object.entries(grid)) {
                const pitch = Number(pitchStr);
                for (const stepIdx of steps) {
                    notes.push({
                        pitch,
                        startTick: barOffset + stepIdx * step,
                        durationTicks: step - 10,
                        velocity: pitch === KICK ? 100 : pitch === SNARE ? 90 : 70,
                        channel: 9, // GM drums channel
                    });
                }
            }
        }
        const buffer = writeMidiFile(notes, tempo, ticksPerBeat);
        const dir = getMidiOutputDir(params.projectFolder ?? null);
        const filename = timestampedFilename(`drums_${patternType}_${tempo}bpm`);
        const filePath = saveFile(dir, filename, buffer);
        return {
            status: 'done',
            filePath,
            description: `${bars}-bar ${patternType} drum pattern at ${tempo} BPM. Saved to ${filePath}`,
            importGuide: `${FL_STUDIO_GUIDE}\n\nFor drums: assign the pattern to a channel with FPC or a drum sampler loaded. Channel 10 is GM drums.`,
            metadata: { patternType, tempo, bars },
        };
    }
    catch (err) {
        return { status: 'error', error: String(err) };
    }
}
function revealProjectFolder(projectFolder) {
    const dir = projectFolder ?? path_1.default.join(electron_1.app.getPath('music'), 'Wavi', 'MIDI', 'Wavi_MIDI');
    try {
        fs_1.default.mkdirSync(dir, { recursive: true });
        const { shell } = require('electron');
        shell.openPath(dir);
        return {
            status: 'done',
            filePath: dir,
            description: `Opened: ${dir}`,
        };
    }
    catch (err) {
        return { status: 'error', error: String(err) };
    }
}
function explainImportToFlStudio() {
    return {
        status: 'done',
        description: `How to import MIDI into FL Studio:

1. Open FL Studio
2. Go to File → Import → MIDI File (or press Ctrl+I)
3. Browse to ~/Music/Wavi/MIDI/Wavi_MIDI/
4. Select your .mid file and click Open
5. In the import dialog:
   - For melody/chords: choose "Add to playlist as audio clip" or drag to Piano Roll
   - For drums: assign channel 10 to an FPC or drum sampler
6. Double-click any pattern to open the Piano Roll and edit notes
7. Adjust quantization with Ctrl+Q if needed

Pro tip: You can also drag .mid files directly from Finder into the FL Studio Piano Roll.`,
        importGuide: FL_STUDIO_GUIDE,
    };
}
function summarizeProjectContext(context) {
    const lines = [];
    if (context.projectName) {
        lines.push(`Project: ${context.projectName}`);
    }
    else {
        lines.push('No project currently active.');
        return { status: 'done', description: lines.join('\n') };
    }
    if (context.dawType)
        lines.push(`DAW: ${context.dawType}`);
    lines.push(`Local versions: ${context.versionCount}`);
    lines.push(`Tracked files: ${context.fileCount}`);
    if (context.lastSyncedAt) {
        const diff = Date.now() - new Date(context.lastSyncedAt).getTime();
        const mins = Math.floor(diff / 60000);
        const label = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`;
        lines.push(`Last synced: ${label}`);
    }
    else {
        lines.push('Not yet synced to cloud');
    }
    if (context.cloudVersions?.length) {
        lines.push(`\nCloud versions (${context.cloudVersions.length}):`);
        context.cloudVersions.slice(0, 3).forEach((v) => {
            const d = new Date(v.syncedAt).toLocaleDateString();
            lines.push(`  v${v.versionNumber} — ${d}`);
        });
        if (context.cloudVersions.length > 3) {
            lines.push(`  … and ${context.cloudVersions.length - 3} more`);
        }
    }
    return { status: 'done', description: lines.join('\n') };
}
