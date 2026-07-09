import { describe, it, expect } from 'vitest';
import { nativeSqliteAvailable, nativeSqliteLoadError, NATIVE_SQLITE_PATH } from './test-helpers/native-sqlite';

/**
 * Hard gate for the native SQLite test runtime.
 *
 * If the isolated Node-ABI better-sqlite3 cannot load, this FAILS the run with
 * an actionable message instead of letting the DB/discovery/security suites
 * silently skip. On the supported runtime (Node 22 + `npm run test:setup-native`)
 * it passes and every native suite executes.
 */
describe('native SQLite test runtime', () => {
  it('loads the isolated Node-ABI better-sqlite3 (no silent skip)', () => {
    if (!nativeSqliteAvailable) {
      throw new Error(
        `Node-ABI better-sqlite3 is not loadable (${nativeSqliteLoadError}).\n` +
        `Expected at: ${NATIVE_SQLITE_PATH}\n` +
        `Fix: use Node 22 (\`nvm use\`) and run \`npm run test:setup-native\`. ` +
        `The desktop DB/discovery/security/sync suites cannot run without it.`,
      );
    }
    expect(nativeSqliteAvailable).toBe(true);
  });

  it('opens an in-memory database and round-trips a row', () => {
    if (!nativeSqliteAvailable) return; // first test already failed the run
    const Database = require(NATIVE_SQLITE_PATH);
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (x INTEGER)');
    db.prepare('INSERT INTO t (x) VALUES (?)').run(42);
    expect(db.prepare('SELECT x FROM t').get().x).toBe(42);
    db.close();
  });
});
