#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { summarize } from './summary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { out: { type: 'string', default: '.tmp-test/parity' }, only: { type: 'string' } } });
const out = resolve(values.out);
// Product validates output against cwd; use the checkout root, not the caller's cwd.
if (!out.startsWith(root + '/')) throw new Error('--out must be inside the checkout');
const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));
const sites = corpus.filter(site => !values.only || new URL(site.url).host === values.only);
if (!sites.length) throw new Error('No corpus host matches --only');
const cli = join(root, 'dist/cli.js');
if (!existsSync(cli)) throw new Error('Built CLI missing; run npm run build first');
mkdirSync(out, { recursive: true });
const read = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
async function execute(args, log) {
  const start = performance.now();
  const stream = createWriteStream(log);
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolveExit(code ?? (signal ? 128 : 1)));
  });
  await new Promise(resolveEnd => stream.end(resolveEnd));
  const failureCodes = [];
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    try {
      const record = JSON.parse(line);
      if (record.error && typeof record.code === 'string') failureCodes.push(record.code);
    } catch { /* Human-readable progress is not a structured error. */ }
  }
  return { exitCode, wallTimeMs: Math.round(performance.now() - start), failureCodes };
}
const summary = { schema: 'parity/v1', sites: [] };
for (const site of sites) {
  const host = new URL(site.url).host;
  const directory = join(out, host);
  // Never let a failed new capture inherit a previous receipt or compare report.
  if (existsSync(directory)) throw new Error(`Run directory already exists: ${host}; use a fresh --out`);
  console.error(`[parity] ${host}`);
  // --output is a base directory; the CLI appends the source host itself.
  const liberate = await execute([site.url, '--route-limit', String(site.routeLimit), '--output', out], join(out, `${host}.liberate.log`));
  const compare = await execute(['compare', directory], join(out, `${host}.compare.log`));
  summary.sites.push(summarize(site,
    read(join(directory, 'capture-receipt.json')),
    read(join(directory, 'website/source-findings.json')),
    {
      failures: [
        ...(read(join(directory, 'diagnostics.json'))?.failures ?? []),
        ...liberate.failureCodes.map(code => ({ code })),
        ...compare.failureCodes.map(code => ({ code })),
      ],
    },
    read(join(directory, 'compare/capture/report.json')),
    { exitCodes: { liberate: liberate.exitCode, compare: compare.exitCode }, wallTimeMs: { liberate: liberate.wallTimeMs, compare: compare.wallTimeMs } },
  ));
  summary.sites.sort((a, b) => a.host.localeCompare(b.host));
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
}
process.exitCode = summary.sites.some(site => Object.values(site.exitCodes).some(code => code !== 0)) ? 1 : 0;
