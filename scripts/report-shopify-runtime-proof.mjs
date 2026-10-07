import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const root = process.argv[2] ?? '.tmp-test/shopify-http-projected-7';
const checkRoot = process.env.VERIFY_OUTPUT ?? '.tmp-test/shopify-http-projection-checks-7';
const hash = value => createHash('sha256').update(value).digest('hex');
const artifact = path => ({ path, sha256: hash(readFileSync(path)) });
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const rows = json(join(root, 'rendering.json'));
const acquisition = json(join(root, 'http-acquisition.json'));
const receipt = json(join(root, 'capture-receipt.json'));
const runtime = json(join(root, 'runtime-observations.json'));
const staged = json(join(root, 'embedded-documents.json'));
const resources = json(join(root, 'resources/manifest.json'));
const checks = json(join(checkRoot, 'checks.json'));
const beforePath = '.tmp-test/shopify-http-projected-4/projection-report.json';
const before = existsSync(beforePath) ? json(beforePath) : undefined;
const localizationPath = '.tmp-test/shopify-http-slideshow-localization/structures.json';

function compare(source, copy, label) {
	const a = PNG.sync.read(readFileSync(join(root, source.screenshot)));
	const b = PNG.sync.read(readFileSync(join(root, copy.screenshot)));
	const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
	const pad = image => {
		const result = new PNG({ width, height });
		result.data.fill(255);
		PNG.bitblt(image, result, 0, 0, image.width, image.height, 0, 0);
		return result;
	};
	const first = pad(a), second = pad(b), diff = new PNG({ width, height });
	const changed = pixelmatch(first.data, second.data, diff.data, width, height, { threshold: 0.1 });
	const path = join(root, `${rows.indexOf(copy)}-${label}.diff.png`);
	writeFileSync(path, PNG.sync.write(diff));
	const painted = row => row.snapshot.images.filter(image => image.width > 0 && image.height > 0 && image.painted);
	return {
		path: copy.path, width: copy.width, sourceMode: source.mode,
		sourceHeight: source.snapshot.height, height: copy.snapshot.height,
		heightDelta: copy.snapshot.height - source.snapshot.height,
		mainTextEqual: source.snapshot.text === copy.snapshot.text,
		normalizedMainTextEqual: source.snapshot.text.replace(/\s+/g, ' ').trim() === copy.snapshot.text.replace(/\s+/g, ' ').trim(),
		sourcePaintedImages: painted(source).length, paintedImages: painted(copy).length,
		sourceDecodedPaintedImages: painted(source).filter(image => image.decoded).length,
		decodedPaintedImages: painted(copy).filter(image => image.decoded).length,
		sourceSort: source.snapshot.sort, sort: copy.snapshot.sort,
		pixels: { changed, total: width * height, ratio: changed / (width * height), diff: artifact(path) },
	};
}

const comparisons = rows.filter(row => row.mode === 'portable').map(copy => {
	const source = rows.find(row => row.mode === 'source' && row.path === copy.path && row.width === copy.width);
	if (!source) throw new Error(`Missing source observation: ${copy.path} ${copy.width}`);
	const old = before?.comparisons.find(row => row.path === copy.path && row.width === copy.width);
	return { ...compare(source, copy, 'selected-source'), ...(old ? { before: { heightDelta: old.heightDelta, pixelRatio: old.pixels.ratio } } : {}) };
});
const freshTablet = rows.filter(row => row.mode === 'source-fresh-tablet').map(source => {
	const copy = rows.find(row => row.mode === 'portable' && row.path === source.path && row.width === 768);
	const selected = rows.find(row => row.mode === 'source' && row.path === source.path && row.width === 768);
	return { ...compare(source, copy, 'fresh-tablet'), selectedSessionHeightDelta: selected.snapshot.height - source.snapshot.height, selectedSessionTextEqual: selected.snapshot.text === source.snapshot.text };
});
const report = {
	schema: 'data-liberation/shopify-http-proof/v3',
	revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
	generatedAt: new Date().toISOString(), root,
	verdict: 'projection_measured_incomplete', accepted: false, complete: receipt.summary.complete,
	verification: { rendering: 'measured_not_equivalent', interactions: 'unverified', wordpress: 'not_run' },
	coverage: acquisition.coverage, exportedRoutes: receipt.routes.length,
	captureMs: json(join(root, 'capture-result.json')).captureMs,
	runtimeObservations: runtime.attachments.length, projectedRegions: staged.regions.length,
	partialParents: staged.regions.filter(region => region.childCoverage?.unresolved > 0).map(region => ({ variant: region.variant, selector: region.selector, index: region.index, childCoverage: region.childCoverage })),
	resources: { acquired: acquisition.resources, final: { captured: Object.keys(resources.resources).length, failures: resources.failures.length } },
	evidence: ['http-acquisition.json','capture-receipt.json','runtime-observations.json','embedded-documents.json','rendering.json','resources/manifest.json'].map(path => artifact(join(root, path))),
	...(before ? { before: artifact(beforePath) } : {}),
	...(existsSync(localizationPath) ? { localization: artifact(localizationPath) } : {}),
	source: ['src/platform/acquisition.ts','src/lib/runtime-regions.ts','src/lib/embedded-documents.ts','src/lib/capture-export.ts','src/lib/responsive-assembly.ts','src/lib/self-contain.ts','src/adapters/shopify/acquisition.ts','src/lib/embedded-documents.test.ts','src/lib/capture-http.test.ts','src/lib/responsive-assembly.test.ts','scripts/shopify-runtime-proof.ts'].map(artifact),
	checks, checkEvidence: [artifact(join(checkRoot, 'checks.json')), ...checks.map(check => artifact(check.log))],
	observations: rows.map(row => ({ path: row.path, width: row.width, mode: row.mode, pose: row.pose, ua: row.snapshot.ua, dpr: row.snapshot.dpr, height: row.snapshot.height,
		screenshot: artifact(join(root, row.screenshot)), dom: artifact(join(root, row.dom)), mainTextSha256: hash(row.snapshot.text) })),
	comparisons, freshTablet,
	limitations: [
		'Selected tablet observations are session resizes; the four independent fresh tablet contexts are reported separately.',
		'Normal inline state is not promoted over authored important CSS: the existing dual-document assembler retains native cascade.',
		'Valid outer subtrees survive failed children; unresolved and unaddressable children remain diagnosed and are not certified complete.',
		'Backend forms/commerce, gallery/header interaction reconstruction, intermediate-width runtime geometry and volatile app content remain unverified.',
		'Video frame differences and the failed source poster remain evidence, not preserved artwork.',
		'No frozen fidelity reference or full-site/WordPress acceptance was synthesized.',
	],
};
const path = process.argv.includes('--publish-report') ? 'artifacts/shopify-http/report.json' : join(root, 'projection-report.json');
writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: path, captureMs: report.captureMs, projectedRegions: report.projectedRegions, partialParents: report.partialParents,
	comparisons: comparisons.map(row => ({ path: row.path, width: row.width, text: row.mainTextEqual, delta: row.heightDelta, pixels: row.pixels.ratio, before: row.before })),
	freshTablet: freshTablet.map(row => ({ path: row.path, delta: row.heightDelta, pixels: row.pixels.ratio, text: row.mainTextEqual, resizeDrift: row.selectedSessionHeightDelta })) }, null, 2));
