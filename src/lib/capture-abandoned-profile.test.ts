import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('exits after finalizing when a deadline-abandoned homepage observer unwinds after browser teardown', async () => {
	// A child process detects leaked Playwright children that an in-process
	// assertion cannot: main reports the export failure but never exits.
	const fixture = fileURLToPath(new URL('./screenshot/fixtures/abandoned-profile-child.mjs', import.meta.url));
	const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--async-stack-traces', '--import', 'tsx', fixture], {
		timeout: 20_000, maxBuffer: 1024 * 1024,
	});
	expect(stdout).toContain('route_capture_timeout: exited after finalizing');
	expect(stderr).not.toContain('relaunching');
}, 25_000);
