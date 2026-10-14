import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Page } from 'playwright';

const observationSettleMs: number[] = [];
const observationTexts: string[] = [];

vi.doMock( './check.js', async ( importOriginal ) => {
	const actual = await importOriginal< Record< string, unknown > >();
	return {
		...actual,
		observePage: async (
			page: Page,
			url: string,
			viewport: number,
			settleMs: number,
		) => {
			observationSettleMs.push( settleMs );
			observationTexts.push( await page.evaluate( () => document.body.innerText ) );
			return {
				viewport,
				textChars: observationTexts.at( -1 )!.length,
				widestImage: null,
				images: [],
				typography: [],
				animations: [],
				responsiveAnimations: [],
				dialogs: [],
				internalRoutes: [],
			};
		},
	};
} );

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'reference observation settle budget', () => {
	beforeAll( async () => { browser = await chromium.launch(); } );
	afterAll( async () => { await browser?.close(); }, 30_000 );

	it( 'never settles the source observation less than the frozen comparison of the candidate does', async () => {
		const { createReferenceCollector } = await import( './reference.js' );
		const directory = join( process.cwd(), '.tmp-test', 'reference-settle-threading' );
		mkdirSync( directory, { recursive: true } );
		const page = await browser.newPage();
		try {
			const collector = createReferenceCollector( directory, 'https://example.com/', [ 'https://example.com/' ] );
			await collector.observe( page, 'https://example.com/', 'desktop', [], { isMobile: false, hasTouch: false } );
			// The capture defaults to DEFAULT_CAPTURE_SETTLE_MS (screenshotter.ts),
			// and the candidate side of a frozen comparison measures with at
			// least 800 settled ms (check.ts). Reference evidence must not be
			// less settled than either; the pre-fix collection froze every
			// reference observation at settle budget 0.
			expect( observationSettleMs.length ).toBeGreaterThan( 0 );
			expect( Math.min( ...observationSettleMs ) ).toBeGreaterThanOrEqual( 800 );
			// Callers keep the ability to tighten the budget explicitly.
			observationSettleMs.length = 0;
			const bounded = createReferenceCollector( directory, 'https://example.com/', [ 'https://example.com/' ], { settleMs: 0 } );
			await bounded.observe( page, 'https://example.com/', 'desktop', [], { isMobile: false, hasTouch: false } );
			// Desktop profile observes a 768 and a 1440 cell per route.
			expect( observationSettleMs ).toEqual( [ 0, 0 ] );
		} finally {
			await page.close();
		}
	}, 90_000 );
} );

let browser: Awaited< ReturnType< typeof chromium.launch > >;
