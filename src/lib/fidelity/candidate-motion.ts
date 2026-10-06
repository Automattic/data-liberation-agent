import type { Browser, Page } from 'playwright';
import { sourceContextOptions } from '../browser-kit/browser-kit.js';

/** Author-selected *observable* behaviors, independent of a source's scripts or a destination's blocks. */
export interface MotionContract {
	widths: number[];
	routes: Record< string, {
		/** `sourceSettleMs` waits a learned startup duration for a source that exposes no readiness marker. */
		ready: { source: string; candidate: string; sourceSettleMs?: number };
		text: string[];
		/** Compare visibly present/hidden elements during startup and after readiness. */
		visibility?: string[];
		/** Volatile clock digits are compared to each page's own observation time, not across a minute boundary. */
		clock?: { hour: string; minute: string; format: '12h' | '24h' };
		clicks: Array< { trigger: string; target: string } >;
		canvases: string[];
	} >;
}

export interface MotionEvidence {
	route: string;
	viewport: number;
	source: string;
	candidate: string;
	pass: boolean;
	failures: string[];
	/** The static HTML capture remains motion-incomplete even if the separately built candidate passes. */
	capture: 'unreproduced';
	observations: Record< string, unknown >;
}

type RouteContract = MotionContract[ 'routes' ][ string ];

function validateSelectors( selectors: string[] ): void {
	if ( selectors.some( ( selector ) => typeof selector !== 'string' || ! selector.trim() ) ) {
		throw new Error( 'Motion contract selectors must be nonempty strings' );
	}
}

export function validateMotionContract( contract: MotionContract ): void {
	if ( ! contract || ! Array.isArray( contract.widths ) || ! contract.widths.length ||
		contract.widths.some( ( width ) => ! Number.isInteger( width ) || width < 320 || width > 3840 ) ||
		! contract.routes || typeof contract.routes !== 'object' || Array.isArray( contract.routes ) ) {
		throw new Error( 'Motion contract requires viewport widths and route probes' );
	}
	for ( const [ route, probe ] of Object.entries( contract.routes ) ) {
		if ( ! route.startsWith( '/' ) || ! probe || ! probe.ready || ! Array.isArray( probe.text ) ||
			! Array.isArray( probe.clicks ) || ! Array.isArray( probe.canvases ) ||
			typeof probe.ready.source !== 'string' || typeof probe.ready.candidate !== 'string' ) {
			throw new Error( `Invalid motion contract route: ${ route }` );
		}
		validateSelectors( [ probe.ready.source, probe.ready.candidate, ...probe.text, ...probe.canvases ] );
		if ( probe.ready.sourceSettleMs !== undefined && ( ! Number.isInteger( probe.ready.sourceSettleMs ) || probe.ready.sourceSettleMs < 0 || probe.ready.sourceSettleMs > 25_000 ) ) {
			throw new Error( `Invalid readiness settle time: ${ route }` );
		}
		if ( probe.visibility ) {
			if ( ! Array.isArray( probe.visibility ) || probe.visibility.length > 16 ) throw new Error( `Invalid visibility probes: ${ route }` );
			validateSelectors( probe.visibility );
		}
		if ( probe.clock ) {
			validateSelectors( [ probe.clock.hour, probe.clock.minute ] );
			if ( ! probe.text.includes( probe.clock.hour ) || ! probe.text.includes( probe.clock.minute ) || ! [ '12h', '24h' ].includes( probe.clock.format ) ) {
				throw new Error( `Clock digits must be tracked text selectors with a declared format: ${ route }` );
			}
		}
		for ( const click of probe.clicks ) {
			if ( ! click || typeof click.trigger !== 'string' || typeof click.target !== 'string' ) throw new Error( `Invalid click probe: ${ route }` );
			validateSelectors( [ click.trigger, click.target ] );
		}
	}
}

