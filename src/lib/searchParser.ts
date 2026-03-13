/**
 * AI-powered natural language search parser for audio library.
 * Runs 100% locally — no API key required.
 *
 * Understands queries like:
 *   "140 bpm g# beats"
 *   "slow trap stems under 3 minutes"
 *   "minor key samples"
 *   "drums 90-120 bpm"
 *   "c major mix"
 *   "fast bass loops"
 */

export interface ParsedQuery {
  text: string;                   // remaining free-text after extracting structured tokens
  bpmMin?: number;
  bpmMax?: number;
  bpmExact?: number;
  key?: string;                   // e.g. "G#", "Db", "C"
  mode?: 'major' | 'minor';
  roles: string[];                // stem, mix, master, sample, reference
  fileTypes: string[];            // wav, mp3, flac, ...
  durationMaxSecs?: number;
  durationMinSecs?: number;
  tempoLabel?: 'slow' | 'mid' | 'fast';
}

// ── Lookup tables ─────────────────────────────────────────────────────────────

const ROLE_ALIASES: Record<string, string> = {
  beat: 'mix', beats: 'mix', track: 'mix', tracks: 'mix', song: 'mix', songs: 'mix',
  stem: 'stem', stems: 'stem',
  mix: 'mix', mixes: 'mix', mixdown: 'mix',
  master: 'master', masters: 'master', mastered: 'master',
  sample: 'sample', samples: 'sample', loop: 'sample', loops: 'sample', chop: 'sample', chops: 'sample',
  ref: 'reference', reference: 'reference', references: 'reference',
  drum: 'stem', drums: 'stem', kick: 'stem', snare: 'stem', hi_hat: 'stem',
  bass: 'stem', lead: 'stem', vocals: 'stem', vocal: 'stem', vox: 'stem',
  guitar: 'stem', keys: 'stem', piano: 'stem', synth: 'stem',
};

const KEY_NAMES = [
  'C#', 'Db', 'D#', 'Eb', 'F#', 'Gb', 'G#', 'Ab', 'A#', 'Bb',
  'C', 'D', 'E', 'F', 'G', 'A', 'B',
];

// map enharmonic equivalents to canonical form
const KEY_CANONICAL: Record<string, string> = {
  'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#',
};

const TEMPO_LABELS: Record<string, { min: number; max: number; label: 'slow' | 'mid' | 'fast' }> = {
  slow: { min: 0, max: 89, label: 'slow' },
  chill: { min: 0, max: 89, label: 'slow' },
  mellow: { min: 0, max: 89, label: 'slow' },
  mid: { min: 90, max: 119, label: 'mid' },
  medium: { min: 90, max: 119, label: 'mid' },
  moderate: { min: 90, max: 119, label: 'mid' },
  fast: { min: 120, max: 999, label: 'fast' },
  upbeat: { min: 120, max: 999, label: 'fast' },
  quick: { min: 120, max: 999, label: 'fast' },
  hype: { min: 140, max: 999, label: 'fast' },
};

const GENRE_BPM_HINTS: Record<string, { min: number; max: number }> = {
  trap: { min: 130, max: 170 },
  drill: { min: 135, max: 155 },
  hip_hop: { min: 75, max: 100 },
  hiphop: { min: 75, max: 100 },
  'hip-hop': { min: 75, max: 100 },
  rap: { min: 75, max: 100 },
  rnb: { min: 65, max: 90 },
  'r&b': { min: 65, max: 90 },
  soul: { min: 60, max: 100 },
  pop: { min: 100, max: 130 },
  edm: { min: 120, max: 150 },
  house: { min: 120, max: 135 },
  techno: { min: 130, max: 160 },
  dnb: { min: 160, max: 180 },
  'drum and bass': { min: 160, max: 180 },
  jungle: { min: 160, max: 180 },
  dubstep: { min: 138, max: 142 },
  reggae: { min: 60, max: 90 },
  afrobeats: { min: 95, max: 115 },
  afro: { min: 95, max: 115 },
  dancehall: { min: 95, max: 115 },
  amapiano: { min: 112, max: 116 },
  jersey: { min: 130, max: 145 },
};

const FILE_TYPE_ALIASES: Record<string, string> = {
  wav: 'wav', wave: 'wav',
  mp3: 'mp3',
  flac: 'flac',
  aiff: 'aiff', aif: 'aiff',
  m4a: 'm4a', aac: 'm4a',
  midi: 'midi', mid: 'midi',
};

// ── Parser ────────────────────────────────────────────────────────────────────

