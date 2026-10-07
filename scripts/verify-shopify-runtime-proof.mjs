import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.env.VERIFY_OUTPUT ?? '.tmp-test/shopify-http-projection-checks';
mkdirSync(root, { recursive: true });
const checks = [];
for (const [label, command, args] of [
	['types', 'npx', ['tsc', '--noEmit']],
	[
		'targeted',
		'npx',
		[
			'vitest',
			'run',
			'src/adapters/shopify/acquisition.test.ts',
			'src/lib/capture-http.test.ts',
			'src/lib/embedded-documents.test.ts',
			'src/lib/runtime-regions.test.ts',
			'src/lib/http-materialization.test.ts',
			'src/lib/http-acquisition.test.ts',
			'src/lib/self-contain.test.ts',
			'src/lib/responsive-assembly.test.ts',
			'--maxWorkers',
			'1',
		],
	],
	['build', 'npm', ['run', 'build']],
	['package', 'npm', ['run', 'test:package']],
	['restore-dist', 'git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', 'dist']],
	['whitespace', 'git', ['diff', '--check']],
]) {
	const started = performance.now();
	const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
	const path = join(root, `${label}.log`);
	writeFileSync(path, `${result.stdout ?? ''}${result.stderr ?? ''}`);
	checks.push({
		label,
		command: [command, ...args].join(' '),
		status: result.status,
		error: result.error?.message,
		durationMs: performance.now() - started,
		log: path,
	});
	writeFileSync(join(root, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');
	console.log(JSON.stringify(checks.at(-1)));
	if (result.status !== 0) process.exit(1);
}
