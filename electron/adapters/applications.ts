/**
 * Locating the DAW application that opens a native project.
 *
 * Adapters declare *hints* rather than absolute paths because installed names
 * carry versions and editions that change per machine — this Mac alone has
 * "Ableton Live 12 Suite.app", "Ableton Live 12 Beta.app" and
 * "FL Studio 2024.app". A hardcoded `/Applications/Ableton Live.app` would
 * match none of them.
 *
 * Resolution is pure: it takes a directory listing, so it is testable without
 * touching the filesystem and without assuming what is installed here.
 */

export interface ApplicationHint {
  /** Directory to look in, e.g. '/Applications'. */
  directory: string;
  /** Bundle-name prefix, matched case-insensitively, e.g. 'Ableton Live'. */
  namePrefix: string;
}

export interface ResolvedApplication {
  /** Absolute path to the application bundle. */
  path: string;
  /** Bundle name as installed, e.g. 'Ableton Live 12 Suite.app'. */
  name: string;
}

/** A directory listing function — `fs.readdirSync` in production. */
export type ListDirectory = (dir: string) => string[];

/**
 * Prefer a stable release over a beta/trial when both are installed: opening a
 * collaborator's project in a beta build is a worse default than opening it in
 * the edition the user actually works in.
 */
const DEPRIORITISED = /\b(beta|trial|demo|alpha|rc)\b/i;

function score(name: string): number {
  return DEPRIORITISED.test(name) ? 1 : 0;
}

/**
 * First application matching any hint, or null when none is installed.
 *
 * Returns null rather than throwing: "the DAW is not installed" is a normal
 * state for a recipient, and the caller should say so rather than fail.
 */
export function resolveApplication(
  hints: ApplicationHint[],
  listDirectory: ListDirectory,
): ResolvedApplication | null {
  const matches: ResolvedApplication[] = [];
  for (const hint of hints) {
    let entries: string[];
    try { entries = listDirectory(hint.directory); } catch { continue; }
    const prefix = hint.namePrefix.toLowerCase();
    for (const name of entries) {
      if (!name.toLowerCase().startsWith(prefix)) continue;
      matches.push({ path: `${hint.directory}/${name}`, name });
    }
  }
  if (!matches.length) return null;
  matches.sort((a, b) => score(a.name) - score(b.name) || a.name.localeCompare(b.name));
  return matches[0];
}