export function parseSearchQuery(raw: string): ParsedQuery {
  const result: ParsedQuery = { text: '', roles: [], fileTypes: [] };
  const tokens = raw.toLowerCase().trim().split(/\s+/);
  const consumed = new Set<number>();

  // ── BPM: "140", "140bpm", "140 bpm", "90-120", "90-120bpm", "~140", "around 140" ──
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // range: "90-120" or "90-120bpm"
    const rangeMatch = t.match(/^(\d{2,3})-(\d{2,3})(?:bpm)?$/);
    if (rangeMatch) {
      result.bpmMin = parseInt(rangeMatch[1]);
      result.bpmMax = parseInt(rangeMatch[2]);
      consumed.add(i);
      // eat following "bpm" token if present
      if (tokens[i + 1] === 'bpm') consumed.add(++i);
      continue;
    }
    // exact: "140bpm" or "140"
    const exactMatch = t.match(/^~?(\d{2,3})(?:bpm)?$/);
    if (exactMatch) {
      const bpm = parseInt(exactMatch[1]);
      if (bpm >= 40 && bpm <= 300) {
        // check next token = "bpm" or prev = "around"/"~"
        const nextIsBpm = tokens[i + 1] === 'bpm';
        const prevIsAround = i > 0 && ['around', 'about', '~', 'approx'].includes(tokens[i - 1]);
        if (nextIsBpm || t.endsWith('bpm') || t.startsWith('~') || prevIsAround ||
            (i + 1 < tokens.length && tokens[i + 1] === 'bpm')) {
          result.bpmExact = bpm;
          consumed.add(i);
          if (nextIsBpm) consumed.add(i + 1);
          continue;
        }
        // standalone number — only treat as BPM if range 60-200
        if (bpm >= 60 && bpm <= 200) {
          result.bpmExact = bpm;
          consumed.add(i);
          continue;
        }
      }
    }
    // "bpm" alone (skip)
    if (t === 'bpm' && consumed.has(i - 1)) { consumed.add(i); continue; }
  }

  // ── Key: "g#", "g# major", "db minor", "c", "f#m" ──
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const t = tokens[i];

    // shorthand: "f#m" or "gbm"
    const shortMinor = t.match(/^([a-g][#b]?)m$/);
    if (shortMinor) {
      result.key = normalizeKey(shortMinor[1]);
      result.mode = 'minor';
      consumed.add(i);
      continue;
    }

    // key name possibly followed by major/minor
    const keyCandidate = t.match(/^([a-g][#b]?)$/);
    if (keyCandidate) {
      const normalized = normalizeKey(keyCandidate[1]);
      if (normalized) {
        result.key = normalized;
        consumed.add(i);
        // check next token for major/minor
        if (i + 1 < tokens.length) {
          const next = tokens[i + 1];
          if (next === 'major' || next === 'maj') { result.mode = 'major'; consumed.add(i + 1); }
          else if (next === 'minor' || next === 'min') { result.mode = 'minor'; consumed.add(i + 1); }
        }
        continue;
      }
    }

    // standalone "major" / "minor"
    if ((t === 'major' || t === 'maj') && !result.mode) { result.mode = 'major'; consumed.add(i); continue; }
    if ((t === 'minor' || t === 'min') && !result.mode) { result.mode = 'minor'; consumed.add(i); continue; }
  }

  // ── Duration: "under 3 minutes", "3min", "less than 2 mins", "over 5 minutes" ──
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const t = tokens[i];

    // "3min", "3mins", "3minutes", "3m"
    const durSelf = t.match(/^(\d+(?:\.\d+)?)(m(?:in(?:s|utes?)?)?)$/);
    if (durSelf) {
      const secs = parseFloat(durSelf[1]) * 60;
      // if preceded by under/less/shorter → max, else over/longer → min
      const prev = i > 0 ? tokens[i - 1] : '';
      if (['under', 'less', 'shorter', 'below', '<'].includes(prev)) {
        result.durationMaxSecs = secs;
        consumed.add(i - 1);
      } else if (['over', 'longer', 'above', 'more', '>'].includes(prev)) {
        result.durationMinSecs = secs;
        consumed.add(i - 1);
      } else {
        result.durationMaxSecs = secs;
      }
      consumed.add(i);
      continue;
    }

    // "under", "over" followed by number then "minute(s)"
    if (['under', 'less', 'shorter', 'below', '<'].includes(t)) {
      const num = parseFloat(tokens[i + 1] ?? '');
      const unit = tokens[i + 2] ?? '';
      if (!isNaN(num) && unit.startsWith('m')) {
        result.durationMaxSecs = num * 60;
        consumed.add(i); consumed.add(i + 1); consumed.add(i + 2);
        continue;
      }
    }
    if (['over', 'longer', 'above', 'more', '>'].includes(t)) {
      const num = parseFloat(tokens[i + 1] ?? '');
      const unit = tokens[i + 2] ?? '';
      if (!isNaN(num) && unit.startsWith('m')) {
        result.durationMinSecs = num * 60;
        consumed.add(i); consumed.add(i + 1); consumed.add(i + 2);
        continue;
      }
    }
  }

  // ── Roles ──
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const role = ROLE_ALIASES[tokens[i]];
    if (role && !result.roles.includes(role)) {
      result.roles.push(role);
      consumed.add(i);
    }
  }

  // ── File types ──
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const ft = FILE_TYPE_ALIASES[tokens[i]];
    if (ft && !result.fileTypes.includes(ft)) {
      result.fileTypes.push(ft);
      consumed.add(i);
    }
  }

  // ── Tempo labels ──
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const tl = TEMPO_LABELS[tokens[i]];
    if (tl && result.bpmMin === undefined && result.bpmMax === undefined && result.bpmExact === undefined) {
      result.bpmMin = tl.min;
      result.bpmMax = tl.max;
      result.tempoLabel = tl.label;
      consumed.add(i);
    }
  }

  // ── Genre BPM hints ──
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const genre = GENRE_BPM_HINTS[tokens[i]];
    if (genre && result.bpmMin === undefined && result.bpmMax === undefined && result.bpmExact === undefined) {
      result.bpmMin = genre.min;
      result.bpmMax = genre.max;
      consumed.add(i);
    }
  }

  // ── Remaining tokens = free text ──
  result.text = tokens
    .filter((_, i) => !consumed.has(i))
    .join(' ')
    .trim();

  return result;
}

