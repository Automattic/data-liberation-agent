import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceContextOptions } from './browser-kit/browser-kit.js';
import { captureSourceBehavior } from './screenshot/behavior-capture.js';
import { modelSourceBehavior, timeDependentTargets } from './behavior-model.js';
import { learnMotion, type LearnedMotion } from './learned-motion.js';
import { promoteLearnedMotion, type LearnedPromotion } from './learned-motion-promotion.js';

const FIRST_TIME = { at: '2031-02-03T04:17:00Z', timezone: 'UTC' };
const SECOND_TIME = { at: '2032-08-14T19:43:00Z', timezone: 'Europe/Berlin' };

/**
 * Learn diagnosed behavior from the source itself (bounded site-wide browser
 * budget), then promote it only if the staged portable site reproduces it.
 */
export async function discoverCapturedBehavior( directory: string ): Promise< void > {
	const path = join( directory, 'source-interactivity.json' );
	if ( ! existsSync( path ) ) return;
	const source = JSON.parse( readFileSync( path, 'utf8' ) ) as { pages?: Array< { url: string; status: string } > };
	const pages = ( source.pages ?? [] ).filter( ( page ) => page.status === 'unreproduced' );
	if ( ! pages.length ) return;
	const { chromium } = await import( 'playwright' );
	const browser = await chromium.launch();
	const observations: Array< Record< string, unknown > > = [];
	const learned: Array< { url: string; learned: LearnedMotion } > = [];
	const failures: Array< { url: string; error: string } > = [];
	let promotion: LearnedPromotion | null = null;
	try {
		for ( const { url } of pages.slice( 0, 4 ) ) {
			const open = async ( timezoneId: string ) => browser.newPage( { ...await sourceContextOptions( browser, url ), timezoneId, viewport: { width: 1440, height: 900 } } );
			const page = await open( FIRST_TIME.timezone );
			const counterfactualPage = await open( SECOND_TIME.timezone );
			try {
				const evidence = await captureSourceBehavior( page, url, { fixedTime: FIRST_TIME.at } );
				// A second controlled date and timezone separates time-derived text from editorial text.
				const counterfactual = await captureSourceBehavior( counterfactualPage, url, { fixedTime: SECOND_TIME.at, maxClicks: 0 } );
				const motion = learnMotion( evidence, counterfactual );
				learned.push( { url, learned: motion } );
				observations.push( {
					url, evidence, counterfactual, learned: motion,
					model: { ...modelSourceBehavior( evidence ), dynamicTime: timeDependentTargets( evidence, counterfactual ), timeProbe: { first: FIRST_TIME, second: SECOND_TIME } },
				} );
			} catch ( error ) {
				failures.push( { url, error: error instanceof Error ? error.message : String( error ) } );
			} finally {
				await Promise.all( [ page.close(), counterfactualPage.close() ] );
			}
		}
		if ( learned.length ) promotion = await promoteLearnedMotion( directory, learned, browser );
	} finally { await browser.close(); }
	const residual = learned.some( ( row ) => row.learned.unsupported.length );
	writeFileSync( join( directory, 'source-behavior.json' ), JSON.stringify( {
		schema: 'data-liberation/source-behavior-report/v1', observed: observations.length,
		total: pages.length, omitted: Math.max( 0, pages.length - 4 ), observations, failures,
		promotion: promotion && { promoted: promotion.promoted, failures: promotion.failures, evidence: promotion.evidence },
		status: promotion?.promoted ? ( residual ? 'partially_translated' : 'translated' ) : 'observed_untranslated',
	}, null, 2 ) );
}
