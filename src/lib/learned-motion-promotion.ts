import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import * as cheerio from 'cheerio';
import type { Browser } from 'playwright';
import { verifyCandidateMotion, type MotionContract, type MotionEvidence } from './fidelity/candidate-motion.js';
import { checkSelfConsistency } from './fidelity/self-consistency.js';
import type { LearnedMotion } from './learned-motion.js';
import { MOTION_RUNTIME } from './motion-runtime.js';
import { PORTABLE_MOTION_SCHEMA, type PortableMotionReceipt } from './portable-motion.js';
import { startStaticServer } from './replicate/local-site/static-server.js';

export interface LearnedPromotion {
	promoted: boolean;
	failures: string[];
	evidence: MotionEvidence[];
}

const VERIFIED_WIDTHS = [ 390, 768, 1440 ];
const CANVAS_SIGNALS = [ 'canvas-2d', 'pointer-input', 'animation-frame' ];
const escape = ( value: string ) => value.replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' ).replace( /</g, '&lt;' );

/** Observable probes for exactly the learned behavior, derived rather than authored. */
export function learnedMotionContract( learned: LearnedMotion ): MotionContract[ 'routes' ][ string ] {
	const clock = learned.clock;
	const clicks = new Map< string, string >();
	for ( const step of learned.steps ) if ( step.clickSelector && ! clicks.has( step.clickSelector ) ) clicks.set( step.clickSelector, step.selector );
	if ( clock?.triggerSelector && ! clicks.has( clock.triggerSelector ) ) clicks.set( clock.triggerSelector, clock.hourSelector );
	return {
		// The portable runtime marks completion; the source is given its learned settle time.
		ready: {
			source: 'body',
			candidate: [ learned.steps.length ? ':has([data-blocks-engine-motion-ready])' : '', clock ? ':has([data-blocks-engine-clock-ready])' : '' ].reduce( ( selector, part ) => selector + part, 'html' ),
			sourceSettleMs: learned.settleMs,
		},
		text: [
			...learned.steps.map( ( step ) => step.selector ),
			...( clock ? [ clock.hourSelector, clock.minuteSelector, clock.timezoneSelector, clock.ampmSelector, clock.dateSelector ].filter( ( value ): value is string => !! value ) : [] ),
		],
		visibility: learned.steps.flatMap( ( step ) => ( step.revealSelectors ?? [] ).map( ( reveal ) => reveal.selector ) ),
		...( clock ? { clock: { hour: clock.hourSelector, minute: clock.minuteSelector, format: clock.hourCycle === '24' ? '24h' as const : '12h' as const } } : {} ),
		clicks: [ ...clicks ].map( ( [ trigger, target ] ) => ( { trigger, target } ) ),
		canvases: [],
	};
}

/**
 * Put learned motion on the portable site only after the staged copy
 * reproduces it against the live source at 390/768/1440px. Behavior the
 * vocabulary cannot express is recorded on the receipt and keeps failing
 * plain comparison; it is never substituted.
 */
