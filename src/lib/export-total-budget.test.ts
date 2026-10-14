import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, describe, expect, it } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import { buildSourceFindings, writeSourceFindings } from './source-findings.js';
import { isUsableCapture, missingRoutes } from './capture-usability.js';
import {
	DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_BYTES, emptyExportBudgetExclusions, measureWebsite, planExportBudget,
	recordFinalWebsiteSize, resolveExportTotalBudget, validateMaxFiles, validateMaxTotalBytes,
} from './export-total-budget.js';
import { MediaStubStore } from './resume-state/index.js';
import { TRANSPARENT_IMAGE_DATA_URL } from './portable-assets.js';

const SOURCE = 'https://example.com/';
const ABOUT = 'https://example.com/about';
const CONTACT = 'https://example.com/contact';
const HERO = 'https://example.com/hero.png';
const VIDEO = 'https://example.com/media/clip.mp4';
const PHOTO = 'https://cdn.example/photo.png';
const STYLES = 'https://example.com/about.css';
const FONT = 'https://example.com/brand.woff2';

const dirs: string[] = [];
afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

function tempDir( prefix: string ): string {
	const dir = mkdtempSync( join( tmpdir(), prefix ) );
	dirs.push( dir );
	return dir;
}

/**
 * Three routes, entrypoint first. The homepage needs a 2 KiB hero image. `/about`
 * carries an 8 KiB video and a 4 KiB brand font (through its stylesheet) as page
 * resources, plus a 5 KiB photo as a media stub. `/contact` is a page padded
 * to 20 KiB.
 */
function fixture(): string {
	const outputDir = tempDir( 'liberation-total-budget-' );
	for ( const path of [ 'html', 'resources/media', 'media', 'screenshots' ] ) mkdirSync( join( outputDir, path ), { recursive: true } );
	writeFileSync( join( outputDir, 'html/homepage.html' ), `<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1><img src="${ HERO }" alt="Hero"><a href="/about">About</a> <a href="/contact">Contact</a></body></html>` );
	writeFileSync( join( outputDir, 'html/about.html' ), `<!doctype html><html><head><title>About</title><link rel="stylesheet" href="${ STYLES }"></head><body><h1>About</h1><video src="${ VIDEO }" muted></video><img src="${ PHOTO }" alt="Photo"></body></html>` );
	writeFileSync( join( outputDir, 'html/contact.html' ), `<!doctype html><html><head><title>Contact</title></head><body><h1>Contact</h1><p>${ 'x'.repeat( 20 * 1024 ) }</p></body></html>` );
	writeFileSync( join( outputDir, 'resources/media/hero.png' ), Buffer.alloc( 2048, 3 ) );
	writeFileSync( join( outputDir, 'resources/media/clip.mp4' ), Buffer.alloc( 8192, 1 ) );
	writeFileSync( join( outputDir, 'resources/about.css' ), `@font-face{font-family:Brand;src:url(${ FONT }) format("woff2")}h1{font-family:Brand}` );
	writeFileSync( join( outputDir, 'resources/media/brand.woff2' ), Buffer.alloc( 4096, 4 ) );
	writeFileSync( join( outputDir, 'media/photo.png' ), Buffer.alloc( 5120, 2 ) );
	writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: {
		[ SOURCE ]: { html: 'html/homepage.html' },
		[ ABOUT ]: { html: 'html/about.html' },
		[ CONTACT ]: { html: 'html/contact.html' },
	} } ) );
	writeFileSync( join( outputDir, 'resources/manifest.json' ), JSON.stringify( { version: 1, failures: [], resources: {
		[ HERO ]: { path: 'resources/media/hero.png', contentType: 'image/png' },
		[ VIDEO ]: { path: 'resources/media/clip.mp4', contentType: 'video/mp4' },
		[ STYLES ]: { path: 'resources/about.css', contentType: 'text/css' },
		[ FONT ]: { path: 'resources/media/brand.woff2', contentType: 'font/woff2' },
	} } ) );
	const media = MediaStubStore.load( outputDir );
	media.markSuccess( PHOTO, join( outputDir, 'media/photo.png' ) );
	media.flush();
	return outputDir;
}

