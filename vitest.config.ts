import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror the `@/*` -> project-root alias from tsconfig.json. Without it,
  // only type-only `@/` imports work under vitest (they are erased); a runtime
  // value import would fail to resolve.
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    // Node-only data layer: no jsdom needed.
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
});
