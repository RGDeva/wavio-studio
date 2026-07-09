/**
 * Deterministic resolution of the installed `better-sqlite3` native module for
 * the test suites, replacing the previous hardcoded machine-specific path
 * `/tmp/wavio-sqlite-test/node_modules/better-sqlite3`.
 *
 * That absolute path only existed on one developer machine, so on clean
 * worktrees and in CI every DB/discovery/security suite silently `describe.skip`ped
 * (the "broken harness"). `better-sqlite3` is a declared dependency installed
 * at the project root, so a bare specifier resolves it correctly from the
 * repo's node_modules in every environment (repo, worktree, CI, macOS tmp).
 *
 * Test-only. Nothing in the production/main process imports this.
 */

/** Bare specifier — resolved from the project's node_modules by Node/Vitest. */
export const NATIVE_SQLITE_PATH = 'better-sqlite3';

/**
 * A REAL load check: actually loads the native module and opens an in-memory
 * database. This is deliberately stronger than `require.resolve` because the
 * module can resolve yet fail to `dlopen` (ABI mismatch) — e.g. the root copy
 * is built for Electron's ABI while Vitest runs under a different Node ABI.
 *
 * When it loads, every DB/discovery/security suite runs. When it genuinely
 * cannot load in this runtime, the suites skip with a clear reason
 * (`nativeSqliteLoadError`) instead of crashing every test with
 * ERR_DLOPEN_FAILED. Errors are surfaced, never suppressed.
 */
let _db: any;
export let nativeSqliteLoadError: string | undefined;

export const nativeSqliteAvailable: boolean = (() => {
  try {
    const Database = require('better-sqlite3');
    const probe = new Database(':memory:');
    probe.close();
    _db = Database;
    return true;
  } catch (err: any) {
    nativeSqliteLoadError = err?.code || err?.message || String(err);
    // Surfaced (not suppressed) so a skipped suite has an explained cause.
    console.warn(`[test] better-sqlite3 unavailable in this runtime: ${nativeSqliteLoadError}`);
    return false;
  }
})();

/** Returns the loaded better-sqlite3 constructor (only call when available). */
export function loadBetterSqlite(): any {
  if (!_db) _db = require('better-sqlite3');
  return _db;
}
