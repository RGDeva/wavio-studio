/**
 * macOS release signing — the decisions, separated from the doing.
 *
 * Everything here is pure: it takes strings (environment variables, the output
 * of `security`, `codesign`, `spctl`, `stapler`) and returns verdicts. The
 * scripts that shell out to those tools live next door and contain no logic.
 *
 * The split exists because this is the part that must be right and cannot be
 * tested on a machine without credentials. A release pipeline whose
 * correctness can only be observed by actually shipping is a pipeline nobody
 * can fix under pressure.
 *
 * Two rules the whole file is built around:
 *
 *   1. Never fabricate a credential, and never treat an absent one as
 *      permission to continue. A distribution build without a Developer ID
 *      must FAIL, loudly, naming what is missing.
 *   2. Never report a stronger guarantee than was verified. "Signed" is not
 *      "notarized", "notarized" is not "stapled", and an unsigned build must
 *      never be described as anything else.
 */

// ── Identity classification ─────────────────────────────────────────────────

export const IDENTITY_KINDS = {
  DEVELOPER_ID: 'developer-id',
  APPLE_DEVELOPMENT: 'apple-development',
  MAC_APP_STORE: 'mac-app-store',
  UNKNOWN: 'unknown',
};

/**
 * What kind of certificate is this?
 *
 * The distinction that matters: only "Developer ID Application" can sign an
 * app for distribution outside the App Store. "Apple Development" signs
 * builds for the developer's own machines and is the trap — it is a real
 * certificate, `codesign` accepts it, the build looks signed, and Gatekeeper
 * still rejects it on anyone else's Mac.
 */
export function classifyIdentity(name) {
  const n = String(name ?? '');
  if (/Developer ID Application/i.test(n)) return IDENTITY_KINDS.DEVELOPER_ID;
  // Checked BEFORE the development patterns: '3rd Party Mac Developer
  // Application' contains 'Mac Developer', so the looser test below would
  // claim an App Store certificate was a development one and hand the user a
  // diagnostic about the wrong problem.
  if (/3rd Party Mac Developer|Apple Distribution/i.test(n)) return IDENTITY_KINDS.MAC_APP_STORE;
  if (/Apple Development|iPhone Developer|Mac Developer/i.test(n)) return IDENTITY_KINDS.APPLE_DEVELOPMENT;
  return IDENTITY_KINDS.UNKNOWN;
}

/** Parse `security find-identity -v -p codesigning`. */
export function parseIdentities(stdout) {
  const out = [];
  for (const line of String(stdout ?? '').split('\n')) {
    // e.g.  1) ABC123… "Developer ID Application: Acme (TEAMID)"
    const m = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/i);
    if (!m) continue;
    const name = m[2];
    const team = name.match(/\(([A-Z0-9]{6,12})\)\s*$/);
    out.push({ sha1: m[1], name, kind: classifyIdentity(name), teamId: team ? team[1] : null });
  }
  return out;
}

/**
 * Can this machine sign for distribution?
 *
 * An explicit `CSC_NAME` or `CSC_LINK` wins: the user has said which identity
 * to use, and second-guessing that would be worse than obeying it. Otherwise a
 * Developer ID in the keychain is required — and the presence of an Apple
 * Development certificate is called out specifically, because "I have a
 * certificate, why is it failing" is the single most likely confusion here.
 */
export function detectSigningCredentials({ identities = [], env = {} } = {}) {
  if (env.CSC_LINK) {
    return { canSign: true, source: 'CSC_LINK', identity: null, reason: 'Using the certificate from CSC_LINK.' };
  }
  if (env.CSC_NAME) {
    return { canSign: true, source: 'CSC_NAME', identity: env.CSC_NAME, reason: `Using the identity named in CSC_NAME.` };
  }
  const devId = identities.find((i) => i.kind === IDENTITY_KINDS.DEVELOPER_ID);
  if (devId) {
    return { canSign: true, source: 'keychain', identity: devId.name, teamId: devId.teamId, reason: 'Found a Developer ID Application certificate in the keychain.' };
  }
  const appleDev = identities.find((i) => i.kind === IDENTITY_KINDS.APPLE_DEVELOPMENT);
  if (appleDev) {
    return {
      canSign: false, source: null, identity: null,
      reason: `Only a development certificate is installed (“${appleDev.name}”). That signs builds for your own machines; Gatekeeper rejects it everywhere else. Distribution needs a “Developer ID Application” certificate.`,
    };
  }
  return {
    canSign: false, source: null, identity: null,
    reason: 'No code-signing certificate is installed. Distribution needs a “Developer ID Application” certificate in the login keychain, or CSC_LINK/CSC_NAME.',
  };
}

