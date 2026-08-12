#!/usr/bin/env node
/**
 * Safe STAGING build wrapper — prevents electron-builder extraMetadata from
 * permanently mutating the source package.json.
 *
 * electron-builder merges `extraMetadata` into the source package.json
 * before packaging.  That mutation is intentional for the asar contents
 * but corrupts the working tree: it adds waviQaDefaults and drops scripts,
 * devDependencies, and the build section.  This wrapper snapshots the file
 * before the build and restores it in a finally block so the repo always
 * ends up with a clean package.json regardless of build success or failure.
 */
import { execSync }              from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { createHash }            from 'crypto';
import { fileURLToPath }         from 'url';
import path                      from 'path';

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG     = path.join(ROOT, 'package.json');

const original       = readFileSync(PKG, 'utf8');
const originalDigest = createHash('sha256').update(original).digest('hex');

let buildExitCode = 0;

try {
  execSync(
    'npm run build && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --arm64 -c electron-builder.staging.json',
    { stdio: 'inherit', cwd: ROOT },
  );
} catch (err) {
  buildExitCode = err.status ?? 1;
} finally {
  writeFileSync(PKG, original);
  const restoredDigest = createHash('sha256').update(readFileSync(PKG, 'utf8')).digest('hex');
  if (restoredDigest !== originalDigest) {
    console.error('[build-staging] FATAL: package.json could not be restored — check file permissions');
    process.exit(1);
  }
  console.log('[build-staging] package.json restored ✓');
}

process.exit(buildExitCode);
