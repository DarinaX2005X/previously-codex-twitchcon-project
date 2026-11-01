import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    // SQLite and media tests share the same disk; avoid one worker per CPU core.
    maxWorkers: 4,
    clearMocks: true,
  },
});
