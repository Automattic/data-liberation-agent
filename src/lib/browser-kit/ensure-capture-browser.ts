import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { launchChromium } from './browser-kit.js';

const execFileAsync = promisify(execFile);
let pending: Promise<void> | undefined;

/** Capture may install its own browser; read-only inspection never calls this. */
export function ensureCaptureBrowser(): Promise<void> {
  pending ??= prepare().finally(() => { pending = undefined; });
  return pending;
}

async function prepare(): Promise<void> {
  try {
    try {
      const browser = await launchChromium();
      await browser.close();
      return;
    } catch (error) {
      // Do not try to repair sandbox, permissions or host dependency failures.
      if (!(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; // failure-class: operational
    }
    process.stderr.write('[liberate] installing engine Chromium\n');
    // Resolve beside the Playwright imported by the engine, never an embedder's
    // CLI (or npx, which can select a different browser revision).
    const require = createRequire(import.meta.url);
    const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
    await execFileAsync(process.execPath, [cli, 'install', 'chromium'], {
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    });
    const browser = await launchChromium();
    await browser.close();
  } catch (cause) {
    throw new Error(`browser-unavailable: ${cause instanceof Error ? cause.message : String(cause)}. Run the engine's Playwright CLI with "install chromium" to retry.`, { cause }); // failure-class: operational
  }
}
