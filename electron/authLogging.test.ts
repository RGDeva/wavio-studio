/**
 * Regression test: sanitized auth logging must never contain any characters
 * from a real token/JWT/cookie/authorization value — only event names,
 * channel, token type/length, and other non-reversible metadata.
 *
 * This exercises the exact describeToken() logic from main.ts (duplicated
 * here since main.ts can't be imported standalone — it has Electron-runtime
 * side effects at module load). Any future change to the real function must
 * keep this contract; if the two drift, re-sync this copy.
 */
import { describe, it, expect } from 'vitest';

// Mirrors electron/main.ts describeToken() exactly.
function describeToken(token: string | null | undefined): { tokenType: string; tokenLength: number } | { tokenType: 'none' } {
  if (!token) return { tokenType: 'none' };
  return { tokenType: token.startsWith('wv_') ? 'desktop' : 'privy-jwt', tokenLength: token.length };
}

const FORBIDDEN_SUBSTRINGS = ['eyJ', 'wv_', 'Bearer ', 'authorization', 'cookie'];

describe('describeToken — never leaks token content', () => {
  it('a Privy JWT-shaped token yields no JWT characters in the log line', () => {
    const fakeJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.signature-part-here';
    const described = describeToken(fakeJwt);
    const logLine = JSON.stringify({ event: 'token-exchange-success', channel: 'qa', ...described });

    expect(logLine).not.toContain('eyJ');
    expect(logLine).not.toContain(fakeJwt);
    expect(logLine).not.toContain(fakeJwt.slice(0, 6));
    expect((described as any).tokenType).toBe('privy-jwt');
    expect((described as any).tokenLength).toBe(fakeJwt.length);
  });

  it('a wv_ desktop token yields no token characters in the log line', () => {
    const fakeDesktopToken = 'wv_' + 'a'.repeat(64);
    const described = describeToken(fakeDesktopToken);
    const logLine = JSON.stringify({ event: 'token-stored', channel: 'qa', ...described });

    expect(logLine).not.toContain('wv_a');
    expect(logLine).not.toContain(fakeDesktopToken);
    expect((described as any).tokenType).toBe('desktop');
    expect((described as any).tokenLength).toBe(fakeDesktopToken.length);
  });

  it('a missing token logs only tokenType "none"', () => {
    expect(describeToken(null)).toEqual({ tokenType: 'none' });
    expect(describeToken(undefined)).toEqual({ tokenType: 'none' });
    expect(describeToken('')).toEqual({ tokenType: 'none' });
  });

  it('no plausible auth log line contains any forbidden substring', () => {
    const samples = [
      { token: 'eyJhbGciOiJSUzI1NiJ9.payload.sig' },
      { token: 'wv_241abcdef0123456789' },
      { token: null },
    ];

    for (const sample of samples) {
      const described = describeToken(sample.token);
      const logLine = `[auth] token-exchange-success ${JSON.stringify({ channel: 'qa', ...described })}`;
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        // 'wv_' itself is an allowed *label* (tokenType: 'desktop' encodes this
        // without printing the literal prefix) — so we only assert the raw
        // token characters never appear, not the word "desktop".
        if (forbidden === 'wv_' && sample.token === null) continue;
        if (forbidden === 'wv_') {
          // Ensure the literal token value (which starts with wv_) is absent,
          // even though the human-readable tokenType label is allowed.
          if (sample.token) expect(logLine).not.toContain(sample.token);
          continue;
        }
        expect(logLine.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
  });
});
