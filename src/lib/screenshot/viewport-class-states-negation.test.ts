import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';
import { aliasRules, projectViewportClassRules } from './viewport-class-states.js';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

const fixture = readFileSync( new URL( './fixtures/width-class.html', import.meta.url ), 'utf8' );
const aliases = [ { token: 'narrow', alias: 'width-state', media: '(max-width:599px)' } ];
const geometry = ( page: Page ) => page.locator( '.media,.text' ).evaluateAll( nodes => nodes.map( node => {
	const rect = node.getBoundingClientRect();
	return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
} ) );

it( 'projects negated tokens into complementary states without changing specificity or context', () => {
	const rules = aliasRules( [ '@supports(display:flex){.card:not(.narrow),.card:not(:not(.narrow)){display:flex}}' ], aliases ).join( '\n' );
	expect( rules ).toContain( '@supports (display:flex)' );
	expect( rules ).toContain( '@media (max-width:599px)' );
	expect( rules ).toContain( '.card:not(:is(.narrow,.width-state))' );
	expect( rules ).toContain( '.card:not(:not(:is(.narrow,.width-state)))' );
	expect( rules ).toContain( '@media not (((max-width:599px)))' );
	expect( rules ).toContain( '.card:not(.narrow),.card:not(:not(.narrow))' );
} );

it( 'projects the reduced page rules in their cascade slots, including linked sheet URLs and media', () => {
	const css = fixture.match( /<style>([\s\S]*?)<\/style>/ )![1]!;
	const rules = aliasRules( [ css ], aliases );
	expect( rules ).toHaveLength( 3 );
	expect( rules[0] ).toContain( '.card:not(:is(.narrow,.width-state))' );
	expect( rules[1] ).toContain( '.card:not(:is(.narrow,.width-state)) > *' );
	expect( rules[2] ).toContain( '.card:is(.narrow,.width-state) .text' );
	const html = `<html><head><link rel="stylesheet" href="card.css" media="screen"><style>.card{display:grid}</style></head><body data-blocks-engine-capture-width-class-contracts='${ JSON.stringify( aliases ) }'></body></html>`;
	const projected = projectViewportClassRules( html, () => ( { css: `${css}.media{background:url(image.png)}`, url: 'https://example.test/assets/card.css' } ) );
	expect( projected ).not.toContain( '<link' );
	expect( projected ).toContain( '<style media="screen">' );
	expect( projected ).toContain( 'https://example.test/assets/image.png' );
	expect( projected.indexOf( '.card:not(:is(' ) ).toBeLessThan( projected.indexOf( '.card{display:grid}' ) );
	expect( projected ).not.toContain( 'width-class-contracts' );
} );

// One capture/export (~20s), testing the issue's reduced page at both widths.
it( 'stacks a width-class card on phones and keeps it side by side on desktop', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'width-class-negation-' ) );
	let portable = '';
	const server = createServer( ( request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( request.url === '/copy/' ? portable : fixture );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const sourceUrl = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	const browser = await chromium.launch();
	try {
		const capture = await captureScreenshots( { urls: [ sourceUrl ], outputDir, concurrency: 1, settleMs: 0, deviceMode: 'auto', learnFluid: true } );
		expect( capture.failed ).toBe( 0 );
		exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary: {}, failures: [] } );
		portable = readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' );
		const source = await browser.newPage();
		const copy = await browser.newPage();
		await source.goto( sourceUrl );
		await copy.goto( `${ sourceUrl }copy/` );
		for ( const width of [ 390, 1440 ] ) {
			await source.setViewportSize( { width, height: 900 } );
			await copy.setViewportSize( { width, height: 900 } );
			await expect.poll( () => source.locator( '.card' ).evaluate( node => node.classList.contains( 'narrow' ) ) ).toBe( width === 390 );
			const expected = await geometry( source );
			const actual = await geometry( copy );
			for ( let i = 0; i < expected.length; i++ ) for ( const key of [ 'x', 'y', 'width', 'height' ] as const ) {
				expect( Math.abs( actual[i]![key] - expected[i]![key] ), `${key} at ${width}px` ).toBeLessThanOrEqual( 1 );
			}
			if ( width === 390 ) expect( actual[1]!.y ).toBeGreaterThanOrEqual( actual[0]!.y + actual[0]!.height );
			else expect( actual[1]!.y ).toBe( actual[0]!.y );
		}
	} finally {
		await browser.close();
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );
