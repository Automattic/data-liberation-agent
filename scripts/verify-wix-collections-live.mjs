import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimePath = path.join(root, 'dist/capture-engine.bundle.mjs');
const runtimeSha256 = createHash('sha256').update(await readFile(runtimePath)).digest('hex');
const runtime = await import(pathToFileURL(runtimePath).href);
const source = 'https://www.thekmrbrands.com/about/agencies';
const baseline = process.argv.includes('--baseline');
const outputDir = path.resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? '.tmp-test/wix-collections-live');
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'result.json'), JSON.stringify({ status: 'running', source, runtimeSha256, baseline, nativeRuntimeProven: false }, null, 2));

// Caller-owned bounded discovery is a public Platform API recipe. The actual
// built-in Wix hooks, canonical capture, export, and fidelity APIs execute below.
const wix = runtime.findPlatform('wix');
assert(wix?.liberation);
runtime.registerPlatform({
  ...wix,
  id: 'wix-collections-live-acceptance',
  detection: { urlPatterns: [/^https:\/\/www\.thekmrbrands\.com\/about\/agencies\/?$/] },
  liberation: baseline ? {
    ...wix.liberation,
    // The unchanged prior canonicalizer gives this source feature an actual
    // failing-before run while retaining the same public capture workflow.
    canonicalizeHtml: (await import('../src/adapters/wix/instance-ids.ts')).canonicalizeWixCapturedHtml,
  } : wix.liberation,
  discover: async url => ({
    siteMeta: { title: 'Bounded live Wix collection acceptance' },
    urls: [{ url, type: 'page' }],
  }),
});
const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
assert(response.ok);
const sourceHtml = await response.text();
const sourceWarmup = JSON.parse(sourceHtml.match(/<script\b[^>]*id="wix-warmup-data"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? 'null');
const sourceBinding = sourceWarmup?.appsWarmupData?.dataBinding;
assert(sourceBinding?.schemas?.Marken && sourceBinding?.dataStore?.recordsByCollectionId?.Marken);
const expectedIds = Object.keys(sourceBinding.dataStore.recordsByCollectionId.Marken).sort();

const capture = await runtime.captureWebsite({ url: source, outputDir, captureImages: true });
await writeFile(path.join(outputDir, 'source-scope.json'), JSON.stringify({ source, runtimeSha256, baseline, scope: 'one declared collection listing route', sourceRecordIds: expectedIds, capture }, null, 2));
const html = await readFile(path.join(outputDir, 'website/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b(?=[^>]*data-dla-source-evidence="collections")(?=[^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, baseline ? 0 : 1, 'Canonical portable HTML must reflect the selected before/after source evidence behavior');
if (!baseline) {
  const evidence = JSON.parse(scripts[0][1]);
  const agencies = evidence.collections.find(collection => collection.id === 'Marken');
  assert(agencies);
  assert.deepEqual(agencies.records.map(record => record.id).sort(), expectedIds);
  assert.equal(agencies.coverage.scope, 'observed_datasets');
  assert(agencies.records.every(record => record.source_routes.some(route => route.startsWith('/agency/'))));
  assert(agencies.fields.some(field => field.source_type === 'multi-reference'));
  assert(!agencies.fields.some(field => field.id === '_owner'));
  assert(agencies.records.every(record => !Object.hasOwn(record.values, '_owner')));
  await writeFile(path.join(outputDir, 'collection-evidence.json'), JSON.stringify(evidence, null, 2));
}
const comparison = await runtime.checkFidelity({ directory: outputDir, screenshots: true });
await writeFile(path.join(outputDir, 'fidelity-result.json'), JSON.stringify(comparison, null, 2));
const result = {
  status: baseline ? 'baseline-evidence-absent' : 'source-evidence-passed', source, sourceRecords: expectedIds.length,
  runtimeSha256, baseline,
  typedSchemaRetained: !baseline, nativeRuntimeProven: false,
  boundedScope: true, sourceCaptureComplete: capture.complete,
  fidelityPass: comparison.pass,
};
await writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
