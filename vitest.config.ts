import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Two test pools:
    //   1. projectAssociation/ — pure TS, no Electron, no DB, no I/O
    //   2. electron/sync.test.ts — uses better-sqlite3 (Node-native), no Electron APIs
    include: [
      'electron/projectAssociation/**/*.test.ts',
      'electron/sync.test.ts',
      'electron/auth.test.ts',
      'electron/upload.test.ts',
      'electron/db.integration.test.ts',
      'electron/discovery.test.ts',
      'electron/security.test.ts',
    ],
    environment: 'node',
  },
});
