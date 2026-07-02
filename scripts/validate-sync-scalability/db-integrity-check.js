// Helper: opens a SQLite db (Electron ABI) and prints integrity + WAL state.
// Usage: WAVI_CHECK_DB=/path/to/db npx electron scripts/validate-sync-scalability/db-integrity-check.js
const { app } = require('electron');
const path = require('path');

async function main() {
  await app.whenReady();
  const dbPath = process.env.WAVI_CHECK_DB;
  if (!dbPath) { console.error('WAVI_CHECK_DB required'); app.exit(2); return; }
  const Database = require(path.resolve(__dirname, '..', '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath, { readonly: false }); // WAL replay needs write access
  const integrity = db.pragma('integrity_check');
  const journalMode = db.pragma('journal_mode');
  const tables = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
  db.close();
  console.log('INTEGRITY_RESULT_JSON:' + JSON.stringify({ dbPath, integrity, journalMode, tables }));
  app.exit(0);
}
main().catch((e) => { console.error('INTEGRITY_ERROR:', e); app.exit(1); });
