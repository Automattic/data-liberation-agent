import { defineConfig } from 'vitest/config';

// Minimal config — only adds the age-gated `.tmp-test` cleanup; all other vitest defaults
// (include/exclude, node environment, etc.) are untouched.
export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
