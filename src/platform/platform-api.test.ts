// src/platform/platform-api.test.ts
//
// End-to-end proof of the PUBLIC Platform API contract: a consumer-defined
// platform — built entirely outside core, registered through the package
// entry (src/index.ts, the module `data-liberation` maps to for installed
// consumers) — registers, auto-detects via its own signals, discovers routes,
// and flows through liberation with its platform hooks intact.
// No core file is modified by the "consumer" here; it only uses the public
// exports.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { captureScreenshotsMock } = vi.hoisted( () => ( {
	captureScreenshotsMock: vi.fn( async ( { urls }: { urls: string[] } ) => ( {
		urls,
		captured: 2,
		skipped: 0,
		failed: 0,
		durationMs: 7,
	} ) ),
} ) );

vi.mock( '../lib/screenshot/screenshotter.js', () => ( {
	captureScreenshots: captureScreenshotsMock,
} ) );

vi.mock( '../lib/capture-export.js', () => ( {
	exportWebsiteCapture: vi.fn( ( { outputDir, sourceUrl }: { outputDir: string; sourceUrl: string } ) => {
		// Model the exporter boundary with real files: reference finalization
		// binds the declared receipt and portable tree, even with a mocked browser.
		mkdirSync( join( outputDir, 'website', 'pricing' ), { recursive: true } );
		writeFileSync( join( outputDir, 'website', 'index.html' ), '<h1>Acme Builder site</h1>' );
		writeFileSync( join( outputDir, 'website', 'pricing', 'index.html' ), '<h1>Pricing</h1>' );
		const path = join( outputDir, 'capture-receipt.json' );
		writeFileSync( path, JSON.stringify( {
			schema: 'data-liberation/capture-receipt/v1',
			source: { url: sourceUrl },
			websiteRoot: 'website',
			routes: [
				{ url: sourceUrl, path: 'website/index.html' },
				{ url: new URL( 'pricing', sourceUrl ).href, path: 'website/pricing/index.html' },
			],
		} ) );
		return path;
	} ),
} ) );

// The consumer import: everything below enters through the public entry.
import {
	DuplicatePlatformError,
	detectPlatform,
	detectFromHttp,
	registerPlatform,
	registeredPlatforms,
	resolvePlatform,
} from '../index.js';
import { captureWebsite } from '../lib/capture.js';

const id = 'acme-builder-e2e';
const root = join( process.cwd(), '.tmp-test', 'platform-api' );
const sourceUrl = 'https://blog.acme-builder.example/';

// The consumer platform — detection signals in all four tiers + discover +
// liberation hooks, exactly as docs/platform-api.md documents them.
const acmePlatform = {
	id,
	detection: {
		urlPatterns: [ /acme-builder\.example/i ],
		httpSignals: [
			{ header: 'x-generator', value: 'ACME', signal: 'X-Generator: acme header' },
		],
		sourceSignals: [
			{ pattern: /cdn\.acme-static\.example/i, signal: 'acme CDN in page source' },
		],
		pathProbes: [
			{
				path: '/_acme/health',
				expectedStatus: [ 204 ],
				signal: '/_acme/health probe',
			},
		],
	},
	discover: vi.fn( async ( url: string ) => ( {
		siteMeta: { title: 'Acme Builder site' },
		urls: [
			{ url, type: 'homepage' },
			{ url: new URL( 'pricing', url ).href, type: 'page' },
		],
		diagnostics: [],
	} ) ),
	liberation: {
		removeSelectors: [ '.acme-cookie-banner', '#acme-teaser' ],
	},
};

