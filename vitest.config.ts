import { defineConfig, configDefaults } from 'vitest/config';

// This is the config vitest actually loads (`.ts` wins over `.js` by extension
// precedence), so the root suite's scope must live HERE — not in a shadowed
// vitest.config.js.
//   - include: only `.ts` tests under test/ and src/. This keeps the separate
//     `scripts/block-fixer/` package's own `.js` smoke tests (which depend on
//     block-fixer's private node_modules, e.g. @wordpress/blocks) out of the root gate.
//   - exclude: the manual live-network canaries (test/canary/**) — they hit real
//     third-party sites and are run by hand via `npx vitest run test/canary/...`.
//   - globalSetup: the age-gated `.tmp-test` cleanup.
export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/canary/**'],
  },
});