function normalizeKey(raw: string): string | undefined {
  const upper = raw.charAt(0).toUpperCase() + raw.slice(1).replace('b', 'b');
  // e.g. "g#" → "G#"
  const capitalized = raw.charAt(0).toUpperCase() + raw.slice(1);
  const withSharp = capitalized.replace(/s$/, '#'); // "gs" → "G#"

  // Try canonical and enharmonic
  for (const k of KEY_NAMES) {
    if (k.toLowerCase() === raw.toLowerCase() ||
        k.toLowerCase() === raw.replace('#', '#').toLowerCase()) {
      return KEY_CANONICAL[k] ?? k;
    }
  }
  return undefined;
}

// ── Filter function ───────────────────────────────────────────────────────────

import type { LibraryFile } from '../types';

export function filterFiles(files: LibraryFile[], query: ParsedQuery): LibraryFile[] {
  return files.filter((f) => {
    // BPM exact (±5 tolerance)
    if (query.bpmExact !== undefined && f.bpm !== null) {
      if (Math.abs(f.bpm - query.bpmExact) > 5) return false;
    } else if (query.bpmExact !== undefined && f.bpm === null) {
      return false;
    }

    // BPM range
    if (query.bpmMin !== undefined && f.bpm !== null && f.bpm < query.bpmMin) return false;
    if (query.bpmMax !== undefined && f.bpm !== null && f.bpm > query.bpmMax) return false;
    if ((query.bpmMin !== undefined || query.bpmMax !== undefined) && f.bpm === null) return false;

    // Key
    if (query.key) {
      if (!f.key_note) return false;
      const fileKey = f.key_note.split(' ')[0]; // "G# minor" → "G#"
      const canonical = KEY_CANONICAL[fileKey] ?? fileKey;
      const queryCanonical = KEY_CANONICAL[query.key] ?? query.key;
      if (canonical !== queryCanonical) return false;
    }

    // Mode (major/minor)
    if (query.mode) {
      if (!f.key_note) return false;
      const keyLower = f.key_note.toLowerCase();
      if (query.mode === 'major' && keyLower.includes('minor')) return false;
      if (query.mode === 'minor' && !keyLower.includes('minor')) return false;
    }

    // Role
    if (query.roles.length > 0 && !query.roles.includes(f.role)) return false;

    // File type
    if (query.fileTypes.length > 0 && !query.fileTypes.includes(f.file_type)) return false;

    // Duration
    if (query.durationMaxSecs !== undefined && f.duration !== null && f.duration > query.durationMaxSecs) return false;
    if (query.durationMinSecs !== undefined && f.duration !== null && f.duration < query.durationMinSecs) return false;

    // Free text — match file name, project name, role
    if (query.text) {
      const needle = query.text.toLowerCase();
      const haystack = [f.file_name, f.project_name ?? '', f.role, f.key_note ?? '']
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    return true;
  });
}

/** Human-readable summary of what was parsed */
export function describeQuery(q: ParsedQuery): string {
  const parts: string[] = [];
  if (q.bpmExact !== undefined) parts.push(`${q.bpmExact} BPM`);
  else if (q.bpmMin !== undefined || q.bpmMax !== undefined) {
    if (q.tempoLabel) parts.push(q.tempoLabel);
    else parts.push(`${q.bpmMin ?? '?'}–${q.bpmMax ?? '?'} BPM`);
  }
  if (q.key) parts.push(`${q.key}${q.mode ? ' ' + q.mode : ''}`);
  else if (q.mode) parts.push(q.mode);
  if (q.roles.length) parts.push(q.roles.join(', '));
  if (q.fileTypes.length) parts.push(q.fileTypes.join(', ').toUpperCase());
  if (q.durationMaxSecs) parts.push(`under ${Math.round(q.durationMaxSecs / 60)}min`);
  if (q.durationMinSecs) parts.push(`over ${Math.round(q.durationMinSecs / 60)}min`);
  if (q.text) parts.push(`"${q.text}"`);
  return parts.join(' · ');
}
