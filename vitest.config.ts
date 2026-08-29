import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'mock-services/**/*.ts'],
      exclude: ['src/types/**', 'dist/**'],
    },
    testTimeout: 10000,
  },
});
