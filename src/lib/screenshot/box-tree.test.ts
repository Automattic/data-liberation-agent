import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'cheerio';
import { expect, it } from 'vitest';
import { captureWebsite } from '../capture.js';
import { BOX_TREE_SCHEMA, BOX_TREE_STYLES, NODE_ID_ATTRIBUTE } from './box-tree.js';

// One public capture (~20 seconds). Optional consumer checkout enables the actual PHP intake assertion.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('publishes complete source-bound box trees for builder routes', async () => {
	const fixture = `<!doctype html><html><head><title>Builder</title><style>
		.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;position:relative}
		img{width:100px;height:80px;mask:linear-gradient(black,transparent)}
		.overlay{position:absolute;top:10px;right:4px;background:red}
		@media(max-width:600px){.grid{grid-template-columns:1fr}}
	</style></head><body><main><div><div><div class="grid"><div><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></div><div><h1>Builder</h1></div><span class="overlay">Overlay</span></div></div></div></main><a href="/other">Other</a></body></html>`;
	const server = createServer((req, res) => {
		if (req.url !== '/' && req.url !== '/other') { res.writeHead(404); res.end('Not found'); return; }
		res.setHeader('Content-Type', 'text/html'); res.end(fixture);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	mkdirSync('.tmp-test', { recursive: true });
	const outputDir = mkdtempSync(resolve('.tmp-test/box-tree-'));
	try {
		await captureWebsite({ url: origin, outputDir, trustedOrigins: [origin], routeLimit: 2, learnFluid: true, captureImages: false });
		const manifest = JSON.parse(readFileSync(join(outputDir, 'screenshots/manifest.json'), 'utf8'));
		const receipt = JSON.parse(readFileSync(join(outputDir, 'capture-receipt.json'), 'utf8'));
		const files: Record<string, string> = {};
		for (const entry of Object.values(manifest.entries) as Array<{ html: string }>) {
			const html = readFileSync(join(outputDir, entry.html), 'utf8');
			const sidecar = entry.html.replace(/^html\//, 'box-tree/').replace(/\.html$/, '.json');
			expect(existsSync(join(outputDir, sidecar)), entry.html).toBe(true);
			const tree = JSON.parse(readFileSync(join(outputDir, sidecar), 'utf8'));
			expect(tree.schema).toBe(BOX_TREE_SCHEMA);
			expect(tree.source_path).toBe(entry.html);
			expect(tree.source_hash).toBe(createHash('sha256').update(html).digest('hex'));
			expect(receipt.reports).toContain(sidecar);
			const $ = load(html);
			const ids = $('*').toArray().map(element => $(element).attr(NODE_ID_ATTRIBUTE));
			expect(new Set(ids).size).toBe(ids.length);
			expect(ids).not.toContain(undefined);
			expect(Object.keys(tree.nodes).sort()).toEqual(ids.sort());
			$('*').each((_index, element) => {
				const node = tree.nodes[$(element).attr(NODE_ID_ATTRIBUTE)!];
				expect(node.children).toEqual($(element).children().toArray().map(child => $(child).attr(NODE_ID_ATTRIBUTE)));
				for (const viewport of ['desktop', 'mobile']) {
					expect(Object.keys(node.viewports[viewport].used_styles).sort()).toEqual([...BOX_TREE_STYLES].sort());
					expect(node.viewports[viewport].border_box.width).toBeGreaterThanOrEqual(0);
				}
			});
			files[entry.html] = html;
			files[sidecar] = JSON.stringify(tree);
		}
		expect(Object.keys(files)).toHaveLength(4);
		const transformer = process.env.BLOCKS_ENGINE_TRANSFORMER;
		if (transformer) {
			const result = JSON.parse(execFileSync('php', ['-r', `require $argv[1] . '/vendor/autoload.php'; $input=json_decode(stream_get_contents(STDIN),true); echo json_encode((new Automattic\\BlocksEngine\\PhpTransformer\\ArtifactCompiler\\ArtifactCompiler())->compile($input)->toArray());`, transformer], {
				input: JSON.stringify({ entrypoint: Object.keys(files)[0], files }), maxBuffer: 16 * 1024 * 1024,
			}).toString());
			expect(result.diagnostics.filter((row: { code: string }) => row.code.startsWith('box_tree_'))).toEqual([]);
			for (const path of Object.keys(files).filter(path => path.endsWith('.html'))) expect(result.source_reports.box_tree[path].coverage).toBe(1);
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		if (!process.env.KEEP_BOX_TREE_FIXTURE) rmSync(outputDir, { recursive: true, force: true });
	}
}, 120_000);
