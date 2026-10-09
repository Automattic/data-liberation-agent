import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { readResolvedPage } from './site-includes.js';

// Run separately from concurrent browser suites: this exercises the shipped,
// minified parser pipeline, not a mocked memory budget or a text-only document.
it.runIf( process.env.DLA_EXPORT_MEMORY_REGRESSION === '1' )( 'exports and compacts all source-sized device routes within bounded heaps', async () => {
	const root = mkdtempSync( join( process.env.DLA_EXPORT_MEMORY_ARTIFACT_ROOT ?? tmpdir(), 'dla-export-memory-' ) );
	console.log( `Export memory fixture: ${ root }` );
	try {
		for ( const directory of [ 'screenshots', 'html', 'html-mobile', 'html-tablet', 'resources' ] ) mkdirSync( join( root, directory ) );
		const css = Array.from( { length: 12_000 }, ( _, index ) => `.tile-${ index }{color:rgb(${ index % 255 },20,30);padding:1px 2px;--label:"Source tile ${ index }"}` ).join( '\n' );
		const menu = 'Source navigation content. '.repeat( 10_000 );
		const entries: Record<string, unknown> = {};
		for ( let route = 0; route < 7; route++ ) {
			const url = `https://neutral.test/${ route ? `page-${ route }` : '' }`;
			const html = `html/${ route }.html`;
			entries[ url ] = { slug: String( route ), html, profiles: { tablet: { html: `html-tablet/${ route }.html` } } };
			for ( const [ directory, device ] of [ [ 'html', 'desktop' ], [ 'html-mobile', 'mobile' ], [ 'html-tablet', 'tablet' ] ] ) {
				// Real nested landmark candidates overlap the same source text. Each
				// route/device carries distinct current-state wrappers; the inner menu
				// remains exactly shareable. Retaining all slices is quadratic in
				// nesting depth even though the input itself is source-sized.
				const wrappers = Array.from( { length: 96 }, ( _, level ) => `<div data-current="${ device }-${ route }-${ level }">` ).join( '' );
				writeFileSync( join( root, directory, `${ route }.html` ), `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${ css }</style><style>body{margin:0}.tile-0{color:blue}</style></head><body class="${ device }"><header>${ wrappers }<nav><a href="/page-${ ( route + 1 ) % 7 || 1 }">Next</a><p>${ menu }</p></nav>${ '</div>'.repeat( 96 ) }</header><main><h1>${ device } route ${ route }</h1><img src="https://neutral.test/image.svg"><section class="tile-0">Source content</section></main><footer>Shared source footer</footer></body></html>` );
			}
		}
		writeFileSync( join( root, 'screenshots', 'manifest.json' ), JSON.stringify( { version: 1, entries } ) );
		writeFileSync( join( root, 'resources', 'image.svg' ), '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path d="M0 0h2v2H0z"/></svg>' );
		writeFileSync( join( root, 'resources', 'manifest.json' ), JSON.stringify( { version: 1, resources: { 'https://neutral.test/image.svg': { path: 'resources/image.svg', contentType: 'image/svg+xml' } }, failures: [] } ) );
		const runner = join( root, 'runner.mjs' );
		await build( {
			stdin: { contents: `import {exportWebsiteCapture} from ${ JSON.stringify( new URL( './capture-export.ts', import.meta.url ).pathname ) }; exportWebsiteCapture({outputDir:${ JSON.stringify( root ) },sourceUrl:'https://neutral.test/',platform:'neutral',summary:{routesCaptured:7,routesFailed:0},failures:[],resolveDocumentSelection:()=>({kind:'device',id:'neutral',rules:[{userAgent:'Mobile',document:'mobile'},{userAgent:'Tablet',document:'tablet'}],defaultDocument:'desktop',documents:['desktop','mobile','tablet'],evidence:'Neutral request identities'})});`, resolveDir: process.cwd() },
			outfile: runner, bundle: true, platform: 'node', format: 'esm', target: 'node20', minify: true,
			banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" },
			external: [ 'playwright', 'single-file-cli' ],
		} );
		const result = spawnSync( process.execPath, [ '--max-old-space-size=384', runner ], { encoding: 'utf8', timeout: 240_000 } );
		writeFileSync( join( root, 'export-child.log' ), `${ result.stdout }${ result.stderr }` );
		expect( result.error ).toBeUndefined();
		expect( result.status, result.stderr ).toBe( 0 );
		const receipt = JSON.parse( readFileSync( join( root, 'capture-receipt.json' ), 'utf8' ) );
		expect( receipt.routes ).toHaveLength( 7 );
		expect( receipt.assets ).toHaveLength( 1 );
		const compacted = join( root, 'compacted' );
		cpSync( join( root, 'website' ), compacted, { recursive: true } );
		const expanded = new Map<string, string>();
		for ( const route of receipt.routes ) {
			const html = readResolvedPage( join( root, 'website' ), join( root, route.path ) );
			const path = route.path.replace( /^website\//, '' );
			expanded.set( path, html );
			writeFileSync( join( compacted, path ), html );
			for ( const device of [ 'desktop', 'mobile', 'tablet' ] ) expect( html ).toContain( `${ device } route` );
			expect( html ).toContain( 'tile-11999' );
			expect( html ).toContain( '/image.svg' );
			expect( route.documentSelection.missing ).toEqual( [] );
			expect( html ).toContain( menu );
			expect( html ).toContain( 'Shared source footer' );
		}
		const evidence = JSON.parse( readFileSync( join( root, 'asset-evidence.json' ), 'utf8' ) );
		expect( JSON.stringify( evidence ) ).toContain( 'https://neutral.test/image.svg' );
		expect( evidence.coverage.documentCount ).toBe( 14 );
		// Isolate the reported final owner from responsive assembly and geometry's
		// separate parsing floor. These are the real exported, include-expanded
		// routes, not a mock index or an approximation of its allocation arithmetic.
		rmSync( join( compacted, 'parts' ), { recursive: true, force: true } );
		const compactRunner = join( root, 'compact.mjs' );
		await build( {
			stdin: { contents: `import v8 from 'node:v8'; import {extractSharedChrome} from ${ JSON.stringify( new URL( './shared-chrome.ts', import.meta.url ).pathname ) }; const start=performance.now(); console.log(JSON.stringify({event:'structural-index-start',heapLimit:v8.getHeapStatistics().heap_size_limit})); extractSharedChrome(${ JSON.stringify( compacted ) },${ JSON.stringify( [ ...expanded.keys() ] ) }); console.log(JSON.stringify({event:'structural-index-complete',seconds:(performance.now()-start)/1000,memory:process.memoryUsage()}));`, resolveDir: process.cwd() },
			outfile: compactRunner, bundle: true, platform: 'node', format: 'esm', target: 'node20', minify: true,
			banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" },
		} );
		const compactResult = spawnSync( process.execPath, [ '--max-old-space-size=128', compactRunner ], { encoding: 'utf8', timeout: 120_000 } );
		writeFileSync( join( root, 'compact-child.log' ), `${ compactResult.stdout }${ compactResult.stderr }` );
		console.log( compactResult.stdout );
		expect( compactResult.error ).toBeUndefined();
		expect( compactResult.status, compactResult.stderr ).toBe( 0 );
		for ( const [ path, html ] of expanded ) expect( readResolvedPage( compacted, join( compacted, path ) ) ).toBe( html );
		expect( readFileSync( join( compacted, 'image.svg' ), 'utf8' ) ).toBe( readFileSync( join( root, 'website', 'image.svg' ), 'utf8' ) );
	} finally { if ( ! process.env.DLA_EXPORT_MEMORY_ARTIFACT_ROOT ) rmSync( root, { recursive: true, force: true } ); }
}, 300_000 );
