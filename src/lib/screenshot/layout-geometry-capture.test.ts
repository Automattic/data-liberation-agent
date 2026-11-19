import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'cheerio';
import { expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { captureScreenshots } from './screenshotter.js';

const variants = [
	{ name: 'selector through the wrapper resizes the target', css: '.w .c { padding: 100px }', reduced: false, omission: 'geometry_unproven' },
	{ name: 'selector through the wrapper moves only a descendant', css: '.w .c { position: relative; left: 10px }', reduced: false, omission: 'descendant_geometry_unproven' },
	{ name: 'no selector through the wrapper', css: '', reduced: true, omission: undefined },
];

// Three desktop-only captures/exports (~15s): wrapper removal is measured in the live page.
it( 'accepts a wrapper reduction only when real removal keeps every descendant box', async ( { serve } ) => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	for ( const variant of variants ) {
		const fixture = `<!doctype html><html><head><style>body{margin:0}${ variant.css }</style></head><body><div class="w"><div class="t"><div class="c">x</div></div></div></body></html>`;
		const { origin } = await serve( ( _request, response ) => {
			response.setHeader( 'Content-Type', 'text/html' );
			response.end( fixture );
		} );
		const sourceUrl = `${ origin }/`;
		const outputDir = mkdtempSync( join( parent, 'layout-geometry-' ) );
		try {
			const capture = await captureScreenshots( { urls: [ sourceUrl ], outputDir, concurrency: 1, settleMs: 0, viewports: [ { id: 'desktop', width: 800, height: 600 } ] } );
			expect( capture.failed, variant.name ).toBe( 0 );
			const sidecar = JSON.parse( readFileSync( join( outputDir, 'layout-geometry', 'homepage.desktop.json' ), 'utf8' ) );
			if ( variant.omission ) expect( sidecar.omissions[ variant.omission ], variant.name ).toBeGreaterThan( 0 );
			exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary: {}, failures: [] } );
			const $ = load( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) );
			// The live page is restored exactly before serialization.
			expect( $( 'body > .w > .t > .c' ).text(), variant.name ).toBe( 'x' );
			const proofPath = join( outputDir, 'layout-geometry-proof.json' );
			// No proof file is written when nothing on the route reduces.
			const proof = ( existsSync( proofPath ) ? JSON.parse( readFileSync( proofPath, 'utf8' ) ) : { nodes: [], reductions: [] } ) as {
				nodes: Array< { id: string; selector: string } >;
				reductions: Array< { wrapper: string; invariants: { selectors: boolean } } >;
			};
			const reducesW = proof.reductions.filter( ( reduction ) => {
				const selector = proof.nodes.find( ( node ) => node.id === reduction.wrapper )!.selector;
				return $( selector ).is( '.w' );
			} );
			expect( reducesW.length > 0, variant.name ).toBe( variant.reduced );
			for ( const reduction of reducesW ) expect( reduction.invariants.selectors ).toBe( true );
		} finally {
			rmSync( outputDir, { recursive: true, force: true } );
		}
	}
}, 120_000 );
