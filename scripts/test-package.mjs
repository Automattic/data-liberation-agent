import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'data-liberation-package-'));
const consumerDir = join(scratch, 'consumer');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

try {
  mkdirSync(consumerDir);
  const packed = run(npm, ['pack', '--json', '--pack-destination', scratch]);
  const [{ filename }] = JSON.parse(packed.stdout);
  run(npm, [
    'install',
    '--prefix', consumerDir,
    join(scratch, filename),
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);

  const packageRoot = join(consumerDir, 'node_modules', 'data-liberation');
  const cli = run(process.execPath, [join(packageRoot, 'dist', 'cli.js'), '--help']);
  if (!cli.stdout.includes('data-liberation')) {
    throw new Error('Installed CLI did not print Data Liberation help.');
  }

  const captureEngine = await import(
    pathToFileURL(join(packageRoot, 'dist', 'capture-engine.bundle.mjs')).href
  );
  if (typeof captureEngine.captureWebsite !== 'function') {
    throw new Error('Installed capture engine does not export captureWebsite.');
  }

  const requiredPaths = [
    'dist/scripts/triage-candidates.mjs',
    'scripts/block-fixer/fix-server.js',
    'scripts/run.mjs',
    'skills/liberate/SKILL.md',
  ];
  for (const relativePath of requiredPaths) {
    if (!existsSync(join(packageRoot, relativePath))) {
      throw new Error(`Installed package is missing ${relativePath}.`);
    }
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(packageRoot, 'dist', 'mcp-server.bundle.mjs')],
    cwd: packageRoot,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'package-smoke', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === 'liberate_capture')) {
      throw new Error('Installed MCP server does not expose liberate_capture.');
    }
  } finally {
    await client.close();
  }

  process.stdout.write('Installed package CLI, capture engine, MCP server, skills, and drivers are ready.\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