async function visit( page: Page, url: string, ready: string, text: string[], visibility: string[], settleMs = 0 ): Promise< { values: Record< string, string >; changes: Record< string, string[] >; observedAt: number; initialVisibility: Record< string, boolean >; finalVisibility: Record< string, boolean > } > {
	await page.addInitScript( ( selectors ) => {
		const start = () => {
			const changes = Object.fromEntries( selectors.map( ( selector ) => [ selector, [] as string[] ] ) );
			const sample = () => {
				for ( const selector of selectors ) {
					const value = document.querySelector( selector )?.textContent?.trim() ?? '';
					const history = changes[ selector ];
					if ( history.length < 32 && history.at( -1 ) !== value ) history.push( value );
				}
			};
			const observer = new MutationObserver( sample );
			observer.observe( document.body, { childList: true, characterData: true, subtree: true } );
			sample();
			( window as typeof window & { __dlaMotion?: { changes: typeof changes; sample: typeof sample } } ).__dlaMotion = { changes, sample };
		};
		if ( document.readyState === 'loading' ) document.addEventListener( 'DOMContentLoaded', start, { once: true } );
		else start();
	}, text );
	await page.goto( url, { waitUntil: 'domcontentloaded', timeout: 30_000 } );
	await page.waitForTimeout( 200 );
	const initialVisibility = await page.evaluate( ( selectors ) => Object.fromEntries( selectors.map( ( selector ) => {
		const element = document.querySelector( selector );
		return [ selector, !! element && getComputedStyle( element ).display !== 'none' && getComputedStyle( element ).visibility !== 'hidden' ];
	} ) ), visibility );
	await page.waitForSelector( ready, { state: 'attached', timeout: 25_000 } );
	await page.waitForTimeout( 150 + settleMs );
	const result = await page.evaluate( ( selectors ) => {
		const trace = ( window as typeof window & { __dlaMotion?: { changes: Record< string, string[] >; sample: () => void } } ).__dlaMotion;
		trace?.sample();
		return {
			values: Object.fromEntries( selectors.map( ( selector ) => [ selector, document.querySelector( selector )?.textContent?.trim() ?? '' ] ) ),
			changes: trace?.changes ?? {},
			observedAt: Date.now(),
		};
	}, text );
	const finalVisibility = await page.evaluate( ( selectors ) => Object.fromEntries( selectors.map( ( selector ) => {
		const element = document.querySelector( selector );
		return [ selector, !! element && getComputedStyle( element ).display !== 'none' && getComputedStyle( element ).visibility !== 'hidden' ];
	} ) ), visibility );
	return { ...result, initialVisibility, finalVisibility };
}

function validClock( observation: { values: Record< string, string >; observedAt: number }, clock: NonNullable< RouteContract[ 'clock' ] > ): boolean {
	for ( const offset of [ -60_000, 0, 60_000 ] ) {
		const at = new Date( observation.observedAt + offset );
		const hour = clock.format === '12h' ? ( at.getHours() % 12 || 12 ) : at.getHours();
		if ( observation.values[ clock.hour ] === String( hour ).padStart( 2, '0' ) &&
			observation.values[ clock.minute ] === String( at.getMinutes() ).padStart( 2, '0' ) ) return true;
	}
	return false;
}

function firstVisiblePhase( changes: string[] ): string {
	return changes.find( ( value ) => value.length > 0 ) ?? '';
}

async function pointerProbe( page: Page, selector: string ): Promise< { idle: boolean; responds: boolean } > {
	const canvas = page.locator( selector ).first();
	if ( ! await canvas.count() ) return { idle: false, responds: false };
	const image = () => canvas.evaluate( ( element ) => ( element as HTMLCanvasElement ).toDataURL() );
	// A source may finish its DOM transition before its last canvas ripple fades.
	// Require a bounded quiet interval instead of sampling one fixed instant.
	// The initial wait also prevents an empty frame between sparse draws from
	// appearing idle when the drawing is still in progress.
	await page.waitForTimeout( 2500 );
	let previous = await image();
	let quiet = 0;
	for ( let attempt = 0; attempt < 24 && quiet < 3; attempt++ ) {
		await page.waitForTimeout( 250 );
		const current = await image();
		quiet = current === previous ? quiet + 1 : 0;
		previous = current;
	}
	const control = previous;
	const box = await canvas.boundingBox();
	if ( ! box ) return { idle: false, responds: false };
	await page.mouse.move( box.x + box.width * .25, box.y + box.height * .5 );
	await page.mouse.move( box.x + box.width * .6, box.y + box.height * .52 );
	await page.waitForTimeout( 150 );
	return { idle: quiet >= 3, responds: control !== await image() };
}

