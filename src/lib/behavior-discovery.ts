import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceContextOptions } from './browser-kit/browser-kit.js';
import { captureSourceBehavior } from './screenshot/behavior-capture.js';
import { modelSourceBehavior, timeDependentTargets } from './behavior-model.js';
import { compileTextBehavior } from './text-behavior-runtime.js';
import { compileClockBehavior, learnClockBindings } from './clock-behavior.js';

/** Discover diagnosed behavior using the source itself, with a bounded site-wide browser budget. */
export async function discoverCapturedBehavior( directory: string ): Promise< void > {
	const path = join( directory, 'source-interactivity.json' );
	if ( ! existsSync( path ) ) return;
	const source = JSON.parse( readFileSync( path, 'utf8' ) ) as { pages?: Array< { url: string; status: string } > };
	const pages = ( source.pages ?? [] ).filter( ( page ) => page.status === 'unreproduced' );
	if ( ! pages.length ) return;
	const { chromium } = await import( 'playwright' );
	const browser = await chromium.launch();
	const observations: unknown[] = [];
	const failures: Array< { url: string; error: string } > = [];
	try {
		for ( const source of pages.slice( 0, 4 ) ) {
			const page = await browser.newPage( { ...await sourceContextOptions( browser, source.url ), timezoneId: 'UTC', viewport: { width: 1440, height: 900 } } );
			try {
				const evidence = await captureSourceBehavior( page, source.url, { fixedTime: '2031-02-03T04:17:00Z' } );
				const counterfactualPage = await browser.newPage( { ...await sourceContextOptions( browser, source.url ), timezoneId: 'Europe/Berlin', viewport: { width: 1440, height: 900 } } );
				try {
					const counterfactual = await captureSourceBehavior( counterfactualPage, source.url, { fixedTime: '2032-08-14T19:43:00Z', maxClicks: 0 } );
					const dynamicTime = timeDependentTargets( evidence, counterfactual );
					const clock = learnClockBindings( evidence, counterfactual );
					const model = modelSourceBehavior( evidence );
					// These targets need clock/date semantics, not frozen snapshot replay.
					model.startup = model.startup.filter( ( reveal ) => ! dynamicTime.includes( reveal.selector ) );
					model.replays = model.replays.map( ( replay ) => ( { ...replay, textReveals: replay.textReveals.filter( ( reveal ) => ! dynamicTime.includes( reveal.selector ) ) } ) );
					const textRuntime = compileTextBehavior( evidence, dynamicTime );
					const runtimePath = `behavior/text-reveal-${ observations.length + 1 }.js`;
					mkdirSync( join( directory, 'behavior' ), { recursive: true } );
					// Keep compiled candidates outside website/ until full source behavior
					// (including unsupported clocks/canvas) passes the fidelity gate.
					writeFileSync( join( directory, runtimePath ), textRuntime.script );
					const clockPath = `behavior/clock-${ observations.length + 1 }.js`;
					writeFileSync( join( directory, clockPath ), compileClockBehavior( clock.bindings ) );
					observations.push( { evidence, counterfactual, clockRuntime: { ...clock, path: clockPath, promoted: false }, textRuntime: { program: textRuntime.program, path: runtimePath, promoted: false }, model: { ...model, dynamicTime, timeProbe: { first: '2031-02-03T04:17:00Z', firstTimezone: 'UTC', second: '2032-08-14T19:43:00Z', secondTimezone: 'Europe/Berlin' } } } );
				} finally { await counterfactualPage.close(); }
			} catch ( error ) {
				failures.push( { url: source.url, error: error instanceof Error ? error.message : String( error ) } );
			} finally { await page.close(); }
		}
	} finally { await browser.close(); }
	writeFileSync( join( directory, 'source-behavior.json' ), JSON.stringify( {
		schema: 'data-liberation/source-behavior-report/v1', observed: observations.length,
		total: pages.length, omitted: Math.max( 0, pages.length - 4 ), observations, failures, status: 'observed_untranslated',
	}, null, 2 ) );
}
