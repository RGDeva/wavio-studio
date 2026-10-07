/**
 * macOS release signing logic.
 *
 * This is the part of a release pipeline that cannot be tested by running it:
 * the machine has no Developer ID, so every signing path would be skipped. So
 * the decisions are pure and tested against REAL tool output captured from
 * this machine, including the awkward cases discovered by actually running the
 * tools rather than imagined.
 *
 * Two properties under test throughout:
 *   - A missing credential is never treated as permission to continue.
 *   - A check that could not be performed is never counted as a pass.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyIdentity, parseIdentities, detectSigningCredentials,
  detectNotarizationCredentials, IDENTITY_KINDS,
  RELEASE_MATRIX, builderArgsFor, expectedArtifacts,
  parseCodesign, parseSpctl, parseStapler, summarizeVerification,
  parseMachoArchs, machoNameFor, classifyToolFailure, ticketFileEvidence,
// @ts-expect-error — plain ESM module shared with the release scripts
} from '../scripts/macSigning.mjs';

describe('certificate classification', () => {
  it('separates Developer ID from the development certificate that looks like it', () => {
    // The trap: Apple Development is a real certificate, codesign accepts it,
    // the build looks signed, and Gatekeeper rejects it everywhere else.
    expect(classifyIdentity('Developer ID Application: Acme Inc (AB12CD34EF)')).toBe(IDENTITY_KINDS.DEVELOPER_ID);
    expect(classifyIdentity('Apple Development: someone@example.com (JS76PW969P)')).toBe(IDENTITY_KINDS.APPLE_DEVELOPMENT);
    expect(classifyIdentity('3rd Party Mac Developer Application: Acme')).toBe(IDENTITY_KINDS.MAC_APP_STORE);
    expect(classifyIdentity('Some Other Cert')).toBe(IDENTITY_KINDS.UNKNOWN);
  });

  it('parses real `security find-identity` output', () => {
    // Captured verbatim from this machine.
    const out = `  1) 5B5646E4AA344DFF69B3AEB2A3C1F510B076258A "Apple Development: rishmanx@gmail.com (JS76PW969P)"
     1 valid identities found`;
    const ids = parseIdentities(out);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({
      sha1: '5B5646E4AA344DFF69B3AEB2A3C1F510B076258A',
      kind: IDENTITY_KINDS.APPLE_DEVELOPMENT,
      teamId: 'JS76PW969P',
    });
  });

  it('ignores the trailing summary line and blank output', () => {
    expect(parseIdentities('     0 valid identities found')).toEqual([]);
    expect(parseIdentities('')).toEqual([]);
    expect(parseIdentities(undefined as any)).toEqual([]);
  });
});

describe('signing credentials — absence is never permission', () => {
  it('accepts a Developer ID in the keychain', () => {
    const r = detectSigningCredentials({
      identities: parseIdentities('  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Acme (AB12CD34EF)"'),
    });
    expect(r.canSign).toBe(true);
    expect(r.teamId).toBe('AB12CD34EF');
  });

  it('REFUSES with a development certificate, and says why specifically', () => {
    // "I have a certificate, why is it failing" is the likeliest confusion
    // here, so the reason names the certificate it found.
    const r = detectSigningCredentials({
      identities: parseIdentities('  1) 5B5646E4AA344DFF69B3AEB2A3C1F510B076258A "Apple Development: rishmanx@gmail.com (JS76PW969P)"'),
    });
    expect(r.canSign).toBe(false);
    expect(r.reason).toMatch(/Apple Development/);
    expect(r.reason).toMatch(/Developer ID Application/);
  });

  it('refuses when there is no certificate at all', () => {
    expect(detectSigningCredentials({ identities: [] }).canSign).toBe(false);
  });

  it('obeys an explicit CSC_LINK or CSC_NAME rather than second-guessing it', () => {
    expect(detectSigningCredentials({ identities: [], env: { CSC_LINK: '/tmp/cert.p12' } }).canSign).toBe(true);
    expect(detectSigningCredentials({ identities: [], env: { CSC_NAME: 'Developer ID Application: Acme' } }).canSign).toBe(true);
  });
});

describe('notarization credentials', () => {
  const API = { APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'id', APPLE_API_ISSUER: 'iss' };
  const APPLEID = { APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 'T' };

  it('accepts an App Store Connect API key', () => {
    expect(detectNotarizationCredentials(API)).toMatchObject({ canNotarize: true, method: 'api-key' });
  });

  it('accepts an Apple ID with an app-specific password', () => {
    expect(detectNotarizationCredentials(APPLEID)).toMatchObject({ canNotarize: true, method: 'apple-id' });
  });

  it('prefers the API key when both exist', () => {
    // It does not expire on a password change and carries no personal account.
    expect(detectNotarizationCredentials({ ...API, ...APPLEID }).method).toBe('api-key');
  });

  it('treats PARTIAL credentials as unavailable, naming what is missing', () => {
    // Three of four set is not "nearly able to notarize" — it is a build that
    // fails after the expensive part.
    const r = detectNotarizationCredentials({ APPLE_ID: 'a@b.c', APPLE_TEAM_ID: 'T' });
    expect(r.canNotarize).toBe(false);
    expect(r.missing).toEqual(['APPLE_APP_SPECIFIC_PASSWORD']);
    expect(r.reason).toMatch(/fails after packaging/);
  });

  it('advises on the method the user got furthest with', () => {
    const r = detectNotarizationCredentials({ APPLE_API_KEY: 'k' });
    expect(r.missing).toEqual(['APPLE_API_KEY_ID', 'APPLE_API_ISSUER']);
  });

  it('reports nothing configured as nothing configured', () => {
    const r = detectNotarizationCredentials({});
    expect(r.canNotarize).toBe(false);
    expect(r.reason).toMatch(/APPLE_API_KEY/);
    expect(r.reason).toMatch(/APPLE_ID/);
  });
});

describe('the build matrix — the host-arch trap', () => {
  it('covers both architectures for both targets', () => {
    expect(RELEASE_MATRIX).toHaveLength(4);
    expect(new Set(RELEASE_MATRIX.map((c: any) => c.arch))).toEqual(new Set(['arm64', 'x64']));
    expect(new Set(RELEASE_MATRIX.map((c: any) => c.target))).toEqual(new Set(['dmg', 'zip']));
  });

  it('ALWAYS passes the architecture explicitly', () => {
    // `electron-builder --mac dmg` builds host arch only, discarding the
    // config's arch list, and still exits 0. The previous release candidate
    // lost its x64 DMG exactly this way.
    for (const cell of RELEASE_MATRIX) {
      const args = builderArgsFor(cell);
      expect(args).toContain(`--${cell.arch}`);
      expect(args).toContain(cell.target);
    }
  });

  it('never publishes by default', () => {
    for (const cell of RELEASE_MATRIX) {
      expect(builderArgsFor(cell).join(' ')).toContain('--publish never');
    }
  });

  it('expects the asymmetric filenames electron-builder actually produces', () => {
    // arm64 carries the arch in the name; x64 does not. Mirrored rather than
    // corrected, because the verifier must look for the real names.
    const files = expectedArtifacts('Wavi Studio', '1.1.0').map((a: any) => a.file);
    expect(files).toEqual([
      'Wavi Studio-1.1.0-arm64.dmg',
      'Wavi Studio-1.1.0.dmg',
      'Wavi Studio-1.1.0-arm64-mac.zip',
      'Wavi Studio-1.1.0-mac.zip',
    ]);
  });
});

describe('codesign output', () => {
  it('reads the hardened-runtime flag out of the signed binary', () => {
    // The config asking for hardened runtime is a different claim from the
    // binary having it; a re-signed artifact can lose it.
    const signed = `Identifier=com.wavi.studio
CodeDirectory v=20500 size=600 flags=0x10000(runtime) hashes=13+7
Authority=Developer ID Application: Acme Inc (AB12CD34EF)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=AB12CD34EF`;
    const cs = parseCodesign(signed);
    expect(cs.hardenedRuntime).toBe(true);
    expect(cs.leafKind).toBe(IDENTITY_KINDS.DEVELOPER_ID);
    expect(cs.teamId).toBe('AB12CD34EF');
    expect(cs.chainsToApple).toBe(true);
  });

  it('does not report hardened runtime when the flag is absent', () => {
    const noRuntime = `Identifier=com.wavi.studio
CodeDirectory v=20400 size=600 flags=0x0(none) hashes=13+7
Authority=Developer ID Application: Acme Inc (AB12CD34EF)`;
    expect(parseCodesign(noRuntime).hardenedRuntime).toBe(false);
  });

  it('recognises a completely unsigned bundle', () => {
    // Captured from this machine's unsigned build.
    const cs = parseCodesign('release/mac/Wavi Studio.app: code object is not signed at all');
    expect(cs.unsigned).toBe(true);
    expect(cs.leafKind).toBeNull();
    expect(cs.hardenedRuntime).toBe(false);
  });

  it('recognises an ad-hoc signature as not a real identity', () => {
    const cs = parseCodesign(`Identifier=Electron
Signature=adhoc
CodeDirectory v=20400 size=600 flags=0x2(adhoc)`);
    expect(cs.adhoc).toBe(true);
    expect(cs.leafKind).toBeNull();
  });

  it('classifies a development-certificate signature as NOT a Developer ID', () => {
    const cs = parseCodesign(`CodeDirectory v=20500 size=600 flags=0x10000(runtime)
Authority=Apple Development: someone@example.com (JS76PW969P)
TeamIdentifier=JS76PW969P`);
    expect(cs.hardenedRuntime).toBe(true);        // hardened, and still useless
    expect(cs.leafKind).toBe(IDENTITY_KINDS.APPLE_DEVELOPMENT);
  });
});

describe('spctl output — more than two outcomes', () => {
  it('only "Notarized Developer ID" counts as notarized', () => {
    const ok = parseSpctl('app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Acme');
    expect(ok.notarizedDeveloperId).toBe(true);
  });

  it('accepted-but-not-notarized is not notarized', () => {
    // e.g. source=Developer ID, which passes on a machine with relaxed
    // assessment and fails on a fresh download.
    const r = parseSpctl('app: accepted\nsource=Developer ID');
    expect(r.accepted).toBe(true);
    expect(r.notarizedDeveloperId).toBe(false);
  });

  it('reads a plain rejection and its source', () => {
    // Captured from this machine.
    const r = parseSpctl('release/mac/Wavi Studio.app: rejected\nsource=no usable signature');
    expect(r.rejected).toBe(true);
    expect(r.source).toBe('no usable signature');
  });

  it('REVOKED is surfaced, not swallowed as "no verdict"', () => {
    // Also captured here: it exits 0 and prints neither accepted nor
    // rejected, so a two-state parser reports the most serious state
    // Gatekeeper has as the mildest thing it could say.
    const r = parseSpctl('release/mac-arm64/Wavi Studio.app: notarization indicates this code has been revoked');
    expect(r.revoked).toBe(true);
    expect(r.rejected).toBe(true);
    expect(r.accepted).toBe(false);
    expect(r.notarizedDeveloperId).toBe(false);
    expect(r.anomaly).toMatch(/REVOKED/);
  });
});

describe('stapler output — "no ticket" is not "could not check"', () => {
  it('confirms a stapled ticket', () => {
    expect(parseStapler('Processing: /path/app\nThe validate action worked!')).toMatchObject({ stapled: true, usable: true });
  });

  it('reports a genuinely missing ticket', () => {
    const r = parseStapler('Processing: /path/app\nThe validate action failed! Error 65. does not have a ticket stapled to it.');
    expect(r).toMatchObject({ stapled: false, usable: true });
    expect(r.reason).toMatch(/no notarization ticket/);
  });

  it('distinguishes a BROKEN TOOL from a missing ticket', () => {
    // Real output from this machine: xcrun stapler dies with the same dyld
    // error as lipo. Without this distinction a perfectly notarized build
    // would be reported as unstapled.
    const broken = `Error loading required libraries. If there is an ongoing installation please wait for it to complete. Otherwise reinstall. (dlopen(@rpath/libxcodebuildLoader.dylib, 0x0001): Symbol not found: _XPCTypeBool`;
    const r = parseStapler(broken);
    expect(r.usable).toBe(false);
    expect(r.stapled).toBe(false);          // still never a pass
    expect(r.reason).toMatch(/CANNOT VERIFY/);
  });
});

describe('broken-toolchain classification', () => {
  it('recognises the Xcode shim failure this machine actually has', () => {
    const r = classifyToolFailure('Error loading required libraries. … Symbol not found: _XPCTypeBool');
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/Xcode is broken/);
  });

  it('recognises a missing tool', () => {
    expect(classifyToolFailure('xcrun: command not found').usable).toBe(false);
  });

  it('treats an ordinary failure as a usable tool reporting a real result', () => {
    // "not signed at all" is an answer, not a toolchain problem.
    expect(classifyToolFailure('code object is not signed at all').usable).toBe(true);
    expect(classifyToolFailure('').usable).toBe(true);
  });
});

describe('architecture, read from the Mach-O header', () => {
  const header = (magicWriter: (b: Buffer) => void, cpu: number, be = false) => {
    const b = Buffer.alloc(32);
    magicWriter(b);
    if (be) b.writeUInt32BE(cpu, 4); else b.writeUInt32LE(cpu, 4);
    return b;
  };

  it('reads a thin arm64 binary', () => {
    const b = header((x) => x.writeUInt32LE(0xfeedfacf, 0), 0x0100000c);
    expect(parseMachoArchs(b)).toEqual(['arm64']);
  });

  it('reads a thin x86_64 binary', () => {
    const b = header((x) => x.writeUInt32LE(0xfeedfacf, 0), 0x01000007);
    expect(parseMachoArchs(b)).toEqual(['x86_64']);
  });

  it('reads a universal binary’s arch list', () => {
    const b = Buffer.alloc(80);
    b.writeUInt32BE(0xcafebabe, 0);
    b.writeUInt32BE(2, 4);
    b.writeUInt32BE(0x01000007, 8);
    b.writeUInt32BE(0x0100000c, 28);
    expect(parseMachoArchs(b)).toEqual(['x86_64', 'arm64']);
  });

  it('returns nothing for a non-Mach-O file rather than guessing', () => {
    expect(parseMachoArchs(Buffer.from('#!/bin/sh\necho hi\n'))).toEqual([]);
    expect(parseMachoArchs(Buffer.alloc(2))).toEqual([]);
    expect(parseMachoArchs(null as any)).toEqual([]);
  });

  it('maps our release arch names to Mach-O names', () => {
    expect(machoNameFor('x64')).toBe('x86_64');
    expect(machoNameFor('arm64')).toBe('arm64');
  });
});

describe('the ticket-file heuristic is labelled as one', () => {
  it('detects the stapled ticket file, distinct from the signature list', () => {
    // Contents/CodeResources is the ticket; Contents/_CodeSignature/CodeResources
    // is the code-signing resource list that every signed bundle has.
    // Verified against Google Chrome (notarized) vs this repo's unsigned build.
    expect(ticketFileEvidence(['CodeResources', 'Info.plist', '_CodeSignature']))
      .toEqual({ present: true, heuristic: true });
    expect(ticketFileEvidence(['Frameworks', 'Info.plist', 'MacOS', 'PkgInfo', 'Resources']))
      .toEqual({ present: false, heuristic: true });
  });

  it('always marks itself a heuristic, never proof', () => {
    expect(ticketFileEvidence([]).heuristic).toBe(true);
  });
});

describe('the verdict never overstates what was checked', () => {
  const pass = (name: string, kind = 'signing') => ({ name, ok: true, detail: 'fine', kind });
  const fail = (name: string, kind = 'signing') => ({ name, ok: false, detail: 'nope', kind });

  it('a distribution build requires every signing check', () => {
    const v = summarizeVerification([pass('a'), fail('Developer ID')], { distribution: true });
    expect(v.ok).toBe(false);
    expect(v.claim).toBe('not distribution-ready');
  });

  it('local mode downgrades signing failures to warnings but says so in the claim', () => {
    const v = summarizeVerification([pass('a'), fail('Developer ID')], { distribution: false });
    expect(v.ok).toBe(true);
    expect(v.warnings).toHaveLength(1);
    // The crucial bit: it does not claim to be signed.
    expect(v.claim).toMatch(/NOT verified/);
  });

  it('a STRUCTURAL failure fails even local mode', () => {
    // A missing artifact or a wrong-architecture native module is broken in
    // any mode; there is no reading of it that is acceptable.
    const v = summarizeVerification([fail('better_sqlite3 arch arm64', 'structural')], { distribution: false });
    expect(v.ok).toBe(false);
  });

  it('a full pass states exactly the four guarantees it verified', () => {
    const v = summarizeVerification([pass('a'), pass('b')], { distribution: true });
    expect(v.ok).toBe(true);
    expect(v.claim).toMatch(/Developer ID/);
    expect(v.claim).toMatch(/hardened runtime/);
    expect(v.claim).toMatch(/notarized/);
    expect(v.claim).toMatch(/stapled/);
  });
});