// ── Notarization credentials ────────────────────────────────────────────────

/**
 * Which notarization method is available?
 *
 * Apple accepts either an App Store Connect API key or an Apple ID with an
 * app-specific password. The API key is preferred where both exist: it does
 * not expire on a password change and carries no personal account.
 *
 * Partial credentials are the interesting case. Three of four variables set is
 * not "nearly able to notarize" — it is a build that will fail late, after the
 * expensive part, so it is reported as unavailable with the missing names
 * listed.
 */
export function detectNotarizationCredentials(env = {}) {
  const apiKeyVars = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const apiKeyPresent = apiKeyVars.filter((v) => env[v]);
  if (apiKeyPresent.length === apiKeyVars.length) {
    return { canNotarize: true, method: 'api-key', missing: [], reason: 'Using an App Store Connect API key.' };
  }

  const appleIdVars = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
  const appleIdPresent = appleIdVars.filter((v) => env[v]);
  if (appleIdPresent.length === appleIdVars.length) {
    return { canNotarize: true, method: 'apple-id', missing: [], reason: 'Using an Apple ID and app-specific password.' };
  }

  // Report against whichever method the user got further with, so the advice
  // names the three variables they were already using.
  const useApiKey = apiKeyPresent.length >= appleIdPresent.length && apiKeyPresent.length > 0;
  const vars = useApiKey ? apiKeyVars : appleIdVars;
  const missing = vars.filter((v) => !env[v]);
  const partial = (useApiKey ? apiKeyPresent : appleIdPresent).length > 0;
  return {
    canNotarize: false,
    method: null,
    missing,
    reason: partial
      ? `Notarization credentials are incomplete — missing ${missing.join(', ')}. A partially configured build fails after packaging, so it is refused up front.`
      : 'No notarization credentials. Set APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.',
  };
}

// ── The build matrix ────────────────────────────────────────────────────────

/**
 * The architectures and targets a distribution build must produce.
 *
 * This exists because of a defect found building the previous RC:
 * `electron-builder --mac dmg` silently builds the HOST architecture only,
 * discarding the `arch` list in the config, and still exits 0. The only
 * evidence was a missing file. So the matrix is enumerated here and each cell
 * is invoked explicitly with its own `--<arch>` flag, and the verifier checks
 * every expected artifact exists rather than trusting the exit code.
 */
export const RELEASE_MATRIX = [
  { target: 'dmg', arch: 'arm64' },
  { target: 'dmg', arch: 'x64' },
  { target: 'zip', arch: 'arm64' },
  { target: 'zip', arch: 'x64' },
];

/** The electron-builder argv for one cell. Explicit arch, never implied. */
export function builderArgsFor(cell, { publish = 'never' } = {}) {
  return ['--mac', cell.target, `--${cell.arch}`, '--publish', publish];
}

/**
 * The filenames electron-builder produces, so their absence is detectable.
 *
 * arm64 artifacts carry the arch in the name; x64 artifacts do not — an
 * asymmetry in electron-builder's own naming, mirrored here rather than
 * corrected, because the verifier has to look for the names that actually
 * appear on disk.
 */
export function expectedArtifacts(productName, version) {
  return [
    { file: `${productName}-${version}-arm64.dmg`, target: 'dmg', arch: 'arm64' },
    { file: `${productName}-${version}.dmg`, target: 'dmg', arch: 'x64' },
    { file: `${productName}-${version}-arm64-mac.zip`, target: 'zip', arch: 'arm64' },
    { file: `${productName}-${version}-mac.zip`, target: 'zip', arch: 'x64' },
  ];
}

// ── Verification output parsing ─────────────────────────────────────────────

/**
 * Parse `codesign -dvvv --entitlements -`.
 *
 * `runtime` in the CodeDirectory flags is what proves hardened runtime is
 * actually ON in the signed binary. The build config asking for it is not the
 * same claim: a misconfigured or re-signed artifact can lose it, and that is
 * exactly the kind of thing that passes review and fails notarization.
 */
