"use strict";
/**
 * Naming Convention Parser
 *
 * Extracts structured tokens from music file/folder names.
 * Pure string matching — no external dependencies, no I/O.
 *
 * Examples:
 *   "Drake type beat BOUNCE 2 loud FINAL v2.wav"
 *     → { roleSignal: 'bounce', sequenceNumber: 2, versionNumber: 2, isFinal: true, descriptors: ['loud'] }
 *
 *   "Kick.wav" → { roleSignal: 'stem', descriptors: ['kick'] }
 *   "session rough mix v3" → { roleSignal: 'mix', versionNumber: 3, descriptors: ['rough'] }
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFileName = parseFileName;
// ── Role signal patterns ────────────────────────────────────────────────────
const ROLE_PATTERNS = [
    { signal: 'master', re: /\b(master|mastered|mastering|mast)\b/i },
    { signal: 'bounce', re: /\b(bounce|bounced|export|render|rendered)\b/i },
    { signal: 'lyrics', re: /\b(lyric|lyrics|song[_\-]?words)\b/i },
    { signal: 'mix', re: /\b(mix|mixed|mixdown|mix[_\-]?down|rough[_\-]?mix|rough|wip|demo|revision|rev\d*)\b/i },
    { signal: 'reference', re: /\b(ref(?!rain)|reference|references|inspo|inspiration|inspired|sample[_\-]?ref)\b/i },
    { signal: 'vocal_take', re: /\b(vox|vocal|vocals|take(?:\s*\d+)?|comp|adlib|ad[_\-]?lib|harmony|harmonies|bgv|bg[_\-]?vox|acapella|acappella|a[_\-]?cap)\b/i },
    { signal: 'stem', re: /\b(stem|stems|kick|snare|hi[_\-]?hat|hihat|hi\s+hat|clap|cymbal|perc|percussion|bass|sub|808|lead|pad|synth|keys|piano|guitar|strings|brass|fx|drums?|drum[_\-]?bus|melody|melodies)\b/i },
    { signal: 'midi', re: /\b(midi|mid)\b/i },
    { signal: 'artwork', re: /\b(cover|art|artwork|coverart|thumb|thumbnail|artwork|visual)\b/i },
    { signal: 'plugin_preset', re: /\b(preset|patch|bank|program|fxp|nki|nkm)\b/i },
    { signal: 'beat', re: /\b(beat|beats|instrumental|instru|prod[_\-]?by|type[_\-]?beat)\b/i },
    { signal: 'sample', re: /\b(sample|samples|smp|loop|loops|one[_\-]?shot|oneshot|break|breakbeat|fill)\b/i },
];
// ── Version patterns ────────────────────────────────────────────────────────
const VERSION_RE = /\bv(\d+)\b/i;
const VERSION2_RE = /\bversion[_\-\s]?(\d+)\b/i;
const SEQUENCE_RE = /(?:^|\s)(\d+)(?:\s|$)/;
// ── Final patterns ──────────────────────────────────────────────────────────
const FINAL_RE = /\b(final|finished|release|delivered|mastered|dist(?:ribution)?|final[_\-]?final|final[_\-]?v\d*)\b/i;
// ── Descriptor words (quality/descriptive, not role) ───────────────────────
const DESCRIPTOR_WORDS = new Set([
    'loud', 'quiet', 'clean', 'dirty', 'hard', 'soft', 'dark', 'bright',
    'heavy', 'light', 'warm', 'cold', 'wet', 'dry', 'full', 'thin',
    'rough', 'smooth', 'raw', 'polished', 'demo', 'wip', 'sketch',
    'old', 'new', 'revised', 'updated', 'revised', 'fixed', 'alt',
    'alternative', 'main', 'secondary', 'bonus', 'extra',
]);
// ── Separator normalisation ─────────────────────────────────────────────────
function normalise(name) {
    return name
        .replace(/\.[^.]+$/, '') // strip extension
        .replace(/[_\-]+/g, ' ') // underscores/dashes → space
        .replace(/\s+/g, ' ') // collapse whitespace
        .trim();
}
// ── Artist/song hint heuristic ──────────────────────────────────────────────
// Heuristic: the leading capitalized word-cluster before the first role/version
// token is a likely artist/song hint.  This is intentionally fuzzy.
function extractArtistSongHint(raw, roleIdx) {
    const beforeRole = roleIdx > 0 ? raw.slice(0, roleIdx).trim() : raw.trim();
    const words = beforeRole.split(/\s+/).filter(Boolean);
    if (!words.length)
        return { artistHint: null, songHint: null };
    // First capitalised word is artist hint, rest is song hint
    const firstCap = words[0];
    const artistHint = /^[A-Z]/.test(firstCap) ? firstCap : null;
    const songWords = artistHint ? words.slice(1) : words;
    const songHint = songWords.length ? songWords.join(' ') : null;
    return {
        artistHint: artistHint || null,
        songHint: songHint || null,
    };
}
// ── Main export ─────────────────────────────────────────────────────────────
function parseFileName(name) {
    const norm = normalise(name);
    // Version number
    let versionNumber = null;
    const vMatch = VERSION_RE.exec(norm) ?? VERSION2_RE.exec(norm);
    if (vMatch)
        versionNumber = parseInt(vMatch[1], 10);
    // Final flag
    const isFinal = FINAL_RE.test(norm);
    // Sequence number (plain integer, only when no explicit v-number found)
    let sequenceNumber = null;
    if (!versionNumber) {
        const sMatch = SEQUENCE_RE.exec(norm);
        if (sMatch)
            sequenceNumber = parseInt(sMatch[1], 10);
    }
    // Role signal — first match wins (priority ordered in ROLE_PATTERNS)
    let roleSignal = null;
    let roleIdx = -1;
    for (const { signal, re } of ROLE_PATTERNS) {
        const m = re.exec(norm);
        if (m) {
            roleSignal = signal;
            roleIdx = m.index;
            break;
        }
    }
    // Artist/song hints
    const { artistHint, songHint } = extractArtistSongHint(norm, roleIdx >= 0 ? roleIdx : norm.length);
    // Descriptors — words from the normalised name that are in DESCRIPTOR_WORDS
    const rawTokens = norm.split(/\s+/).filter(Boolean);
    const descriptors = rawTokens.filter(w => DESCRIPTOR_WORDS.has(w.toLowerCase()));
    return {
        songHint,
        artistHint,
        versionNumber,
        isFinal,
        sequenceNumber,
        roleSignal,
        descriptors,
        rawTokens,
    };
}
