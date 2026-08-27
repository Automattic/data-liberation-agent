// src/lib/fidelity/check.ts
//
// Compare a liberated copy against its live source at viewports the capture
// sweep never sampled. Measuring only at the capture width would certify the
// freeze we already shipped once.
//
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { startStaticServer } from '../replicate/local-site/static-server.js';
import { DEFAULT_SWEEP_WIDTHS } from '../screenshot/fluid-capture.js';
import { writePixelEvidence } from './evidence.js';
import { scoreReport, scoreViewport, type LayoutObservation, type ViewportScore } from './score.js';

/**
 * Widths the learning sweep does not visit. 1600 and 1728 sit above the
 * capture width and are what exposed the freeze. 900 is omitted on purpose:
 * per-device sources switch documents by CSS at the detected floor, while a
 * desktop-UA load of the live source does not, so that width compares two
 * different designs.
 */
export const DEFAULT_CHECK_WIDTHS = [ 1600, 1728 ];

export type ObservePair = (
	sourceUrl: string,
	localUrl: string,
	viewport: number
) => Promise< {
	source: LayoutObservation;
	liberated: LayoutObservation;
	sourcePng?: Buffer;
	liberatedPng?: Buffer;
} >;

export interface FidelityCheckOptions {
	directory: string;
	widths?: number[];
	/** Pathnames to check, e.g. `/` and `/about/`. Default: homepage only. */
	routes?: string[];
	settleMs?: number;
	/** Write source/liberated/diff PNGs. Never used as pass/fail. */
	screenshots?: boolean;
	log?: ( ( message: string ) => void ) | undefined;
	observe?: ObservePair;
}

export interface FidelityReport {
	sourceUrl: string;
	websiteDir: string;
	widths: number[];
	routes: string[];
	scores: ViewportScore[];
	pass: boolean;
	failed: number;
	passed: number;
}

interface CaptureReceipt {
	source?: { url?: string };
}

export function resolveCheckDirectory( directory: string ): {
	websiteDir: string;
	receiptPath: string;
} {
	const absolute = resolve( directory );
	if ( ! existsSync( absolute ) || ! statSync( absolute ).isDirectory() ) {
		throw new Error( `Not a directory: ${ absolute }` );
	}
	const nestedReceipt = join( absolute, 'capture-receipt.json' );
	const nestedWebsite = join( absolute, 'website' );
	if ( existsSync( nestedReceipt ) && existsSync( nestedWebsite ) ) {
		return { websiteDir: nestedWebsite, receiptPath: nestedReceipt };
	}
	const parentReceipt = join( absolute, '..', 'capture-receipt.json' );
	if ( existsSync( parentReceipt ) ) {
		return { websiteDir: absolute, receiptPath: parentReceipt };
	}
	throw new Error(
		`No capture-receipt.json next to ${ absolute }. Point check at a liberated run directory.`
	);
}

export function checkWidthsFor( sampled: number[] = DEFAULT_SWEEP_WIDTHS ): number[] {
	return DEFAULT_CHECK_WIDTHS.filter( ( width ) => ! sampled.includes( width ) );
}

async function observePage(
	page: Page,
	url: string,
	viewport: number,
	settleMs: number,
	localOrigin: string | null
): Promise< LayoutObservation > {
	const external = new Set< string >();
	const onRequest = ( request: { url: () => string } ): void => {
		if ( ! localOrigin ) return;
		const href = request.url();
		if ( href.startsWith( 'data:' ) || href.startsWith( 'blob:' ) || href.startsWith( localOrigin ) ) return;
		try {
			external.add( new URL( href ).host );
		} catch {
			/* ignore unparseable */
		}
	};
	page.on( 'request', onRequest );
	try {
		await page.goto( url, { waitUntil: 'domcontentloaded', timeout: 60_000 } ).catch( () => {} );
		await page.waitForTimeout( settleMs );
		const measured = await page.evaluate( () => {
			const images = [ ...document.querySelectorAll( 'img' ) ]
				.map( ( image ) => image.getBoundingClientRect() )
				.filter( ( rect ) => rect.width > 50 && rect.height > 50 );
			return {
				title: document.title,
				textChars: ( document.body?.innerText ?? '' ).replace( /\s+/g, ' ' ).trim().length,
				widestImage: images.length
					? Math.round( Math.max( ...images.map( ( rect ) => rect.width ) ) )
					: null,
				docWidth: document.documentElement.scrollWidth,
				overflow: document.documentElement.scrollWidth > window.innerWidth,
			};
		} );
		return { viewport, ...measured, externalHosts: [ ...external ].sort() };
	} finally {
		page.off( 'request', onRequest );
	}
}

export async function checkFidelity( options: FidelityCheckOptions ): Promise< FidelityReport > {
	const log = options.log ?? ( () => {} );
	const { websiteDir, receiptPath } = resolveCheckDirectory( options.directory );
	const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) ) as CaptureReceipt;
	const sourceUrl = receipt.source?.url;
	if ( ! sourceUrl ) throw new Error( `capture-receipt.json has no source.url: ${ receiptPath }` );

	const widths = options.widths ?? checkWidthsFor();
	const routes = options.routes ?? [ '/' ];
	const settleMs = options.settleMs ?? 4000;

	let observe = options.observe;
	const server = observe ? null : await startStaticServer( websiteDir );
	const browser = observe ? null : await chromium.launch();
	const page = browser ? await browser.newPage() : null;
	if ( ! observe ) {
		observe = async ( sourceHref, localHref, viewport ) => {
			if ( ! page ) throw new Error( 'browser page missing' );
			await page.setViewportSize( { width: viewport, height: 900 } );
			const source = await observePage( page, sourceHref, viewport, settleMs, null );
			const sourcePng = options.screenshots ? await page.screenshot() : undefined;
			const liberated = await observePage(
				page,
				localHref,
				viewport,
				settleMs,
				new URL( localHref ).origin
			);
			const liberatedPng = options.screenshots ? await page.screenshot() : undefined;
			return { source, liberated, sourcePng, liberatedPng };
		};
	}

	const scores: ViewportScore[] = [];
	try {
		for ( const route of routes ) {
			const sourceHref = new URL( route, sourceUrl ).href;
			const localHref = `${ server?.url ?? 'http://liberated.invalid' }${
				route.startsWith( '/' ) ? route : `/${ route }`
			}`;
			for ( const width of widths ) {
				log( `[compare] ${ route } @ ${ width }px` );
				const pair = await observe( sourceHref, localHref, width );
				const score = scoreViewport( pair.source, pair.liberated );
				if ( pair.sourcePng && pair.liberatedPng ) {
					const evidenceDir = join( dirname( receiptPath ), 'compare', String( width ) );
					const evidence = writePixelEvidence( evidenceDir, pair.sourcePng, pair.liberatedPng );
					if ( 'score' in evidence ) {
						score.notes.push(
							`pixel ${ evidence.score.toFixed( 4 ) } (evidence, not a gate) → ${ evidence.diffPath }`
						);
					} else {
						score.notes.push( evidence.error );
					}
				}
				scores.push( score );
			}
		}
	} finally {
		await browser?.close();
		await server?.close();
	}

	const summary = scoreReport( scores );
	return { sourceUrl, websiteDir, widths, routes, scores, ...summary };
}
