#!/usr/bin/env node
/**
 * Guard: the desktop test suites require Node 22 (ABI 127), which matches the
 * prebuilt Node-ABI better-sqlite3 in electron/test-native. Running under any
 * other major would load a mismatched ABI and silently degrade the suite.
 * Fail fast with an actionable message instead.
 */
const REQUIRED_MAJOR = 22;
const major = Number(process.versions.node.split('.')[0]);

if (major !== REQUIRED_MAJOR) {
  console.error(
    `\n✖ Desktop tests require Node ${REQUIRED_MAJOR}.x (found ${process.version}).\n` +
    `  The isolated better-sqlite3 in electron/test-native is a Node-${REQUIRED_MAJOR} (ABI 127) prebuild.\n` +
    `  Fix: \`nvm use\` (see .nvmrc / .node-version), then re-run.\n`,
  );
  process.exit(1);
}
console.log(`✓ Node ${process.version} (ABI ${process.versions.modules}) — OK for desktop tests.`);
