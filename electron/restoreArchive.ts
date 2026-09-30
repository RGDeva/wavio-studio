/**
 * Restore-archive path safety.
 *
 * Extracted from the `restore:start` handler in main.ts so the real
 * implementation can be tested directly. It previously lived inline there and
 * was *mirrored* by hand into restore.security.test.ts ("to avoid Electron
 * bootstrap"), which meant the tests exercised a copy: the predicate was well
 * covered while the code that decides WHICH names ever reach the predicate was
 * not covered at all. That gap hid the defect fixed below.
 *
 * No Electron imports — this module must stay directly importable by vitest.
 */
import path from 'path';

/** Entry names that must never be extracted. */
const FORBIDDEN_PATH_PATTERNS_RESTORE = [
  /\.\./,          // zip-slip — path traversal
  /^\//, /^\\/,    // absolute paths
  /[\0\r\n]/,      // null / newline injection
];

export function isSafeRestorePath(rel: string): boolean {
  return !FORBIDDEN_PATH_PATTERNS_RESTORE.some((rx) => rx.test(rel));
}

/**
 * Belt-and-braces containment check: does `candidate` resolve inside `destDir`?
 * Kept alongside the pattern check because the two fail differently — patterns
 * catch the name, resolution catches the result.
 */
export function isDestinationSafe(destDir: string, candidate: string): boolean {
  const resolved = path.resolve(destDir, candidate);
  const root = path.resolve(destDir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

export type ArchiveEntryScan =
  | { ok: true; entries: string[] }
  | { ok: false; reason: string; offending?: string };

/**
 * Parse the entry names out of `unzip -l` output.
 *
 * The previous inline version did:
 *
 *   listResult.split('\n').slice(3)
 *     .map(l => l.replace(/^\s+\d+\s+[\d-]+\s+[\d:]+\s+/, '').trim())
 *     .filter(n => n && !n.startsWith('---') && !n.includes('files'))
 *
 * Two defects:
 *
 *  1. `!n.includes('files')` was meant to drop the trailing "N files" summary
 *     line, but it drops ANY entry whose name contains that substring. A
 *     crafted entry named `../../../../ESCAPED-files.txt` was therefore never
 *     shown to the validator at all — verified: the validator saw only the one
 *     benign entry and approved the archive. It also silently skipped
 *     legitimate names like `my files/kick.wav`.
 *  2. `.slice(3)` assumes a fixed header height, and a name containing a
 *     newline splits across lines, so the validator inspects fragments rather
 *     than the real path.
 *
 * Containment did hold in practice, because Info-ZIP `unzip` strips `../`
 * itself and exits non-zero — but that made our own control decorative and left
 * safety resting entirely on an external binary's behaviour. This version
 * parses between the two separator rules and cross-checks the entry count the
 * summary declares, so a split or swallowed name fails closed instead.
 */
export function parseZipEntryNames(listOutput: string): ArchiveEntryScan {
  const lines = listOutput.split('\n').map((l) => l.replace(/\r$/, ''));
  const ruleIdx: number[] = [];
  lines.forEach((l, i) => {
    if (/^\s*-{3,}/.test(l)) ruleIdx.push(i);
  });
  if (ruleIdx.length < 2) {
    return { ok: false, reason: 'unrecognised archive listing (missing separator rules)' };
  }

  const body = lines.slice(ruleIdx[0] + 1, ruleIdx[1]);
  const entries: string[] = [];
  for (const line of body) {
    if (!line.trim()) continue;
    // "   Length   Date   Time   Name" — the name is everything after the
    // third column, kept verbatim so interior spaces survive.
    const m = line.match(/^\s*\d+\s+\S+\s+\S+\s{2,}(.*)$/) ?? line.match(/^\s*\d+\s+\S+\s+\S+\s+(.*)$/);
    if (!m) return { ok: false, reason: `unparseable archive listing row: ${JSON.stringify(line.slice(0, 80))}` };
    entries.push(m[1]);
  }

  // The summary ("        21                     2 files") states how many
  // entries the archive really has. A mismatch means a name split across lines
  // (newline injection) or a row we failed to read — either way, fail closed.
  const summary = lines.slice(ruleIdx[1] + 1).join('\n').match(/(\d+)\s+files?\b/);
  if (summary) {
    const declared = parseInt(summary[1], 10);
    if (Number.isFinite(declared) && declared !== entries.length) {
      return {
        ok: false,
        reason: `archive listing declares ${declared} entr${declared === 1 ? 'y' : 'ies'} but ${entries.length} parsed — refusing`,
      };
    }
  }

  return { ok: true, entries };
}

/** Full scan: parse the listing, then reject the first unsafe entry. */
export function validateArchiveEntries(listOutput: string): ArchiveEntryScan {
  const parsed = parseZipEntryNames(listOutput);
  if (!parsed.ok) return parsed;
  for (const name of parsed.entries) {
    if (!isSafeRestorePath(name)) {
      return { ok: false, reason: `Zip-slip or unsafe path detected: ${name}`, offending: name };
    }
  }
  return parsed;
}
