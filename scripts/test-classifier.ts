/**
 * Validation tests for Project Association Engine Phase 1
 * Run with: npx ts-node --project tsconfig.electron.json scripts/test-classifier.ts
 *
 * Tests classifyFile() + parseFileName() against real-world music folder cases.
 * Exits with code 1 if any assertion fails.
 */

import { statSync, mkdirSync, writeFileSync, rmSync, type Stats } from 'fs';
import path from 'path';
import os from 'os';
import { classifyFile }  from '../electron/projectAssociation/fileClassifier';
import { parseFileName } from '../electron/projectAssociation/namingParser';

// ── Tiny test harness ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${detail ? `  →  ${detail}` : ''}`);
    failed++;
  }
}

// ── Temp dir for fake files ───────────────────────────────────────────────────
// classifyFile() takes fs.Stats — we create real zero-byte temp files so statSync works.

const TMP = path.join(os.tmpdir(), 'wavio-classifier-test');

function mkfile(relPath: string): { filePath: string; stat: Stats } {
  const filePath = path.join(TMP, relPath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, '');
  return { filePath, stat: statSync(filePath) as Stats };
}

try {
  mkdirSync(TMP, { recursive: true });

  // ── 1. DAW project files ────────────────────────────────────────────────────
  console.log('\n── DAW Projects ──');

  {
    const { filePath, stat } = mkfile('Drake type beat.flp');
    const r = classifyFile(filePath, stat);
    assert('.flp → daw_project', r.role === 'daw_project', `got ${r.role}`);
    assert('.flp confidence ≥ 0.90', r.confidence >= 0.90, `got ${r.confidence}`);
  }

  for (const ext of ['.als', '.logic', '.rpp', '.ptx', '.cpr', '.band']) {
    const { filePath, stat } = mkfile(`Project${ext}`);
    const r = classifyFile(filePath, stat);
    assert(`${ext} → daw_project`, r.role === 'daw_project', `got ${r.role}`);
  }

  // ── 2. MIDI ──────────────────────────────────────────────────────────────────
  console.log('\n── MIDI ──');

  {
    const { filePath, stat } = mkfile('808 pattern.mid');
    const r = classifyFile(filePath, stat);
    assert('.mid → midi', r.role === 'midi', `got ${r.role}`);
    assert('.mid confidence ≥ 0.90', r.confidence >= 0.90, `got ${r.confidence}`);
  }

  {
    const { filePath, stat } = mkfile('melody hook.midi');
    const r = classifyFile(filePath, stat);
    assert('.midi → midi', r.role === 'midi', `got ${r.role}`);
  }

  // ── 3. Stems by folder ───────────────────────────────────────────────────────
  console.log('\n── Stems (folder context) ──');

  {
    const { filePath, stat } = mkfile('stems/Kick.wav');
    const r = classifyFile(filePath, stat);
    assert('Kick.wav in stems/ → stem', r.role === 'stem', `got ${r.role}`);
    assert('stem confidence ≥ 0.80', r.confidence >= 0.80, `got ${r.confidence}`);
    assert('signals.isInStemsFolder = true', r.signals.isInStemsFolder === true);
  }

  {
    const { filePath, stat } = mkfile('stems/Snare.wav');
    const r = classifyFile(filePath, stat);
    assert('Snare.wav in stems/ → stem', r.role === 'stem', `got ${r.role}`);
  }

  {
    const { filePath, stat } = mkfile('stems/Melody Loop.wav');
    const r = classifyFile(filePath, stat);
    assert('Melody Loop.wav in stems/ → stem', r.role === 'stem', `got ${r.role}`);
  }

  // ── 4. Stems by filename ─────────────────────────────────────────────────────
  console.log('\n── Stems (filename patterns) ──');

  for (const name of ['Kick.wav', 'Snare.wav', 'Hi-Hat.wav', 'Bass.wav', 'Synth Lead.wav', 'Drums.wav']) {
    const { filePath, stat } = mkfile(name);
    const r = classifyFile(filePath, stat);
    assert(`${name} → stem`, r.role === 'stem', `got ${r.role}`);
  }

  // ── 5. Master (FINAL flag) ───────────────────────────────────────────────────
  console.log('\n── Master / Final ──');

  {
    const { filePath, stat } = mkfile('BOUNCE 2 loud FINAL v2.wav');
    const r = classifyFile(filePath, stat);
    assert('FINAL v2.wav → master', r.role === 'master', `got ${r.role}`);
    assert('isFinal token = true', r.tokens.isFinal === true);
    assert('versionNumber = 2', r.tokens.versionNumber === 2);
  }

  {
    const { filePath, stat } = mkfile('Song FINAL.wav');
    const r = classifyFile(filePath, stat);
    assert('Song FINAL.wav → master', r.role === 'master', `got ${r.role}`);
  }

  {
    const { filePath, stat } = mkfile('masters/Track master.wav');
    const r = classifyFile(filePath, stat);
    assert('Track master.wav in masters/ → master', r.role === 'master', `got ${r.role}`);
  }

  // ── 6. Artwork ───────────────────────────────────────────────────────────────
  console.log('\n── Artwork ──');

  for (const name of ['coverart.png', 'cover.jpg', 'artwork.jpeg', 'thumb.png']) {
    const { filePath, stat } = mkfile(name);
    const r = classifyFile(filePath, stat);
    assert(`${name} → artwork`, r.role === 'artwork', `got ${r.role}`);
    assert(`${name} confidence ≥ 0.90`, r.confidence >= 0.90, `got ${r.confidence}`);
  }

  // ── 7. Lyrics ────────────────────────────────────────────────────────────────
  console.log('\n── Lyrics ──');

  {
    const { filePath, stat } = mkfile('lyrics draft.txt');
    const r = classifyFile(filePath, stat);
    assert('lyrics draft.txt → lyrics', r.role === 'lyrics', `got ${r.role}`);
  }

  {
    const { filePath, stat } = mkfile('verse notes.docx');
    const r = classifyFile(filePath, stat);
    assert('verse notes.docx → lyrics (.docx ext)', r.role === 'lyrics', `got ${r.role}`);
  }

  // ── 8. Plugin preset ─────────────────────────────────────────────────────────
  console.log('\n── Plugin Presets ──');

  {
    const { filePath, stat } = mkfile('plugin_preset_kick.fxp');
    const r = classifyFile(filePath, stat);
    assert('.fxp → plugin_preset', r.role === 'plugin_preset', `got ${r.role}`);
  }

  {
    const { filePath, stat } = mkfile('bass.nki');
    const r = classifyFile(filePath, stat);
    assert('.nki → plugin_preset', r.role === 'plugin_preset', `got ${r.role}`);
  }

  // ── 9. Reference ─────────────────────────────────────────────────────────────
  console.log('\n── Reference ──');

  {
    const { filePath, stat } = mkfile('melody ref.mp3');
    const r = classifyFile(filePath, stat);
    assert('melody ref.mp3 → reference', r.role === 'reference', `got ${r.role}`);
  }

  {
    const { filePath, stat } = mkfile('inspo track.wav');
    const r = classifyFile(filePath, stat);
    assert('inspo track.wav → reference', r.role === 'reference', `got ${r.role}`);
  }

  // ── 10. Bounce / export folder ───────────────────────────────────────────────
  console.log('\n── Bounce (export folder) ──');

  {
    const { filePath, stat } = mkfile('bounces/BOUNCE 1.wav');
    const r = classifyFile(filePath, stat);
    assert('BOUNCE 1.wav in bounces/ → bounce', r.role === 'bounce', `got ${r.role}`);
  }

  {
    const { filePath, stat } = mkfile('exports/Mix v3.wav');
    const r = classifyFile(filePath, stat);
    assert('Mix v3.wav in exports/ → bounce', r.role === 'bounce', `got ${r.role}`);
  }

  // ── 11. Vocal take ────────────────────────────────────────────────────────────
  console.log('\n── Vocal Takes ──');

  {
    const { filePath, stat } = mkfile('Verse 1 Vox take 3.wav');
    const r = classifyFile(filePath, stat);
    assert('Vox take 3.wav → vocal_take', r.role === 'vocal_take', `got ${r.role}`);
  }

  {
    const { filePath, stat } = mkfile('vocals/lead vocal.wav');
    const r = classifyFile(filePath, stat);
    assert('lead vocal.wav in vocals/ → vocal_take', r.role === 'vocal_take', `got ${r.role}`);
  }

  // ── 12. Naming parser — version tokens ───────────────────────────────────────
  console.log('\n── Naming Parser ──');

  {
    const t = parseFileName('Drake type beat BOUNCE 2 loud FINAL v2.wav');
    assert('versionNumber = 2', t.versionNumber === 2, `got ${t.versionNumber}`);
    assert('isFinal = true', t.isFinal === true, `got ${t.isFinal}`);
    assert('roleSignal = bounce', t.roleSignal === 'bounce', `got ${t.roleSignal}`);
    assert('descriptor includes loud', t.descriptors.includes('loud'), `got ${t.descriptors}`);
  }

  {
    const t = parseFileName('session rough mix v3');
    assert('roleSignal = mix', t.roleSignal === 'mix', `got ${t.roleSignal}`);
    assert('versionNumber = 3', t.versionNumber === 3, `got ${t.versionNumber}`);
    assert('descriptor includes rough', t.descriptors.includes('rough'), `got ${t.descriptors}`);
  }

  {
    const t = parseFileName('Kick Drum');
    assert('Kick → stem signal', t.roleSignal === 'stem', `got ${t.roleSignal}`);
  }

  {
    const t = parseFileName('Song FINAL_FINAL mastered.wav');
    assert('FINAL_FINAL isFinal = true', t.isFinal === true, `got ${t.isFinal}`);
  }

  {
    const t = parseFileName('Project v1');
    assert('v1 → versionNumber 1', t.versionNumber === 1, `got ${t.versionNumber}`);
  }

} finally {
  rmSync(TMP, { recursive: true, force: true });
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`);
console.log(`  PASSED: ${passed}   FAILED: ${failed}`);
console.log(`${'─'.repeat(52)}\n`);

if (failed > 0) process.exit(1);