async function replay( page: Page, click: { trigger: string; target: string }, ready: string ): Promise< { changed: boolean; restored: boolean; firstPhase: string } > {
	const target = page.locator( click.target ).first();
	const before = ( await target.textContent() )?.trim();
	await page.evaluate( ( selector ) => {
		const trace = ( window as typeof window & { __dlaMotion?: { changes: Record< string, string[] >; sample: () => void } } ).__dlaMotion;
		if ( trace ) { trace.changes[ selector ] = []; trace.sample(); }
	}, click.target );
	await page.locator( click.trigger ).first().scrollIntoViewIfNeeded( { timeout: 3000 } ).catch( () => undefined );
	// A page may disable its controls while a previous sequence runs (for
	// example `pointer-events:none` during a loading state). Click only once the
	// trigger actually receives pointer input, as a visitor's click would.
	await page.waitForFunction( ( selector ) => {
		const trigger = document.querySelector( selector );
		const box = trigger?.getBoundingClientRect();
		if ( ! trigger || ! box || ! box.width || ! box.height ) return false;
		const hit = document.elementFromPoint( box.left + box.width / 2, box.top + box.height / 2 );
		return !! hit && ( hit === trigger || trigger.contains( hit ) );
	}, click.trigger, { timeout: 10_000 } ).catch( () => undefined );
	await page.locator( click.trigger ).first().click( { force: true, timeout: 5000 } );
	const changed = await page.waitForFunction(
		( { selector, previous } ) => document.querySelector( selector )?.textContent?.trim() !== previous,
		{ selector: click.target, previous: before }, { timeout: 3000 }
	).then( () => true, () => false );
	const restored = changed && await page.waitForFunction(
		( { selector, previous } ) => document.querySelector( selector )?.textContent?.trim() === previous,
		{ selector: click.target, previous: before }, { timeout: 8000 }
	).then( () => true, () => false );
	// A replay target may finish before the rest of the document (e.g. the date
	// still typing after the clock digits settle). Wait for the authored readiness
	// contract before sending another click into an intentionally disabled UI.
	if ( restored ) {
		await page.waitForSelector( ready, { state: 'attached', timeout: 10_000 } );
		await page.waitForFunction( () => document.body.getAttribute( 'aria-busy' ) !== 'true', null, { timeout: 10_000 } );
	}
	const firstPhase = await page.evaluate( ( selector ) => {
		const trace = ( window as typeof window & { __dlaMotion?: { changes: Record< string, string[] > } } ).__dlaMotion;
		return ( trace?.changes[ selector ] ?? [] ).slice( 1 ).find( ( value ) => value.length > 0 ) ?? '';
	}, click.target );
	return { changed, restored, firstPhase };
}