describe( 'consumer-defined platform (public Platform API)', () => {
	// The registry is module state shared across this file's tests, so the
	// consumer platform registers exactly once; later tests reuse it.
	const ensureRegistered = () => {
		try {
			registerPlatform( acmePlatform );
		} catch ( err ) {
			if ( ! ( err instanceof DuplicatePlatformError ) ) throw err;
		}
	};

	afterEach( () => {
		rmSync( root, { recursive: true, force: true } );
		vi.unstubAllGlobals();
	} );

	it( 'registers through the public entry alongside the built-ins', () => {
		ensureRegistered();
		expect( registeredPlatforms().map( ( p ) => p.id ) ).toContain( id );
		// The built-ins registered through the same seam are still present.
		expect( registeredPlatforms().map( ( p ) => p.id ) ).toContain( 'wix' );
	} );

	it( 'fails deterministically when colliding with a built-in id', () => {
		expect( () => registerPlatform( { id: 'wix', discover: async () => ( {} ) } ) ).toThrow(
			DuplicatePlatformError,
		);
	} );

	it( 'auto-detects from its own URL-pattern signals', async () => {
		ensureRegistered();
		const result = await detectPlatform( sourceUrl );
		expect( result.platform ).toBe( id );
		expect( result.confidence ).toBe( 'high' );
		expect( result.signals ).toContain( `URL contains ${ id } domain` );
	} );

	it( 'auto-detects from its own HTTP-header signals (custom domain)', async () => {
		ensureRegistered();
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue( {
				ok: true,
				headers: new Map( [ [ 'x-generator', 'Acme Builder 3.1' ] ] ),
				text: () => Promise.resolve( '<html><body>Custom domain site</body></html>' ),
			} ),
		);
		const result = await detectFromHttp( 'https://www.custom-domain-business.com' );
		expect( result.platform ).toBe( id );
		expect( result.confidence ).toBe( 'high' );
		expect( result.signals ).toContain( 'X-Generator: acme header' );
	} );

	it( 'auto-detects from its own page-source signals', async () => {
		ensureRegistered();
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue( {
				ok: true,
				headers: new Map(),
				text: () =>
					Promise.resolve( '<html><script src="https://cdn.acme-static.example/app.js"></script></html>' ),
			} ),
		);
		const result = await detectFromHttp( 'https://www.custom-domain-business.com' );
		expect( result.platform ).toBe( id );
		expect( result.confidence ).toBe( 'medium' );
		expect( result.signals ).toContain( 'acme CDN in page source' );
	} );

	it( 'auto-detects from its own path-probe signals', async () => {
		ensureRegistered();
		vi.stubGlobal(
			'fetch',
			vi.fn()
				.mockResolvedValueOnce( {
					// Homepage: no header/source evidence anywhere.
					ok: true,
					headers: new Map(),
					text: () => Promise.resolve( '<html><body>Themed beyond recognition</body></html>' ),
				} )
				// Probe HEADs: only ours answers (built-in probes run first and miss).
				.mockImplementation( async ( u: string ) => ( {
					status: String( u ).endsWith( '/_acme/health' ) ? 204 : 404,
					headers: new Map(),
				} ) ),
		);
		const result = await detectFromHttp( 'https://www.custom-domain-business.com' );
		expect( result.platform ).toBe( id );
		expect( result.confidence ).toBe( 'high' );
		expect( result.signals ).toContain( '/_acme/health probe' );
	} );

	it( 'resolves through the registry and flows through liberation', async () => {
		ensureRegistered();
		expect( resolvePlatform( id ) ).toBe( acmePlatform );

		mkdirSync( root, { recursive: true } );
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue( {
				ok: true,
				status: 200,
				headers: new Map( [ [ 'x-generator', 'Acme Builder 3.1' ] ] ),
				text: () => Promise.resolve( '<html><body>Custom domain site</body></html>' ),
				arrayBuffer: () => Promise.resolve( new ArrayBuffer( 0 ) ),
			} ),
		);

		// The current internal orchestration entry — no core edit, no adapter
		// shim: detection selects the custom platform and uses its public
		// discover/liberation members.
		const result = await captureWebsite( { url: sourceUrl, outputDir: root } );

		expect( acmePlatform.discover ).toHaveBeenCalledWith(
			sourceUrl,
			expect.objectContaining( { outputDir: root } ),
		);
		expect( result.provenance.platform ).toBe( id );
		expect( result.summary.routesDiscovered ).toBe( 2 ); // homepage + /pricing
		const reference = JSON.parse( readFileSync( join( root, 'fidelity-reference.json' ), 'utf8' ) );
		expect( reference.sourceUrl ).toBe( sourceUrl );
		expect( reference.scope.sourceUrls ).toEqual( [ sourceUrl, new URL( 'pricing', sourceUrl ).href ] );
		expect( reference.capture.map( ( artifact: { path: string } ) => artifact.path ).sort() ).toEqual( [
			'website/index.html', 'website/pricing/index.html', 'website/site-preview.png',
		] );
		// The browser mock contributes no source observations; files alone do
		// not fabricate frozen evidence for the consumer platform.
		expect( reference.entries ).toEqual( [] );
		// The platform's liberation hooks reached the internal browser orchestrator.
		expect( captureScreenshotsMock ).toHaveBeenCalledWith(
			expect.objectContaining( {
				removeSelectors: acmePlatform.liberation.removeSelectors,
				primaryUrl: sourceUrl,
			} ),
		);
	} );
} );