export async function promoteLearnedMotion( directory: string, routes: Array< { url: string; learned: LearnedMotion } >, browser: Browser ): Promise< LearnedPromotion > {
	const root = resolve( directory );
	const failures: string[] = [];
	const evidence: MotionEvidence[] = [];
	if ( existsSync( join( root, 'portable-motion.json' ) ) ) return { promoted: false, failures: [ 'capture already has a portable motion receipt' ], evidence };
	const capture = JSON.parse( readFileSync( join( root, 'capture-receipt.json' ), 'utf8' ) );
	const websiteDir = resolve( root, capture.websiteRoot ?? 'website' );
	if ( ! websiteDir.startsWith( root + sep ) || ! existsSync( websiteDir ) ) return { promoted: false, failures: [ 'capture website root is missing' ], evidence };
	const interactivity = JSON.parse( readFileSync( join( root, 'source-interactivity.json' ), 'utf8' ) ) as { pages?: Array< { url: string; signals: string[] } > };
	const bytes = Buffer.from( MOTION_RUNTIME );
	const digest = createHash( 'sha256' ).update( bytes ).digest( 'hex' );
	const scriptPath = `motion/${ digest.slice( 0, 12 ) }-learned-motion.js`;
	const stage = mkdtempSync( join( tmpdir(), 'dla-learned-motion-' ) );
	let server: Awaited< ReturnType< typeof startStaticServer > > | null = null;
	try {
		cpSync( websiteDir, stage, { recursive: true, force: true } );
		const receipt: PortableMotionReceipt = { schema: PORTABLE_MOTION_SCHEMA, origin: 'learned', contract: { widths: VERIFIED_WIDTHS, routes: {} }, routes: {}, unsupported: {} };
		const plans: Array< { route: string; url: string; signals: string[] } > = [];
		for ( const { url, learned } of routes ) {
			if ( ! learned.steps.length && ! learned.clock ) continue;
			const route = new URL( url ).pathname;
			const entry = route === new URL( capture.source?.url ?? url ).pathname ? { path: 'index.html' } : ( capture.routes ?? [] ).find( ( row: { url?: string } ) => row.url === url );
			const pagePath = entry?.path ? join( stage, String( entry.path ).replace( /^website\//, '' ) ) : '';
			if ( ! pagePath || ! resolve( pagePath ).startsWith( stage + sep ) || ! existsSync( pagePath ) ) {
				failures.push( `${ route }: captured page not found` );
				continue;
			}
			const $ = cheerio.load( readFileSync( pagePath, 'utf8' ) );
			const contract = learnedMotionContract( learned );
			const selectors = [ ...contract.text, ...( contract.visibility ?? [] ), ...contract.clicks.map( ( click ) => click.trigger ) ];
			const missing = selectors.filter( ( selector ) => $( selector ).length !== 1 );
			if ( missing.length ) {
				failures.push( `${ route }: learned targets are not unique in the capture: ${ missing.join( ', ' ) }` );
				continue;
			}
			if ( learned.steps.length ) $( 'body' ).append( `<span hidden data-blocks-engine-motion-steps="${ escape( JSON.stringify( learned.steps ) ) }"></span>` );
			if ( learned.clock ) $( 'body' ).append( `<span hidden data-blocks-engine-live-clock="${ escape( JSON.stringify( learned.clock ) ) }"></span>` );
			// Declares itself the static interpreter of the markers; importers that
			// lower the markers to blocks use those blocks' view scripts instead.
			$( 'body' ).append( `<script defer src="/${ scriptPath }" data-blocks-engine-marker-runtime="motion"></script>` );
			writeFileSync( pagePath, $.html() );
			receipt.contract.routes[ route ] = contract;
			receipt.routes[ route ] = { scripts: [ { path: scriptPath, sha256: digest } ] };
			if ( learned.unsupported.length ) receipt.unsupported![ route ] = learned.unsupported;
			const canvasResidual = learned.unsupported.some( ( row ) => row.reason.startsWith( 'canvas drawing algorithm' ) );
			const signals = ( interactivity.pages ?? [] ).find( ( page ) => page.url === url )?.signals ?? [];
			// The learned subset is verified here; canvas residuals stay failing on the receipt.
			plans.push( { route, url, signals: signals.filter( ( signal ) => ! canvasResidual || ! CANVAS_SIGNALS.includes( signal ) ) } );
		}
		if ( ! plans.length ) return { promoted: false, failures: failures.length ? failures : [ 'no learned motion to promote' ], evidence };
		mkdirSync( join( stage, 'motion' ), { recursive: true } );
		writeFileSync( join( stage, scriptPath ), bytes );
		const offline = checkSelfConsistency( stage, new Map( [ [ '/', 'index.html' ] ] ) );
		if ( ! offline.pass ) return { promoted: false, failures: [ ...failures, ...offline.findings.map( ( finding ) => finding.detail ) ], evidence };
		server = await startStaticServer( stage );
		for ( const plan of plans ) {
			for ( const width of VERIFIED_WIDTHS ) {
				evidence.push( await verifyCandidateMotion( browser, plan.route, width, plan.url, `${ server.url }${ plan.route }`, receipt.contract.routes[ plan.route ], plan.signals ) );
			}
		}
		for ( const row of evidence.filter( ( item ) => ! item.pass ) ) failures.push( `${ row.route } @ ${ row.viewport }px: ${ row.failures.join( '; ' ) }` );
		if ( failures.length ) return { promoted: false, failures, evidence };
		cpSync( stage, websiteDir, { recursive: true, force: true } );
		writeFileSync( join( root, 'portable-motion.json' ), JSON.stringify( receipt, null, 2 ) );
		return { promoted: true, failures, evidence };
	} finally {
		await server?.close();
		rmSync( stage, { recursive: true, force: true } );
	}
}