export function parseCodesign(stderr) {
  const t = String(stderr ?? '');
  const authority = [...t.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1].trim());
  const flags = t.match(/^CodeDirectory v=[^\n]*flags=(\S+)/m);
  const teamId = t.match(/^TeamIdentifier=(\S+)$/m);
  const identifier = t.match(/^Identifier=(\S+)$/m);
  const signedByApple = authority.some((a) => /Developer ID Certification Authority|Apple Root CA/i.test(a));
  const leaf = authority[0] ?? null;
  return {
    signed: authority.length > 0 || /Signature=adhoc/.test(t) === false && authority.length > 0,
    adhoc: /Signature=adhoc/.test(t),
    unsigned: /code object is not signed at all/i.test(t),
    authority,
    leaf,
    leafKind: leaf ? classifyIdentity(leaf) : null,
    teamId: teamId ? teamId[1] : (/TeamIdentifier=not set/.test(t) ? null : null),
    identifier: identifier ? identifier[1] : null,
    hardenedRuntime: !!(flags && /runtime/.test(flags[1])),
    chainsToApple: signedByApple,
  };
}

/**
 * Parse `spctl --assess --type execute -vv`.
 *
 * It has more than two outcomes, and the extra ones matter. "notarization
 * indicates this code has been revoked" exits 0 and prints neither "accepted"
 * nor "rejected" — a parser looking only for those two reads a revoked build
 * as "no verdict", which is the mildest possible description of the most
 * serious state Gatekeeper reports.
 */
export function parseSpctl(output) {
  const t = String(output ?? '');
  const revoked = /has been revoked/i.test(t);
  const accepted = /: accepted/.test(t);
  const rejected = /: rejected/.test(t) || revoked;
  return {
    accepted: accepted && !revoked,
    rejected,
    revoked,
    source: (t.match(/^source=(.+)$/m) ?? [])[1]?.trim() ?? null,
    /** The only source that means a notarized distribution build. */
    notarizedDeveloperId: /source=Notarized Developer ID/.test(t) && !revoked,
    /** Human reason, when it is neither a clean accept nor a clean reject. */
    anomaly: revoked ? 'Gatekeeper reports this code as REVOKED' : null,
  };
}

/**
 * Parse `xcrun stapler validate`.
 *
 * `stapled: false` and `usable: false` are different answers and must not be
 * conflated: the first says the artifact has no ticket, the second says we
 * could not find out. On this machine `xcrun stapler` dies with the same dyld
 * error as `lipo`, so without this distinction every build — including a
 * perfectly notarized one — would be reported as unstapled.
 */
export function parseStapler(output) {
  const t = String(output ?? '');
  const toolState = classifyToolFailure(t);
  if (!toolState.usable) {
    return { stapled: false, usable: false, reason: `CANNOT VERIFY — ${toolState.reason}` };
  }
  if (/The validate action worked!/i.test(t)) return { stapled: true, usable: true, reason: null };
  const code = t.match(/Error\s+(\d+)/);
  return {
    stapled: false,
    usable: true,
    reason: /does not have a ticket stapled/i.test(t)
      ? 'no notarization ticket is stapled to this artifact'
      : code ? `stapler reported error ${code[1]}` : 'stapler did not confirm a ticket',
  };
}

/**
 * Corroborating evidence that an app bundle carries a stapled ticket.
 *
 * `stapler staple` writes the ticket to `Contents/CodeResources` — which is a
 * different file from `Contents/_CodeSignature/CodeResources`, the code-signing
 * resource list that every signed bundle has. Verified against a known
 * notarized app (Google Chrome has the former; an unsigned build does not).
 *
 * This is EVIDENCE, not proof: the file's presence does not prove the ticket
 * is valid or matches this build. It is used only when `stapler` itself cannot
 * run, and it is reported as a heuristic so nobody mistakes it for the real
 * check.
 */
export function ticketFileEvidence(contentsEntries) {
  const list = Array.isArray(contentsEntries) ? contentsEntries : [];
  return { present: list.includes('CodeResources'), heuristic: true };
}

// ── The verdict ─────────────────────────────────────────────────────────────