const summary = { routesDiscovered: 3, routesCaptured: 3, routesSkipped: 0, routesFailed: 0, routesOmitted: 0 };

interface Receipt {
	discoveryDiagnostics: Array< { code: string; url: string; reason: string; unit?: string; severity?: string; metrics?: Record< string, number > } >;
	summary: { routesCaptured: number; routesFailed: number; complete: boolean };
	routes: Array< { url: string; path: string } >;
	exportBudget: { maxTotalBytes: number; maxFiles: number; totalBytes: number; files: number; withinBudget: boolean; droppedAssets: number; droppedRoutes: number; passes: number; final?: { totalBytes: number; files: number; withinBudget: boolean } };
}

const receiptOf = ( outputDir: string ): Receipt => JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) ) as Receipt;

function exportWith( limits?: { maxTotalBytes?: number; maxFiles?: number } ): { outputDir: string; receipt: Receipt; website: ReturnType< typeof measureWebsite > } {
	const outputDir = fixture();
	exportWebsiteCapture( { outputDir, sourceUrl: SOURCE, platform: 'generic', summary, failures: [], ...( limits ? { limits } : {} ) } );
	return { outputDir, receipt: receiptOf( outputDir ), website: measureWebsite( join( outputDir, 'website' ) ) };
}

const extensions = ( website: ReturnType< typeof measureWebsite > ) => website.files.map( file => file.path.split( '.' ).pop() ).sort();
const budgetRows = ( receipt: Receipt ) => receipt.discoveryDiagnostics.filter( row => row.code === 'asset_exceeds_total_budget' || row.code === 'route_exceeds_total_budget' );

