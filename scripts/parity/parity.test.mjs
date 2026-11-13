import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from './summary.mjs';
import { diff, diffAgainstBaselines } from './diff.mjs';

const site = { url: 'https://example.test', platform: 'unknown' };
const execution = { exitCodes: { liberate: 0, compare: 0 }, wallTimeMs: { liberate: 100, compare: 30 } };
function fixture() {
  return { schema: 'parity/v1', sites: [summarize(site, {
    source: { platform: 'unknown' }, summary: { routesDiscovered: 2, routesCaptured: 2 },
    routes: [{ path: 'website/z/index.html' }, { path: 'website/index.html' }],
  }, { findings: [{ code: 'loss' }, { code: 'loss' }] }, { failures: [{ code: 'timeout' }] }, {
    pass: true, status: 'proven', routes: ['/', '/z/'],
    selfConsistency: { pass: true, findings: [] },
    scores: [{ route: '/z/', pass: true }, { route: '/', pass: true }],
  }, structuredClone(execution))] };
}
test('normalization sorts routes/codes and ignores volatile artifact fields', () => {
  const normalized = fixture();
  assert.deepEqual(normalized.sites[0].compare.routes.map(row => row.route), ['/', '/z/']);
  assert.deepEqual(normalized.sites[0].findings, { loss: 2 });
  assert(!JSON.stringify(normalized).includes('website/'));
  const empty = summarize(site, null, null, null, null, execution);
  assert.equal(empty.platform, null);
  assert.equal(empty.counts.exported, null);
  assert.equal(empty.compare.frozenFidelity, 'unproven');
});
test('pending and failed cells cannot be reported as proven', () => {
  const result = summarize(site, null, null, null, {
    routes: ['/'], pending: [{ route: '/' }], scores: [{ route: '/', pass: true }],
    selfConsistency: { pass: false, findings: [{ route: '/', kind: 'link-dangling' }] },
  }, execution);
  assert.equal(result.compare.routes[0].frozenFidelity, 'unproven');
  const mixed = summarize(site, null, null, null, { status: 'unproven', pending: [{ route: '/' }], scores: [{ route: '/z/', pass: false }] }, execution);
  assert.equal(mixed.compare.frozenFidelity, 'failed');
  assert.equal(result.compare.routes[0].selfConsistency, false);
  assert.deepEqual(result.compare.routes[0].findings, { 'link-dangling': 1 });
});
test('unchanged summaries and wall-time changes produce empty output', () => {
  const before = fixture(), after = fixture();
  after.sites[0].wallTimeMs = { liberate: 999, compare: 500 };
  assert.deepEqual(diff(before, after), []);
});
test('each contract dimension independently detects regressions', () => {
  for (const mutate of [
    s => { s.platform = 'wix'; },
    s => { s.counts.inventory--; },
    s => { s.counts.discovered--; },
    s => { s.counts.captured--; },
    s => { s.counts.exported--; },
    s => { s.findings.loss++; },
    s => { s.failures.timeout++; },
    s => { s.exitCodes.liberate = 1; },
    s => { s.exitCodes.compare = 1; },
    s => { s.compare.pass = false; },
    s => { s.compare.selfConsistency = false; },
    s => { s.compare.frozenFidelity = 'unproven'; },
    s => { s.compare.routes.pop(); },
    s => { s.compare.routes[0].frozenFidelity = 'failed'; },
    s => { s.compare.routes[0].selfConsistency = false; },
    s => { s.compare.routes[0].findings.broken = 1; },
  ]) {
    const before = fixture(), after = fixture();
    mutate(after.sites[0]);
    assert(diff(before, after).some(row => row.regression), mutate.toString());
    assert(diff(after, before).some(row => !row.regression), mutate.toString());
  }
  assert(diff(fixture(), { schema: 'parity/v1', sites: [] })[0].regression);
});
test('a candidate inside the baselines\' own range is unstable, outside it a regression', () => {
  const slow = fixture(); slow.sites[0].compare.frozenFidelity = 'failed';
  const candidate = fixture(); candidate.sites[0].compare.frozenFidelity = 'failed'; candidate.sites[0].counts.inventory = 1;
  const kinds = Object.fromEntries(diffAgainstBaselines([fixture(), slow], candidate).map(row => [row.field, row.kind]));
  assert.deepEqual(kinds, { 'compare.frozenFidelity': 'unstable', 'counts.inventory': 'regression' });
});
test('runner invokes built CLI, continues failures and reads the actual host directory', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'parity-runner-')));
  try {
    mkdirSync(join(root, 'scripts/parity'), { recursive: true });
    mkdirSync(join(root, 'dist'));
    for (const file of ['run.mjs', 'summary.mjs']) copyFileSync(fileURLToPath(new URL(file, import.meta.url)), join(root, 'scripts/parity', file));
    writeFileSync(join(root, 'scripts/parity/corpus.json'), JSON.stringify([
      { url: 'https://a.test', platform: 'unknown', routeLimit: 5 },
      { url: 'https://b.test', platform: 'wix', routeLimit: 5 },
    ]));
    writeFileSync(join(root, 'dist/cli.js'), `
      const fs = require('node:fs'), path = require('node:path');
      const args = process.argv.slice(2);
      fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
      if (args[0] === 'compare') {
        const dir = args[1];
        fs.mkdirSync(path.join(dir, 'compare/capture'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'compare/capture/report.json'), JSON.stringify({ pass: true, status: 'proven', routes: ['/'], selfConsistency: { pass: true, findings: [] }, scores: [{ route: '/', pass: true }] }));
      } else {
        const dir = path.join(args[args.indexOf('--output') + 1], new URL(args[0]).host);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'capture-receipt.json'), JSON.stringify({ source: { platform: 'unknown' }, summary: { routesDiscovered: 1, routesCaptured: 1 }, routes: [{ path: 'website/index.html' }] }));
        console.error(JSON.stringify({ error: 'fixture failure', code: 'fixture_failed' }));
        process.exitCode = 1;
      }
    `);
    const out = join(root, 'output');
    const result = spawnSync(process.execPath, [join(root, 'scripts/parity/run.mjs'), '--out', out], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(readFileSync(join(out, 'summary.json')));
    assert.equal(summary.sites.length, 2);
    assert.equal(summary.sites[0].counts.exported, 1);
    assert.equal(summary.sites[0].compare.pass, true);
    assert.deepEqual(summary.sites[0].failures, { fixture_failed: 1 });
    const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls[0], ['https://a.test', '--route-limit', '5', '--output', out]);
    assert.deepEqual(calls[1], ['compare', join(out, 'a.test')]);
    assert.equal(calls.length, 4);
    const repeated = spawnSync(process.execPath, [join(root, 'scripts/parity/run.mjs'), '--out', out], { cwd: root });
    assert.notEqual(repeated.status, 0);
    assert.equal(readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').length, 4);
    const focused = spawnSync(process.execPath, [join(root, 'scripts/parity/run.mjs'), '--out', join(root, 'focused'), '--only', 'b.test'], { cwd: root });
    assert.equal(focused.status, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'focused/summary.json'))).sites.map(row => row.host), ['b.test']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('diff CLI is silent for parity and exits nonzero for regressions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'parity-test-'));
  try {
    const before = join(directory, 'before.json'), after = join(directory, 'after.json');
    writeFileSync(before, JSON.stringify(fixture()));
    writeFileSync(after, readFileSync(before));
    assert.equal(execFileSync(process.execPath, ['scripts/parity/diff.mjs', before, after], { encoding: 'utf8' }), '');
    const changed = fixture(); changed.sites[0].counts.captured = 0;
    writeFileSync(after, JSON.stringify(changed));
    const result = spawnSync(process.execPath, ['scripts/parity/diff.mjs', before, after], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /REGRESSION example.test counts.captured: 2 -> 0/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
