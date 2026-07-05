import { defineConfig } from 'vitest/config';
// SPIKE ONLY config — the repo's main vitest.config.ts has an explicit
// include list; this runs just the spike proof.
export default defineConfig({
  test: { include: ['electron/adapters/dawproject/spike/**/*.spike.test.ts'], environment: 'node' },
});