/** Never evaluates retained source JavaScript on a WordPress origin. Each page runs only its own authored runtime. */
export async function verifyCandidateMotion(
	browser: Browser,
	route: string,
	viewport: number,
	source: string,
	candidate: string,
	contract: RouteContract,
	signals: string[]
): Promise< MotionEvidence > {
	const failures: string[] = [];
	const observations: Record< string, unknown > = {};
	const evidence: MotionEvidence = { route, viewport, source, candidate, capture: 'unreproduced', pass: false, failures, observations };
	const sourcePage = await browser.newPage( { ...await sourceContextOptions( browser, source ), viewport: { width: viewport, height: 900 } } );
	const candidatePage = await browser.newPage( { viewport: { width: viewport, height: 900 } } );
	try {
		const [ original, copy ] = await Promise.all( [
			visit( sourcePage, source, contract.ready.source, contract.text, contract.visibility ?? [], contract.ready.sourceSettleMs ),
			visit( candidatePage, candidate, contract.ready.candidate, contract.text, contract.visibility ?? [] ),
		] );
		observations.text = { source: original, candidate: copy };
		for ( const selector of contract.visibility ?? [] ) {
			if ( original.initialVisibility[ selector ] !== copy.initialVisibility[ selector ] ) failures.push( `startup visibility differs: ${ selector }` );
			if ( original.finalVisibility[ selector ] !== copy.finalVisibility[ selector ] ) failures.push( `settled visibility differs: ${ selector }` );
		}
		if ( contract.clock ) {
			if ( ! validClock( original, contract.clock ) ) failures.push( 'source clock is not visitor-local time' );
			if ( ! validClock( copy, contract.clock ) ) failures.push( 'candidate clock is not visitor-local time' );
		}
		if ( signals.includes( 'timed-dom-update' ) && ! contract.text.length ) failures.push( 'timed DOM update has no text probe' );
		if ( signals.includes( 'timed-dom-update' ) && contract.text.length && ! contract.text.some( ( selector ) => ( original.changes[ selector ]?.length ?? 0 ) > 1 ) ) {
			failures.push( 'source timed DOM update is not measurable' );
		}
		for ( const selector of contract.text ) {
			const volatile = contract.clock && [ contract.clock.hour, contract.clock.minute ].includes( selector );
			if ( ! original.values[ selector ] || ( ! volatile && original.values[ selector ] !== copy.values[ selector ] ) ) failures.push( `settled text differs: ${ selector }` );
			if ( ( original.changes[ selector ]?.length ?? 0 ) > 1 && ( copy.changes[ selector ]?.length ?? 0 ) < 2 ) failures.push( `startup text does not transition: ${ selector }` );
			if ( firstVisiblePhase( original.changes[ selector ] ?? [] ) !== firstVisiblePhase( copy.changes[ selector ] ?? [] ) ) {
				failures.push( `startup text phase differs: ${ selector }` );
			}
		}
		const needsCanvas = signals.some( ( signal ) => [ 'canvas-2d', 'pointer-input', 'animation-frame' ].includes( signal ) );
		if ( needsCanvas && ! contract.canvases.length ) failures.push( 'canvas/pointer motion has no drawing surface probe' );
		for ( const selector of contract.canvases ) {
			const [ a, b ] = await Promise.all( [ pointerProbe( sourcePage, selector ), pointerProbe( candidatePage, selector ) ] );
			observations[ `canvas ${ selector }` ] = { source: a, candidate: b };
			if ( ! a.idle || ! a.responds ) failures.push( `source pointer effect is not measurable: ${ selector }` );
			if ( ! b.idle || ! b.responds ) failures.push( `candidate pointer effect missing: ${ selector }` );
		}
		if ( signals.includes( 'click-input' ) && ! contract.clicks.length ) failures.push( 'click motion has no replay probe' );
		for ( const click of contract.clicks ) {
			const [ a, b ] = await Promise.all( [ replay( sourcePage, click, contract.ready.source ), replay( candidatePage, click, contract.ready.candidate ) ] );
			observations[ `click ${ click.trigger } → ${ click.target }` ] = { source: a, candidate: b };
			if ( ! a.changed || ! a.restored ) failures.push( `source click replay is not measurable: ${ click.trigger }` );
			if ( ! b.changed || ! b.restored ) failures.push( `candidate click replay missing: ${ click.trigger }` );
			if ( a.changed && b.changed && a.firstPhase !== b.firstPhase ) failures.push( `click replay text phase differs: ${ click.trigger }` );
		}
		const known = new Set( [ 'canvas-2d', 'pointer-input', 'animation-frame', 'timed-dom-update', 'click-input' ] );
		for ( const signal of signals ) if ( ! known.has( signal ) ) failures.push( `unverified source signal: ${ signal }` );
	} catch ( error ) {
		failures.push( `behavior probe could not finish: ${ error instanceof Error ? error.message : String( error ) }` );
	} finally {
		await Promise.all( [ sourcePage.close(), candidatePage.close() ] );
	}
	evidence.pass = failures.length === 0;
	return evidence;
}
