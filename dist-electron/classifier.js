"use strict";
/**
 * File classifier — determines audio file role based on filename patterns.
 * Returns one of: 'stem' | 'mix' | 'master' | 'reference' | 'sample' | 'unknown'
 * No external deps, pure string matching.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyFile = classifyFile;
const STEM_PATTERNS = [
    /\b(stem|stems)\b/i,
    /\b(kick|snare|hihat|hi[_-]?hat|clap|cymbal|perc|percussion)\b/i,
    /\b(bass|sub|808)\b/i,
    /\b(lead|pad|synth|keys|piano|guitar|strings|brass|fx)\b/i,
    /\b(vocal|vox|bgv|bg[_-]?vox|adlib|ad[_-]?lib|harmony|harmonies)\b/i,
    /\b(drums?|drum[_-]?bus)\b/i,
    /\b(melody|melodies)\b/i,
];
const MIX_PATTERNS = [
    /\b(mix|mixed|mixdown|mix[_-]?down)\b/i,
    /\b(rough[_-]?mix|rough)\b/i,
    /\b(v\d+|version[_-]?\d+)\b/i,
    /\b(wip|work[_-]?in[_-]?progress)\b/i,
    /\b(draft|revision|rev\d*)\b/i,
];
const MASTER_PATTERNS = [
    /\b(master|mastered|mastering)\b/i,
    /\b(final|finished|release|delivered)\b/i,
    /\b(dist|distribution)\b/i,
];
const REFERENCE_PATTERNS = [
    /\b(ref|reference|references)\b/i,
    /\b(inspo|inspiration|inspired)\b/i,
    /\b(sample[_-]?ref|reference[_-]?track)\b/i,
];
const SAMPLE_PATTERNS = [
    /\b(sample|samples|smp)\b/i,
    /\b(loop|loops|one[_-]?shot|oneshot)\b/i,
    /\b(break|breakbeat|fill)\b/i,
    /\b(acapella|acappella|a[_-]?cap)\b/i,
];
function classifyFile(fileName) {
    const name = fileName.replace(/\.[^.]+$/, ''); // strip extension
    if (MASTER_PATTERNS.some(r => r.test(name)))
        return 'master';
    if (MIX_PATTERNS.some(r => r.test(name)))
        return 'mix';
    if (STEM_PATTERNS.some(r => r.test(name)))
        return 'stem';
    if (REFERENCE_PATTERNS.some(r => r.test(name)))
        return 'reference';
    if (SAMPLE_PATTERNS.some(r => r.test(name)))
        return 'sample';
    return 'unknown';
}