describe( 'export total budget (maxTotalBytes, maxFiles)', () => {
	it( 'defaults to the importer staged-archive bounds and validates overrides', () => {
		expect( DEFAULT_MAX_TOTAL_BYTES ).toBe( 262_144_000 );
		expect( DEFAULT_MAX_FILES ).toBe( 5000 );
		expect( resolveExportTotalBudget() ).toEqual( { maxTotalBytes: 262_144_000, maxFiles: 5000, reservedBytes: 0, reservedFiles: 0 } );
		expect( resolveExportTotalBudget( { reservePostExport: true } ) ).toMatchObject( { reservedBytes: 8 * 1024 * 1024, reservedFiles: 16 } );
		// The reserve never takes more than a quarter of a small budget.
		expect( resolveExportTotalBudget( { maxTotalBytes: 4000, maxFiles: 8, reservePostExport: true } ) ).toMatchObject( { reservedBytes: 1000, reservedFiles: 2 } );
		for ( const invalid of [ 0, -1, 1.5, Number.NaN, '1' ] ) {
			expect( () => validateMaxTotalBytes( invalid ) ).toThrow( RangeError );
			expect( () => validateMaxFiles( invalid ) ).toThrow( RangeError );
		}
	} );

	it( 'leaves an under-budget export unchanged', () => {
		const baseline = exportWith();
		const roomy = exportWith( { maxTotalBytes: baseline.website.totalBytes, maxFiles: baseline.website.files.length } );
		expect( roomy.website.files ).toEqual( baseline.website.files );
		for ( const { path } of baseline.website.files ) {
			expect( readFileSync( join( roomy.outputDir, 'website', path ) ) ).toEqual( readFileSync( join( baseline.outputDir, 'website', path ) ) );
		}
		expect( budgetRows( roomy.receipt ) ).toEqual( [] );
		expect( roomy.receipt.exportBudget ).toMatchObject( { withinBudget: true, droppedAssets: 0, droppedRoutes: 0, passes: 1, totalBytes: baseline.website.totalBytes } );
		expect( extensions( baseline.website ) ).toEqual( expect.arrayContaining( [ 'mp4', 'png', 'png', 'woff2', 'css' ] ) );
	} );

	it( 'drops the largest assets the entrypoint does not need first, reports them and ends under budget', () => {
		const baseline = exportWith();
		const maxTotalBytes = baseline.website.totalBytes - 6000;
		const { outputDir, receipt, website } = exportWith( { maxTotalBytes } );

		expect( website.totalBytes ).toBeLessThanOrEqual( maxTotalBytes );
		// Only the 8 KiB video was needed; the photo, font and hero stay.
		expect( extensions( website ).filter( extension => extension === 'mp4' ) ).toEqual( [] );
		expect( website.files.filter( file => file.path.endsWith( '.png' ) ) ).toHaveLength( 2 );
		expect( website.files.some( file => file.path.endsWith( '.woff2' ) ) ).toBe( true );
		expect( budgetRows( receipt ) ).toEqual( [ expect.objectContaining( {
			code: 'asset_exceeds_total_budget', url: VIDEO, unit: 'asset', severity: 'warning',
			metrics: { bytes: 8192, limit: maxTotalBytes, fileLimit: DEFAULT_MAX_FILES },
		} ) ] );
		// Unresolved like any missing asset: the uncaptured video keeps its source URL.
		expect( readFileSync( join( outputDir, 'website', 'about', 'index.html' ), 'utf8' ) ).toContain( `<video src="${ VIDEO }"` );
		const diagnostics = JSON.parse( readFileSync( join( outputDir, 'diagnostics.json' ), 'utf8' ) ) as { unresolvedDependencies: Array< { url: string; error: string } > };
		expect( diagnostics.unresolvedDependencies ).toContainEqual( expect.objectContaining( { url: VIDEO, error: 'captured dependency dropped to keep the website within the total export budget' } ) );
		// An asset loss keeps every route and the capture complete.
		expect( receipt.routes.map( route => route.url ) ).toEqual( [ SOURCE, ABOUT, CONTACT ] );
		expect( receipt.summary ).toMatchObject( { routesCaptured: 3, routesFailed: 0, complete: true } );
		expect( receipt.exportBudget ).toMatchObject( { withinBudget: true, droppedAssets: 1, droppedRoutes: 0, totalBytes: website.totalBytes } );
	} );

	it( 'drops media stubs like page resources, and fonts only after every other asset', () => {
		const baseline = exportWith();
		const maxTotalBytes = baseline.website.totalBytes - 8192 - 4000;
		const { outputDir, receipt, website } = exportWith( { maxTotalBytes } );
		expect( website.totalBytes ).toBeLessThanOrEqual( maxTotalBytes );
		expect( budgetRows( receipt ).map( row => row.url ).sort() ).toEqual( [ PHOTO, VIDEO ].sort() );
		expect( website.files.some( file => file.path.endsWith( '.woff2' ) ) ).toBe( true );
		const about = readFileSync( join( outputDir, 'website', 'about', 'index.html' ), 'utf8' );
		expect( about ).not.toContain( PHOTO );
		expect( about ).toContain( 'src="data:image/gif;base64,' );
	} );

	it( 'drops non-entry routes, last in route order first, when assets are not enough', () => {
		const baseline = exportWith();
		const maxTotalBytes = baseline.website.totalBytes - 8192 - 5120 - 4096 - 10_000;
		const { outputDir, receipt, website } = exportWith( { maxTotalBytes } );

		expect( website.totalBytes ).toBeLessThanOrEqual( maxTotalBytes );
		expect( receipt.routes.map( route => route.url ) ).toEqual( [ SOURCE, ABOUT ] );
		expect( existsSync( join( outputDir, 'website', 'contact', 'index.html' ) ) ).toBe( false );
		expect( existsSync( join( outputDir, 'website', 'index.html' ) ) ).toBe( true );
		const routeRows = budgetRows( receipt ).filter( row => row.code === 'route_exceeds_total_budget' );
		expect( routeRows ).toEqual( [ expect.objectContaining( { url: CONTACT, unit: 'route', severity: 'error', metrics: expect.objectContaining( { limit: maxTotalBytes } ) } ) ] );
		expect( routeRows[ 0 ]!.metrics!.bytes ).toBeGreaterThan( 20 * 1024 );
		// A dropped route is a missing route, counted as failed.
		expect( missingRoutes( receipt.discoveryDiagnostics ) ).toEqual( [ { url: CONTACT, code: 'route_exceeds_total_budget', reason: expect.stringContaining( 'export budget' ) } ] );
		expect( receipt.summary ).toMatchObject( { routesCaptured: 2, routesFailed: 1, complete: false } );
		// The entrypoint still renders with the hero it needs.
		expect( website.files.filter( file => file.path.endsWith( '.png' ) ) ).toHaveLength( 1 );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toContain( '<h1>Home</h1>' );
	} );

	it( 'never drops the entrypoint or the files it needs, even when they alone exceed the budget', () => {
		const { outputDir, receipt, website } = exportWith( { maxTotalBytes: 1, maxFiles: 1 } );
		expect( receipt.routes.map( route => route.url ) ).toEqual( [ SOURCE ] );
		expect( website.files.map( file => file.path ) ).toContain( 'index.html' );
		const hero = website.files.find( file => file.path.endsWith( '.png' ) );
		expect( hero?.bytes ).toBe( 2048 );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toContain( hero!.path.split( '/' ).pop() );
		expect( receipt.exportBudget ).toMatchObject( { withinBudget: false, droppedRoutes: 2 } );
		expect( budgetRows( receipt ).some( row => row.url === SOURCE || row.url === HERO ) ).toBe( false );
	} );

	it( 'enforces the file count like the byte total', () => {
		const baseline = exportWith();
		const maxFiles = baseline.website.files.length - 1;
		const { receipt, website } = exportWith( { maxFiles } );
		expect( website.files.length ).toBeLessThanOrEqual( maxFiles );
		// One file over: the largest droppable asset goes.
		expect( budgetRows( receipt ).map( row => row.url ) ).toEqual( [ VIDEO ] );
		expect( receipt.routes ).toHaveLength( 3 );
	} );

	it( 'writes budget losses into website/source-findings.json as omitted units and counts it in the final size', () => {
		const baseline = exportWith();
		const maxTotalBytes = baseline.website.totalBytes - 8192 - 5120 - 4096 - 10_000;
		const { outputDir, receipt } = exportWith( { maxTotalBytes } );
		const missing = missingRoutes( receipt.discoveryDiagnostics );
		const input = { complete: false, entrypointCaptured: true, summary: { ...summary, routesCaptured: 2, routesFailed: 1 }, unresolvedAnchors: [], discoveryDiagnostics: receipt.discoveryDiagnostics as never };
		const findings = buildSourceFindings( input );
		expect( findings.findings.filter( finding => finding.code.endsWith( '_total_budget' ) ) ).toEqual( [
			expect.objectContaining( { code: 'asset_exceeds_total_budget', unit: 'asset', loss_class: 'omitted_unit', location: { url: PHOTO } } ),
			expect.objectContaining( { code: 'asset_exceeds_total_budget', unit: 'asset', loss_class: 'omitted_unit', location: { url: STYLES } } ),
			expect.objectContaining( { code: 'asset_exceeds_total_budget', unit: 'asset', loss_class: 'omitted_unit', location: { url: FONT } } ),
			expect.objectContaining( { code: 'route_exceeds_total_budget', unit: 'route', loss_class: 'omitted_unit', severity: 'error', location: { url: CONTACT } } ),
			expect.objectContaining( { code: 'asset_exceeds_total_budget', unit: 'asset', loss_class: 'omitted_unit', location: { url: VIDEO } } ),
		] );
		expect( findings.usable ).toBe( isUsableCapture( { complete: false, entrypointCaptured: true, missingRoutes: missing, summary: input.summary } ) );

		writeSourceFindings( outputDir, input );
		recordFinalWebsiteSize( outputDir, join( outputDir, 'capture-receipt.json' ) );
		const final = receiptOf( outputDir ).exportBudget.final!;
		const measured = measureWebsite( join( outputDir, 'website' ) );
		expect( measured.files.map( file => file.path ) ).toContain( 'source-findings.json' );
		expect( final ).toEqual( { totalBytes: measured.totalBytes, files: measured.files.length, withinBudget: measured.totalBytes <= maxTotalBytes } );
	} );
} );

