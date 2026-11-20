import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findAdapter } from '../../adapters/index.js';
import { launchChromium } from '../browser-kit/browser-kit.js';
import { installProbeIntrinsics } from '../browser-kit/probe-intrinsics.js';
import { installSourceDocumentLoader } from '../source-navigation.js';
import { recordSourceMotion } from '../screenshot/motion-hold.js';
import { createReferenceCollector, readReferenceArtifact, type ReferenceHandoff } from './reference.js';
import { IntegrityError } from '../failure-class.js';
import { runWithTrustedOrigins } from '../media-fetch/safe-fetch.js';

/** Resume only capture-declared cells; never rediscover routes or choose a new moment. */
export async function runReferenceStage( directory: string, dependencies: { findAdapter?: typeof findAdapter } = {} ): Promise<{ status: 'pending' | 'complete'; path: string }> {
	directory = resolve( directory );
	const state = JSON.parse( readFileSync( join( directory, 'reference-stage.json' ), 'utf8' ) ) as ReferenceHandoff;
	return runWithTrustedOrigins( state.trustedOrigins, () => runStage( directory, state, dependencies ) );
}

async function runStage( directory: string, state: ReferenceHandoff, dependencies: { findAdapter?: typeof findAdapter } ): Promise<{ status: 'pending' | 'complete'; path: string }> {
	const statePath = join( directory, 'reference-stage.json' );
	if ( state.schema !== 'blocks-engine-capture/reference-stage/v1' || ! state.receipt ) throw new IntegrityError( 'Invalid reference stage handoff' );
	readReferenceArtifact( directory, state.receipt );
	if ( state.status === 'complete' ) return { status: 'complete', path: join( directory, 'fidelity-reference.json' ) };
	const adapter = state.adapterId ? ( dependencies.findAdapter ?? findAdapter )( state.adapterId ) : undefined;
	if ( state.adapterId && ! adapter ) throw new IntegrityError( `Reference adapter unavailable: ${ state.adapterId }` );
	const hooks = adapter?.liberation;
	const collector = createReferenceCollector( directory, state.sourceUrl, state.sourceUrls, {
		...state.options, handoff: state, adapterId: state.adapterId, trustedOrigins: state.trustedOrigins,
		telemetryRequest: hooks?.telemetryRequest?.bind( hooks ), prepareCapture: hooks?.prepare,
		initializePage: async page => {
			if ( hooks?.loadDocument ) installSourceDocumentLoader( page, async ( url, timeout ) => {
				const document = await hooks.loadDocument!( page, url, timeout );
				return document && { url, status: 200, headers: document.headers, body: Buffer.from( document.html ) };
			} );
			await hooks?.initScript?.( page );
		},
	} );
	const browser = await launchChromium();
	try {
		for ( const job of state.jobs ) {
			// Aliased or withdrawn after capture observed it: no declared cell remains.
			if ( ! state.cells.some( cell => cell.sourceUrl === job.url && cell.profile === job.device ) ) continue;
			const context = await browser.newContext();
			try {
				await installProbeIntrinsics( context );
				const page = await context.newPage();
				if ( job.motion ) recordSourceMotion( page, job.motion );
				await collector.observe( page, job.url, job.device, job.errors, job.browserProfile, job.profile, job.boundary );
				collector.checkpoint();
			} finally { await context.close(); }
		}
		const ready = state.cells.every( cell => state.entries.some( entry => entry.sourceUrl === cell.sourceUrl && entry.profile === cell.profile && entry.viewport === cell.viewport && entry.readiness.ready ) );
		const receiptPath = join( directory, state.receipt.path );
		const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) );
		receipt.reference = { status: ready ? 'complete' : 'pending' };
		writeFileSync( receiptPath, `${ JSON.stringify( receipt, null, 2 ) }\n` );
		const path = collector.finalize( receiptPath );
		const completed = JSON.parse( readFileSync( statePath, 'utf8' ) ) as ReferenceHandoff;
		completed.status = ready ? 'complete' : 'pending';
		completed.receipt = { path: state.receipt.path, sha256: ( await import( './reference.js' ) ).digest( readFileSync( receiptPath ) ) };
		writeFileSync( `${ statePath }.tmp`, `${ JSON.stringify( completed, null, 2 ) }\n` );
		renameSync( `${ statePath }.tmp`, statePath );
		return { status: completed.status, path };
	} finally { await browser.close(); }
}
