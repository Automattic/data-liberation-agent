import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { PNG } from 'pngjs';

const root = realpathSync(resolve(process.argv[3] ?? '.'));
const report = JSON.parse(readFileSync(process.argv[2] ?? 'artifacts/shopify-http/report.json', 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
function bytes(artifact) {
	assert(artifact && typeof artifact.path === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256), 'Missing pinned artifact');
	const path = realpathSync(resolve(root, artifact.path));
	const local = relative(root, path);
	assert(!isAbsolute(local) && local !== '..' && !local.startsWith('../'), 'Artifact escapes evidence root');
	const value = readFileSync(path);
	assert.equal(hash(value), artifact.sha256, `Artifact hash mismatch: ${artifact.path}`);
	return value;
}
const json = artifact => JSON.parse(bytes(artifact).toString('utf8'));
assert.equal(report.schema, 'data-liberation/shopify-http-proof/v3');
assert.equal(report.accepted, false);
assert.equal(report.complete, false);
assert.equal(report.verdict, 'projection_measured_incomplete');
assert.deepEqual(report.verification, { rendering: 'measured_not_equivalent', interactions: 'unverified', wordpress: 'not_run' });
for (const artifact of [...report.evidence, ...report.source, ...report.checkEvidence]) bytes(artifact);
const evidence = suffix => json(report.evidence.find(artifact => artifact.path.endsWith(suffix)));
const receipt = evidence('capture-receipt.json');
const acquisition = evidence('http-acquisition.json');
const staged = evidence('embedded-documents.json');
const runtime = evidence('runtime-observations.json');
const rendering = evidence('rendering.json');
assert.deepEqual(report.coverage, acquisition.coverage);
assert.deepEqual(report.coverage, { routes: 4, requiredDocuments: 8, acquired: 8, browserRequired: 0, failed: 0 });
assert.equal(receipt.routes.length, 4);
assert.equal(receipt.summary.complete, false);
assert.equal(report.projectedRegions, staged.regions.length);
assert.equal(report.runtimeObservations, runtime.attachments.length);
assert.equal(report.runtimeObservations, 8);
assert.equal(report.observations.length, 28);
assert.equal(rendering.length, 28);
const keys = new Set();
for (const observation of report.observations) {
	const key = JSON.stringify([observation.path, observation.width, observation.mode]);
	assert(!keys.has(key), 'Duplicate observation');
	keys.add(key);
	const actual = rendering.find(row => JSON.stringify([row.path, row.width, row.mode]) === key);
	assert(actual, 'Unobserved scope');
	assert.equal(observation.mainTextSha256, hash(actual.snapshot.text));
	assert.equal(observation.height, actual.snapshot.height);
	assert.equal(observation.pose, actual.pose);
	assert.equal(observation.dpr, 1);
	const image = PNG.sync.read(bytes(observation.screenshot));
	assert.equal(image.width, observation.width);
	assert.equal(image.height, observation.height);
	bytes(observation.dom);
}
function comparison(row, mode) {
	const source = rendering.find(view => view.path === row.path && view.width === row.width && view.mode === mode);
	const copy = rendering.find(view => view.path === row.path && view.width === row.width && view.mode === 'portable');
	assert(source && copy, 'Missing measured comparison');
	assert.equal(row.mainTextEqual, source.snapshot.text === copy.snapshot.text);
	assert.equal(row.heightDelta, copy.snapshot.height - source.snapshot.height);
	assert.equal(row.pixels.ratio, row.pixels.changed / row.pixels.total);
	bytes(row.pixels.diff);
}
assert.equal(report.comparisons.length, 12);
assert.equal(new Set(report.comparisons.map(row => `${row.path}:${row.width}`)).size, 12);
for (const row of report.comparisons) comparison(row, 'source');
assert.equal(report.freshTablet.length, 4);
assert.equal(new Set(report.freshTablet.map(row => row.path)).size, 4);
for (const row of report.freshTablet) comparison({ ...row, width: 768 }, 'source-fresh-tablet');
if (report.before) bytes(report.before);
if (report.localization) bytes(report.localization);
for (const coverage of staged.coverage) {
	assert.equal(new Set(coverage.projectedIndices).size, coverage.projectedIndices.length);
	assert(coverage.projectedIndices.length <= coverage.expectedNodes);
	const regions = staged.regions.filter(row => row.url === coverage.url && row.variant === coverage.variant && row.selector === coverage.selector);
	assert.deepEqual(regions.map(row => row.index).sort(), [...coverage.projectedIndices].sort());
}
for (const region of staged.regions) if (region.childCoverage)
	assert.equal(region.childCoverage.expected, region.childCoverage.staged + region.childCoverage.unresolved);
assert(report.checks.length === 6 && report.checks.every(check => check.status === 0), 'Required checks did not pass');
console.log(`Validated ${report.runtimeObservations} runtime observations, ${report.projectedRegions} projected regions and ${report.observations.length} measured views. Projection remains incomplete and unaccepted.`);