describe( 'planExportBudget', () => {
	function website( files: Record< string, string | number > ): string {
		const dir = tempDir( 'liberation-budget-plan-' );
		for ( const [ path, content ] of Object.entries( files ) ) {
			mkdirSync( join( dir, path, '..' ), { recursive: true } );
			writeFileSync( join( dir, path ), typeof content === 'number' ? Buffer.alloc( content ) : content );
		}
		return dir;
	}

	it( 'orders droppable assets largest first with fonts last, and keeps what the entrypoint references', () => {
		const dir = website( {
			'index.html': '<img src="/media/hero.png"><link rel="stylesheet" href="/assets/site.css">',
			'assets/site.css': '@font-face{src:url(entry.woff2)}',
			'assets/entry.woff2': 7000,
			'media/hero.png': 9000,
			'media/clip.mp4': 1000,
			'media/big.png': 3000,
			'media/small.png': 2000,
			'assets/brand.woff2': 5000,
			'about/index.html': '<img src="/media/big.png"><img src="/media/small.png"><video src="/media/clip.mp4"></video>',
		} );
		const budget = { maxTotalBytes: 1, maxFiles: 100, reservedBytes: 0, reservedFiles: 0 };
		const assets = [ 'media/hero.png', 'media/clip.mp4', 'media/big.png', 'media/small.png', 'assets/brand.woff2', 'assets/entry.woff2' ]
			.map( path => ( { path, sourceUrls: [ `https://example.com/${ path }` ] } ) );
		const routes = [ { url: SOURCE, path: 'index.html' }, { url: ABOUT, path: 'about/index.html' } ];
		const { totalBytes } = measureWebsite( dir );
		const plan = ( need: number ) => planExportBudget( { websiteDir: dir, budget: { ...budget, maxTotalBytes: totalBytes - need }, entrypointPath: 'index.html', routes, assets, exclusions: emptyExportBudgetExclusions() } );

		expect( [ ...plan( 4000 ).next!.assets.keys() ] ).toEqual( [ 'https://example.com/media/big.png', 'https://example.com/media/small.png' ] );
		expect( [ ...plan( 6000 ).next!.assets.keys() ] ).toEqual( [ 'https://example.com/media/big.png', 'https://example.com/media/small.png', 'https://example.com/media/clip.mp4' ] );
		expect( [ ...plan( 7000 ).next!.assets.keys() ] ).toEqual( [ 'https://example.com/media/big.png', 'https://example.com/media/small.png', 'https://example.com/media/clip.mp4', 'https://example.com/assets/brand.woff2' ] );
		const exhausted = plan( 12_000 ).next!;
		// The entry's hero and its stylesheet's font are never candidates; the route goes instead.
		expect( exhausted.assets.has( 'https://example.com/media/hero.png' ) ).toBe( false );
		expect( exhausted.assets.has( 'https://example.com/assets/entry.woff2' ) ).toBe( false );
		expect( [ ...exhausted.routes.keys() ] ).toEqual( [ ABOUT ] );
		expect( plan( 0 ) ).toMatchObject( { withinBudget: true, totalBytes } );
		expect( plan( 0 ).next ).toBeUndefined();
	} );

	it( 'puts a video before an image of the same size', () => {
		const dir = website( { 'index.html': '<h1>Home</h1>', 'media/a.png': 1000, 'media/b.webm': 1000 } );
		const assets = [ 'media/a.png', 'media/b.webm' ].map( path => ( { path, sourceUrls: [ path ] } ) );
		const { totalBytes } = measureWebsite( dir );
		const plan = planExportBudget( { websiteDir: dir, budget: { maxTotalBytes: totalBytes - 1, maxFiles: 100, reservedBytes: 0, reservedFiles: 0 }, entrypointPath: 'index.html', routes: [ { url: SOURCE, path: 'index.html' } ], assets, exclusions: emptyExportBudgetExclusions() } );
		expect( [ ...plan.next!.assets.keys() ] ).toEqual( [ 'media/b.webm' ] );
	} );
} );

