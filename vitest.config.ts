import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run tests under projectAssociation — these are pure TS modules
    // with no Electron, no DB, no I/O. All other electron/ files import
    // Electron APIs that are not available in a plain Node test environment.
    include: ['electron/projectAssociation/**/*.test.ts'],
    environment: 'node',
  },
});
