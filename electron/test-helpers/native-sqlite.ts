/**
 * Deterministic, repo-owned resolution of a **Node-ABI** `better-sqlite3` for
 * the desktop Vitest suites.
 *
 * Two problems this solves:
 *  1. Suites previously hardcoded `/tmp/wavio-sqlite-test/...` (a machine path),
 *     so on clean worktrees/CI every DB/discovery/security suite silently
 *     `describe.skip`ped — the "broken harness".
 *  2. The root `node_modules/better-sqlite3` is built for **Electron's ABI**
 *     (the app), which cannot `dlopen` under the plain-Node runtime Vitest
 *     uses. A single binary can't satisfy both ABIs.
 *
 * Fix: an isolated, Node-ABI install of the SAME version lives in
 * `electron/test-native/` (its own package.json + committed lockfile;
 * node_modules gitignored, populated by `npm run test:setup-native`). This
 * helper resolves ONLY that copy — it never rebuilds or touches the root
 * Electron-ABI binary. Missing/unloadable native SQLite is surfaced (not
 * suppressed) and is turned into a HARD failure by `native-sqlite.guard.test.ts`.
 *
 * Test-only. Nothing in the production/main process imports this.
 */
import * as path from 'path';

/** Absolute path to the isolated Node-ABI better-sqlite3 (repo-relative, no machine path). */
export const NATIVE_SQLITE_PATH = path.join(__dirname, '..', 'test-native', 'node_modules', 'better-sqlite3');

let _db: any;
export let nativeSqliteLoadError: string | undefined;

/**
 * REAL load check: require the isolated copy and open an in-memory database.
 * Stronger than `require.resolve` because a module can resolve yet fail to
 * `dlopen` (ABI mismatch). On failure the error is surfaced (never swallowed).
 */
export const nativeSqliteAvailable: boolean = (() => {
  try {
    const Database = require(NATIVE_SQLITE_PATH);
    const probe = new Database(':memory:');
    probe.close();
    _db = Database;
    return true;
  } catch (err: any) {
    nativeSqliteLoadError = err?.code || err?.message || String(err);
    console.warn(
      `[test] Node-ABI better-sqlite3 not loadable from electron/test-native: ${nativeSqliteLoadError}. ` +
      `Run \`npm run test:setup-native\` under Node 22 (see .nvmrc).`,
    );
    return false;
  }
})();

/** Returns the loaded better-sqlite3 constructor (only call when available). */
export function loadBetterSqlite(): any {
  if (!_db) _db = require(NATIVE_SQLITE_PATH);
  return _db;
}