describe( 'redundant srcset renditions first', () => {
	function website( files: Record< string, string | number > ): string {
		const dir = tempDir( 'liberation-rendition-plan-' );
		for ( const [ path, content ] of Object.entries( files ) ) {
			mkdirSync( join( dir, path, '..' ), { recursive: true } );
			writeFileSync( join( dir, path ), typeof content === 'number' ? Buffer.alloc( content ) : content );
		}
		return dir;
	}

	const rendition = ( name: string ) => `https://cdn.example/${ name }.webp`;

	it( 'drops redundant renditions before any unique asset, keeping each src rendition and the widest candidate at or under 2048px', () => {
		const dir = website( {
			'index.html':
				'<img src="/media/photo-320.webp" srcset="/media/photo-160.webp 160w, /media/photo-320.webp 320w, /media/photo-640.webp 640w, /media/photo-1280.webp 1280w" sizes="500px">' +
				'<img src="/media/hero.png" alt="Hero">',
			'about/index.html': '<img src="/media/unique.png" alt="Unique">',
			'media/photo-160.webp': 600,
			'media/photo-320.webp': 1000,
			'media/photo-640.webp': 2000,
			'media/photo-1280.webp': 4000,
			'media/hero.png': 3000,
			'media/unique.png': 4100,
		} );
		const renditions = [ 'media/photo-160.webp', 'media/photo-320.webp', 'media/photo-640.webp', 'media/photo-1280.webp' ];
		const assets = [ ...renditions, 'media/hero.png', 'media/unique.png' ]
			.map( path => ( { path, sourceUrls: [ `https://example.com/${ path }` ] } ) );
		const routes = [ { url: SOURCE, path: 'index.html' }, { url: ABOUT, path: 'about/index.html' } ];
		const { totalBytes } = measureWebsite( dir );
		const plan = ( need: number ) => planExportBudget( { websiteDir: dir, budget: { maxTotalBytes: totalBytes - need, maxFiles: 100, reservedBytes: 0, reservedFiles: 0 }, entrypointPath: 'index.html', routes, assets, exclusions: emptyExportBudgetExclusions() } );

		// Rendition 640w (2000 bytes) is droppable here: the site keeps its src rendition (320w) and the widest candidate at or under 2048px (1280w).
		const early = plan( 2000 );
		expect( early.next!.assets.size ).toBe( 0 );
		expect( early.next!.renditions.size ).toBe( 1 );
		expect( early.next!.renditions.has( 'https://example.com/media/photo-640.webp' ) ).toBe( true );

		// The unique asset is only touched when dropped renditions are not enough.
		const further = plan( 4000 );
		expect( [ ...further.next!.renditions.keys() ] ).toEqual( [ 'https://example.com/media/photo-640.webp', 'https://example.com/media/photo-160.webp' ] );
		expect( [ ...further.next!.assets.keys() ] ).toEqual( [ 'https://example.com/media/unique.png' ] );
	} );

	it( 'resolves root-relative srcset candidates on nested routes from the website root', () => {
		const dir = website( {
			'index.html': '<h1>Home</h1>',
			'about/index.html': '<img src="/media/photo-320.webp" srcset="/media/photo-160.webp 160w, /media/photo-320.webp 320w, /media/photo-1280.webp 1280w" sizes="500px">',
			'media/photo-160.webp': 600,
			'media/photo-320.webp': 1000,
			'media/photo-1280.webp': 4000,
		} );
		const assets = [ 'media/photo-160.webp', 'media/photo-320.webp', 'media/photo-1280.webp' ]
			.map( path => ( { path, sourceUrls: [ `https://example.com/${ path }` ] } ) );
		const routes = [ { url: SOURCE, path: 'index.html' }, { url: ABOUT, path: 'about/index.html' } ];
		const { totalBytes } = measureWebsite( dir );
		const plan = planExportBudget( { websiteDir: dir, budget: { maxTotalBytes: totalBytes - 600, maxFiles: 100, reservedBytes: 0, reservedFiles: 0 }, entrypointPath: 'index.html', routes, assets, exclusions: emptyExportBudgetExclusions() } );
		// The only srcset lives on a nested route; its 160w rendition is redundant, so it goes before any route or unique asset.
		expect( [ ...plan.next!.renditions.keys() ] ).toEqual( [ 'https://example.com/media/photo-160.webp' ] );
		expect( plan.next!.assets.size ).toBe( 0 );
		expect( plan.next!.routes.size ).toBe( 0 );
	} );

	it( 'never drops a rendition an element uses as its src', () => {
		const dir = website( {
			'index.html':
				'<img src="/media/photo-640.webp" srcset="/media/photo-160.webp 160w, /media/photo-320.webp 320w, /media/photo-640.webp 640w, /media/photo-1280.webp 1280w" sizes="500px">' +
				'<img src="/media/hero.png" alt="Hero">',
			'media/photo-160.webp': 600,
			'media/photo-320.webp': 1000,
			'media/photo-640.webp': 2000,
			'media/photo-1280.webp': 4000,
			'media/hero.png': 3000,
		} );
		const assets = [ 'media/photo-160.webp', 'media/photo-320.webp', 'media/photo-640.webp', 'media/photo-1280.webp', 'media/hero.png' ]
			.map( path => ( { path, sourceUrls: [ `https://example.com/${ path }` ] } ) );
		const routes = [ { url: SOURCE, path: 'index.html' } ];
		// Enough to require at most one rendition; the largest droppable first is 320w.
		const need = 800;
		const { totalBytes } = measureWebsite( dir );
		const plan = planExportBudget( { websiteDir: dir, budget: { maxTotalBytes: totalBytes - need, maxFiles: 100, reservedBytes: 0, reservedFiles: 0 }, entrypointPath: 'index.html', routes, assets, exclusions: emptyExportBudgetExclusions() } );
		// The src rendition (640w) and the preferred candidate (1280w) stay; the next rendering choice is 320w.
		expect( [ ...plan.next!.renditions.keys() ] ).toEqual( [ 'https://example.com/media/photo-320.webp' ] );
		expect( plan.next!.assets.size ).toBe( 0 );
	} );

	it( 'exports a bounded rendition set with every reference still resolving, and diagnoses each dropped rendition', () => {
		const widths = [ 160, 320, 640, 1280, 2560 ];
		const bytesOfWidth = ( width: number ) => ( { 160: 600, 320: 1000, 640: 2000, 1280: 4000, 2560: 8000 } )[ width as 160 ] ?? 0;
		const renditionHtml = ( prefix: string, srcWidth: number ) => {
			const list = widths.map( width => `${ rendition( `${ prefix }-${ width }` ) } ${ width }w` ).join( ', ' );
			return `<img src="${ rendition( `${ prefix }-${ srcWidth }` ) }" srcset="${ list }" sizes="500px" alt="${ prefix }">`;
		};
		const unique = 'https://cdn.example/hero.png';
		// Each srcset drops three renditions: the element's src rendition (320w / 640w) and the widest candidate at or under 2048px (1280w) stay in both lists.
		const droppedRenditions = [ [ 'photo', '160' ], [ 'photo', '640' ], [ 'photo', '2560' ], [ 'other', '160' ], [ 'other', '320' ], [ 'other', '2560' ] ];
		const droppedBytes = droppedRenditions.map( ( [ prefix, width ] ) => bytesOfWidth( Number( width ) ) ).reduce( ( sum, bytes ) => sum + bytes, 0 );
		const fixture = ( name: string ): string => {
			const outputDir = tempDir( name );
			for ( const path of [ 'html', 'resources/media', 'screenshots' ] ) mkdirSync( join( outputDir, path ), { recursive: true } );
			writeFileSync( join( outputDir, 'html/homepage.html' ),
				`<!doctype html><html><head><title>Renditions</title></head><body><h1>Renditions</h1>${ renditionHtml( 'photo', 320 ) }${ renditionHtml( 'other', 640 ) }<img src="${ unique }" alt="Hero"></body></html>` );
			for ( const prefix of [ 'photo', 'other' ] ) {
				for ( const width of widths ) writeFileSync( join( outputDir, `resources/media/${ prefix }-${ width }.webp` ), Buffer.alloc( bytesOfWidth( width ), width % 200 + 3 + ( prefix === 'other' ? 17 : 0 ) ) );
			}
			writeFileSync( join( outputDir, 'resources/media/hero.png' ), Buffer.alloc( 8000, 9 ) );
			writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ SOURCE ]: { html: 'html/homepage.html' } } } ) );
			const resources = Object.fromEntries( [
				...[ 'photo', 'other' ].flatMap( prefix => widths.map( width => [ rendition( `${ prefix }-${ width }` ), { path: `resources/media/${ prefix }-${ width }.webp`, contentType: 'image/webp' } ] ) ),
				[ unique, { path: 'resources/media/hero.png', contentType: 'image/png' } ],
			] );
			writeFileSync( join( outputDir, 'resources/manifest.json' ), JSON.stringify( { version: 1, failures: [], resources } ) );
			return outputDir;
		};
		const exportOptions = ( outputDir: string, maxTotalBytes?: number ) => ( {
			outputDir, sourceUrl: SOURCE, platform: 'generic',
			summary: { routesDiscovered: 1, routesCaptured: 1, routesSkipped: 0, routesFailed: 0, routesOmitted: 0 },
			failures: [] as Array< { url: unknown; error: unknown } >,
			...( maxTotalBytes === undefined ? {} : { limits: { maxTotalBytes } } ),
		} );

		// A first unlimited export measures the naive artifact; its size minus the dropped renditions is exactly what the budgeted export must land on,
		// so every redundant rendition has to go while the rest stays.
		const baseline = fixture( 'liberation-rendition-naive-' );
		exportWebsiteCapture( exportOptions( baseline ) );
		const maxTotalBytes = measureWebsite( join( baseline, 'website' ) ).totalBytes - droppedBytes;

		const outputDir = fixture( 'liberation-rendition-budget-' );
		exportWebsiteCapture( exportOptions( outputDir, maxTotalBytes ) );

		const websiteDir = join( outputDir, 'website' );
		const html = readFileSync( join( websiteDir, 'index.html' ), 'utf8' );
		const exists = ( path: string ) => existsSync( join( websiteDir, path ) );

		// Within budget.
		const receipt = JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) ) as { exportBudget: { totalBytes: number; withinBudget: boolean; droppedAssets: number; droppedRenditions: number; droppedRoutes: number } };
		expect( receipt.exportBudget ).toMatchObject( { withinBudget: true, droppedAssets: 0, droppedRenditions: 6, droppedRoutes: 0 } );
		expect( receipt.exportBudget.totalBytes ).toBeLessThanOrEqual( maxTotalBytes );

		// One rendition per element's src, plus the widest candidate at or under 2048px; the unique asset stays.
		for ( const file of [ 'media/photo-320.webp', 'media/photo-1280.webp', 'media/other-640.webp', 'media/other-1280.webp', 'media/hero.png' ] )
			expect( exists( file ) ).toBe( true );
		for ( const file of [ 'photo-160', 'photo-640', 'photo-2560', 'other-160', 'other-320', 'other-2560' ] )
			expect( exists( `media/${ file }.webp` ) ).toBe( false );
		expect( html ).toContain( '/media/hero.png' );

		// Every remaining src and srcset candidate resolves to a written file; nothing was blanked with a placeholder.
		const $ = cheerio.load( html );
		const references: string[] = [];
		$( 'img' ).each( ( _, element ) => {
			const src = $( element ).attr( 'src' );
			if ( src ) references.push( src );
			const srcset = $( element ).attr( 'srcset' );
			if ( srcset ) references.push( ...srcset.split( ',' ).map( candidate => candidate.trim().split( /\s+/ )[ 0 ]! ) );
		} );
		expect( references.length ).toBeGreaterThan( 4 );
		for ( const reference of references )
			expect( exists( reference.replace( /^\//, '' ) ) ).toBe( true );
		expect( html ).not.toContain( TRANSPARENT_IMAGE_DATA_URL.slice( 0, 24 ) );

		// Each dropped rendition is diagnosed with a stable code.
		const diagnostics = JSON.parse( readFileSync( join( outputDir, 'diagnostics.json' ), 'utf8' ) ) as { discoveryDiagnostics: Array< { code: string; url: string; reason: string } > };
		const dropped = diagnostics.discoveryDiagnostics.filter( row => row.code === 'redundant_rendition_dropped' );
		expect( dropped.map( row => row.url ).sort() ).toEqual(
			[ 'photo-160', 'photo-640', 'photo-2560', 'other-160', 'other-320', 'other-2560' ].map( name => rendition( name ) ).sort()
		);
		for ( const row of dropped ) expect( row.reason ).toContain( 'redundant srcset rendition' );
		// The unique asset is not misreported as dropped.
		expect( dropped.some( row => row.url === unique ) ).toBe( false );
	} );
} );
