// Run from a source checkout with: node --import tsx scripts/benchmark-export.ts
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { exportWebsiteCapture } from '../src/lib/capture-export.js';
import { readResolvedPage } from '../src/lib/site-includes.js';

const pages = Number( process.env.PAGES ?? 320 );
const items = Number( process.env.ITEMS ?? 80 );
mkdirSync( '.tmp-test', { recursive: true } );
const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test/export-bench-' ) );
try {
	for ( const dir of [ 'html', 'screenshots' ] ) mkdirSync( join( outputDir, dir ) );
	const sourceUrl = 'https://example.test/';
	const entries = Object.fromEntries( Array.from( { length: pages }, ( _, page ) => {
		const html = `html/${ page }.html`;
		const content = Array.from( { length: items }, ( _, item ) => `<section id="yui_3_17_2_1_${ 1700000000000 + page }_${ item }"><p>${ 'Synthetic content '.repeat( 12 ) }</p>${ item === 0 ? '<img src="/missing.jpg" srcset="/small.jpg 320w, /large.jpg 1280w">' : '' }</section>` ).join( '' );
		writeFileSync( join( outputDir, html ), `<!doctype html><html><head><title>Page ${ page }</title></head><body><main>${ content }</main></body></html>` );
		return [ page === 0 ? sourceUrl : `${ sourceUrl }page-${ page }/`, { html } ];
	} ) );
	writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries } ) );
	const start = performance.now();
	const receiptPath = exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary: {}, failures: [] } );
	const exportMs = Math.round( performance.now() - start );
	const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) ) as { routes: { path: string }[] };
	const hash = createHash( 'sha256' );
	for ( const route of receipt.routes ) hash.update( readResolvedPage( join( outputDir, 'website' ), join( outputDir, route.path ) ) );
	console.log( JSON.stringify( { pages, items, exportMs, htmlHash: hash.digest( 'hex' ) } ) );
} finally {
	rmSync( outputDir, { recursive: true, force: true } );
}
