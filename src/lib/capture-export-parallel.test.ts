import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import { MIN_PARALLEL_ROUTES, precollectCapturedRoutes } from './capture-export-parallel.js';

const roots: string[] = [];
afterEach( () => { for ( const root of roots.splice( 0 ) ) rmSync( root, { recursive: true, force: true } ); } );

const ROUTES = MIN_PARALLEL_ROUTES;

function capture(): string {
	const root = mkdtempSync( join( tmpdir(), 'liberation-parallel-export-' ) );
	roots.push( root );
	for ( const directory of [ 'screenshots', 'html', 'html-mobile', 'html-tablet' ] ) mkdirSync( join( root, directory ) );
	const entries: Record<string, unknown> = {};
	for ( let route = 0; route < ROUTES; route++ ) {
		const url = `https://neutral.test/${ route ? `page-${ route }` : '' }`;
		// Like a browser capture, the entrypoint records its profiles, one with a third device document.
		entries[ url ] = { slug: String( route ), html: `html/${ route }.html`, ...( route ? {} : { profiles: { desktop: { viewport: { width: 1440, height: 900 } }, tablet: { html: 'html-tablet/0.html' } } } ) };
		for ( const [ directory, device ] of [ [ 'html', 'desktop' ], [ 'html-mobile', 'mobile' ] ] ) writeFileSync( join( root, directory, `${ route }.html` ),
			`<!doctype html><html><head><title>Route ${ route }</title><style>.${ device } h1{color:${ device === 'desktop' ? 'navy' : 'teal' }}</style></head><body class="${ device }"><nav><a href="/page-${ ( route + 1 ) % ROUTES || 1 }">Next</a></nav><main><h1>${ device } route ${ route }</h1>${ device === 'mobile' ? '<button>Menu</button>' : '<p>Desktop column</p>' }</main><footer>Shared footer</footer></body></html>` );
	}
	writeFileSync( join( root, 'html-tablet', '0.html' ), '<!doctype html><html><head><title>Route 0</title></head><body class="tablet"><main><h1>tablet route 0</h1></main></body></html>' );
	// The third route cannot be exported: its page exceeds the file limit.
	writeFileSync( join( root, 'html', '2.html' ), `<!doctype html><html><head><title>Large</title></head><body><main><h1>Large</h1><p>${ 'x'.repeat( 40_000 ) }</p></main></body></html>` );
	writeFileSync( join( root, 'screenshots', 'manifest.json' ), JSON.stringify( { version: 1, entries } ) );
	return root;
}

function tree( root: string ): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = ( directory: string ) => {
		for ( const entry of readdirSync( directory, { withFileTypes: true } ) ) {
			const path = join( directory, entry.name );
			if ( entry.isDirectory() ) walk( path );
			else files[ relative( root, path ) ] = readFileSync( path, 'utf8' );
		}
	};
	walk( join( root, 'website' ) );
	const receipt = JSON.parse( readFileSync( join( root, 'capture-receipt.json' ), 'utf8' ) );
	files[ 'capture-receipt.json' ] = JSON.stringify( { routes: receipt.routes, diagnostics: receipt.discoveryDiagnostics ?? receipt.diagnostics } );
	return files;
}

it( 'exports the same site from routes collected in worker threads as from inline collection', async () => {
	const options = { sourceUrl: 'https://neutral.test/', platform: 'neutral', summary: { routesCaptured: ROUTES, routesFailed: 0 }, failures: [], limits: { maxFileBytes: 20_000 } };
	const serial = capture();
	exportWebsiteCapture( { ...options, outputDir: serial } );
	const parallel = capture();
	const precollected = await precollectCapturedRoutes( { ...options, outputDir: parallel } );
	expect( precollected?.routes.size ).toBe( ROUTES );
	try {
		exportWebsiteCapture( { ...options, outputDir: parallel, precollectedRoutes: precollected!.routes } );
	} finally {
		precollected!.release();
	}
	const expected = tree( serial );
	expect( Object.keys( expected ) ).toEqual( expect.arrayContaining( [ 'website/index.html', 'website/page-3/index.html' ] ) );
	expect( expected[ 'capture-receipt.json' ] ).toContain( 'route_export_failed' );
	expect( tree( parallel ) ).toEqual( expected );
}, 120_000 );
