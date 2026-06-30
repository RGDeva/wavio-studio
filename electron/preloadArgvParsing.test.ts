/**
 * Regression test for the preload channel/API-base argv parsing.
 *
 * Root cause this guards against: preload.ts originally re-derived CHANNEL
 * and API_BASE independently via require('../package.json'), which behaves
 * differently in Electron's sandboxed preload context than in the main
 * process — it silently returned undefined there, so preload always fell
 * through to channel="production" even when main correctly resolved "qa".
 * Fixed by having main pass its already-correct values via
 * webPreferences.additionalArguments, which preload reads from process.argv.
 */
import { describe, it, expect } from 'vitest';

// Mirrors electron/preload.ts readMainProcessArg() exactly.
function readMainProcessArg(argv: string[], flag: string): string | undefined {
  const arg = argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.slice(flag.length + 3) : undefined;
}

describe('preload argv parsing — main-process-authoritative channel/apiBase', () => {
  it('parses --wavi-channel=qa from additionalArguments-shaped argv', () => {
    const argv = ['/path/to/electron', '/app', '--wavi-channel=qa', '--wavi-api-base=https://preview.example/api'];
    expect(readMainProcessArg(argv, 'wavi-channel')).toBe('qa');
    expect(readMainProcessArg(argv, 'wavi-api-base')).toBe('https://preview.example/api');
  });

  it('parses --wavi-channel=production correctly', () => {
    const argv = ['/path/to/electron', '--wavi-channel=production', '--wavi-api-base=https://wavi.stream/api'];
    expect(readMainProcessArg(argv, 'wavi-channel')).toBe('production');
  });

  it('returns undefined when the flag is absent (falls back to production default in preload)', () => {
    const argv = ['/path/to/electron', '/app'];
    expect(readMainProcessArg(argv, 'wavi-channel')).toBeUndefined();
  });

  it('handles a URL value containing query-string-like characters without truncation', () => {
    const argv = ['--wavi-api-base=https://example.com/api?x=1&y=2'];
    expect(readMainProcessArg(argv, 'wavi-api-base')).toBe('https://example.com/api?x=1&y=2');
  });
});
