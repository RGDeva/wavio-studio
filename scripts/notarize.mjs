#!/usr/bin/env node
/**
 * electron-builder `afterSign` hook: notarize the signed app.
 *
 * Previously absent, which meant a build with full credentials would still
 * have shipped un-notarized — the config asked for hardened runtime and a
 * Developer ID and then simply never submitted anything to Apple. Gatekeeper
 * would have blocked the result on every machine but the build machine.
 *
 * Behaviour is deliberately asymmetric:
 *
 *   - Distribution build, credentials present → notarize and staple.
 *   - Distribution build, credentials absent   → FAIL. Not a warning. A
 *     release that silently skips notarization is the failure this hook
 *     exists to prevent, and it is indistinguishable from success until a
 *     tester reports a Gatekeeper dialog.
 *   - Local build (WAVI_ALLOW_UNSIGNED=1) → skip, loudly, saying exactly what
 *     the artifact is not.
 *
 * Nothing here invents a credential or works around a missing one.
 */
import { execFileSync } from 'child_process';
import { detectNotarizationCredentials, detectSigningCredentials, parseIdentities } from './macSigning.mjs';

const BANNER = '─'.repeat(72);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

export default async function notarizing(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  const allowUnsigned = process.env.WAVI_ALLOW_UNSIGNED === '1';

  // Did signing actually happen? electron-builder skips it silently when no
  // identity is available, so the hook checks rather than assumes.
  let identities = [];
  try { identities = parseIdentities(run('security', ['find-identity', '-v', '-p', 'codesigning'])); } catch { /* none */ }
  const signing = detectSigningCredentials({ identities, env: process.env });

  const notary = detectNotarizationCredentials(process.env);

  if (!signing.canSign || !notary.canNotarize) {
    const lines = [
      BANNER,
      'NOT A DISTRIBUTABLE BUILD',
      BANNER,
      `  app:            ${appPath}`,
      `  code signing:   ${signing.canSign ? 'yes' : 'NO — ' + signing.reason}`,
      `  notarization:   ${notary.canNotarize ? 'yes' : 'NO — ' + notary.reason}`,
      '',
      '  This artifact will be refused by Gatekeeper on any Mac other than',
      '  this one. It is suitable for local testing only.',
      BANNER,
    ];
    if (allowUnsigned) {
      console.warn(lines.join('\n'));
      return;
    }
    console.error(lines.join('\n'));
    throw new Error(
      'Refusing to produce an un-notarized release build. Supply credentials, '
      + 'or set WAVI_ALLOW_UNSIGNED=1 to build a local-only artifact.',
    );
  }

  console.log(`notarize: submitting ${appName}.app (${notary.method})`);

  // notarytool takes a zip, not a .app. A temporary one, beside the output.
  const zipPath = `${appOutDir}/${appName}-notarize.zip`;
  run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);

  const authArgs = notary.method === 'api-key'
    ? ['--key', process.env.APPLE_API_KEY, '--key-id', process.env.APPLE_API_KEY_ID, '--issuer', process.env.APPLE_API_ISSUER]
    : ['--apple-id', process.env.APPLE_ID, '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', process.env.APPLE_TEAM_ID];

  try {
    // --wait blocks until Apple returns a verdict; a build that continues
    // without waiting cannot staple, and an unstapled app needs the network
    // on first launch.
    const out = run('xcrun', ['notarytool', 'submit', zipPath, ...authArgs, '--wait', '--timeout', '30m'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    console.log(out.trim());
    if (!/status:\s*Accepted/i.test(out)) {
      throw new Error(`Apple did not accept the submission. Run \`xcrun notarytool log <id>\` for the reason.`);
    }

    // Staple, so the ticket travels with the app and first launch works
    // offline. The DMG is stapled separately by verify-release.
    run('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
    console.log(`notarize: stapled ${appName}.app`);
  } finally {
    try { run('rm', ['-f', zipPath]); } catch { /* best effort */ }
  }
}