/**
 * Fold the checks into one verdict.
 *
 * `distribution: true` is the demanding mode — every signing, notarization and
 * stapling check must pass. In local mode the same checks run and report, but
 * only structural failures (a missing artifact, a wrong architecture) fail the
 * run, because an unsigned local build is a legitimate thing to have.
 *
 * What is NOT allowed in either mode is a check that could not be performed
 * being counted as a pass. Unknown is never OK.
 */
export function summarizeVerification(checks, { distribution = true } = {}) {
  const failures = [];
  const warnings = [];
  for (const c of checks) {
    if (c.ok) continue;
    const entry = `${c.name}: ${c.detail}`;
    const isStructural = c.kind === 'structural';
    if (isStructural || distribution) failures.push(entry);
    else warnings.push(entry);
  }
  return {
    ok: failures.length === 0,
    distribution,
    failures,
    warnings,
    // Stated plainly so a report cannot imply more than was checked.
    claim: failures.length === 0
      ? (distribution
          ? 'signed with a Developer ID, hardened runtime on, notarized and stapled'
          : 'structurally valid; signing and notarization NOT verified')
      : 'not distribution-ready',
  };
}

// ── Architecture, read from the file itself ─────────────────────────────────

/**
 * CPU types we care about, from `mach/machine.h`.
 * CPU_ARCH_ABI64 (0x01000000) is OR-ed into the 64-bit variants.
 */
const CPU_TYPES = {
  0x01000007: 'x86_64',
  0x0100000c: 'arm64',
  0x00000007: 'i386',
  0x0000000c: 'arm',
};

/**
 * Read the architectures out of a Mach-O or universal binary.
 *
 * This duplicates `lipo -archs` on purpose. `lipo` lives in /usr/bin as an
 * Xcode shim, and on a machine whose Xcode is broken it fails with a dyld
 * error — which is the situation this repo is actually in. A release verifier
 * that cannot tell "wrong architecture" from "my toolchain is broken" is worse
 * than no verifier, so the header is parsed here with no external dependency.
 *
 * Takes a Buffer so it is testable without a filesystem.
 */
export function parseMachoArchs(buf) {
  if (!buf || buf.length < 8) return [];
  const be = buf.readUInt32BE(0);

  // Universal ("fat") binary: big-endian magic, then a count and a table.
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const is64 = be === 0xcafebabf;
    const count = buf.readUInt32BE(4);
    const entry = is64 ? 32 : 20;
    const archs = [];
    for (let i = 0; i < count; i++) {
      const off = 8 + i * entry;
      if (off + 4 > buf.length) break;
      archs.push(CPU_TYPES[buf.readUInt32BE(off)] ?? `unknown(0x${buf.readUInt32BE(off).toString(16)})`);
    }
    return archs;
  }

  // Thin Mach-O. Magic tells us the endianness to read cputype with.
  const le = buf.readUInt32LE(0);
  if (le === 0xfeedfacf || le === 0xfeedface) {
    const t = buf.readUInt32LE(4);
    return [CPU_TYPES[t] ?? `unknown(0x${t.toString(16)})`];
  }
  if (be === 0xfeedfacf || be === 0xfeedface) {
    const t = buf.readUInt32BE(4);
    return [CPU_TYPES[t] ?? `unknown(0x${t.toString(16)})`];
  }
  return [];
}

/** The Mach-O name for one of our release architectures. */
export function machoNameFor(arch) {
  return arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'arm64' : arch;
}

/**
 * Is a tool actually usable, or is it a broken shim?
 *
 * The distinction matters more than it looks: a verifier that reads a dyld
 * failure as "check did not pass" will happily report a perfectly good build
 * as broken, and one that reads it as "check passed" will wave through an
 * unsigned release. Both are worse than saying the toolchain is unavailable.
 */
export function classifyToolFailure(stderr) {
  const t = String(stderr ?? '');
  if (/Error loading required libraries|Symbol not found|libxcodebuildLoader/i.test(t)) {
    return { usable: false, reason: 'the tool is an Xcode shim and this machine’s Xcode is broken' };
  }
  if (/command not found|No such file or directory/i.test(t)) {
    return { usable: false, reason: 'the tool is not installed' };
  }
  return { usable: true, reason: null };
}
