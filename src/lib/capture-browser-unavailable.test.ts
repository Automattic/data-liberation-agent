import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Fresh process: Playwright reads PLAYWRIGHT_BROWSERS_PATH at module load.
// No Chromium launches or external downloads; expected wall time < 10 seconds.
it('public captureWebsite settles with browser-unavailable when its browser cannot be installed', async () => {
  mkdirSync('.tmp-test', { recursive: true });
  const root = mkdtempSync(resolve('.tmp-test/missing-browser-'));
  try {
    const script = `
      import { captureWebsite } from './src/index.ts';
      try {
        await captureWebsite({ url: 'https://example.com', outputDir: ${JSON.stringify(root + '/output')} });
        process.exitCode = 2;
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
    `;
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: root + '/browsers', PLAYWRIGHT_DOWNLOAD_HOST: 'http://127.0.0.1:1', PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: '1000' },
      timeout: 30_000,
    }).then(() => { throw new Error('capture unexpectedly succeeded'); }, error => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('browser-unavailable');
    expect(result.stderr).not.toContain('unsettled top-level await');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 35_000);
