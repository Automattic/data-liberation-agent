import type { Page } from 'playwright';

/** Ignore only Chromium's unhandled media play/pause or reload lifecycle rejection. */
export function isMediaPlaybackLifecycleAbort( error: { name?: string; message?: string } ): boolean {
	return error.name === 'AbortError' && /The play\(\) request was interrupted by (?:a call to pause\(\)|a new load request)/i.test( error.message ?? '' );
}

export const SOURCE_SUBFRAME_RUNTIME_ERROR = 'source_subframe_runtime_error';

interface FrameErrorReport { main: boolean; origin: string; message: string }

const BINDING = '__dlaSourceFrameError';
// Every frame forwards its own uncaught errors and rejections, so the binding
// names the reporting frame. A string keeps the script free of transpiler helpers.
const FORWARD_FRAME_ERRORS = `(() => {
	const report = globalThis[${ JSON.stringify( BINDING ) }];
	if ( typeof report !== 'function' ) return;
	const text = value => value && typeof value === 'object' && typeof value.message === 'string' ? value.message : String( value );
	addEventListener( 'error', event => { report( text( event.error ) ); } );
	addEventListener( 'unhandledrejection', event => { report( text( event.reason ) ); } );
})();`;
const frameReports = new WeakMap< Page, Promise< FrameErrorReport[] > >();

function frameOrigin( url: string ): string {
	try {
		const origin = new URL( url ).origin;
		return origin === 'null' ? url : origin;
	} catch { return url; }
}

/** Installs frame attribution once per page; a page that cannot take it leaves every error unattributed. */
function reportFrameErrors( page: Page ): Promise< FrameErrorReport[] > {
	let reports = frameReports.get( page );
	if ( ! reports ) {
		const list: FrameErrorReport[] = [];
		reports = Promise.resolve()
			.then( async () => {
				await page.exposeBinding( BINDING, ( { frame }, message: unknown ) => {
					if ( list.length < 1_000 ) list.push( { main: frame === page.mainFrame(), origin: frameOrigin( frame.url() ), message: String( message ) } );
				} );
				await page.addInitScript( FORWARD_FRAME_ERRORS );
			} )
			.catch( () => {} )
			.then( () => list );
		frameReports.set( page, reports );
	}
	return reports;
}

/**
 * Collects the source document's uncaught errors and rejections. Playwright's
 * `pageerror` fires for every frame without naming it, so each error is matched
 * to the frame that reported it: only errors a subframe reported become
 * diagnostics; main-frame and unattributable errors block readiness.
 */
export async function watchSourceRuntimeErrors( page: Page, limit = 100 ) {
	const reports = await reportFrameErrors( page );
	const start = reports.length;
	const errors: string[] = [];
	const onError = ( error: Error ) => { if ( errors.length < limit && ! isMediaPlaybackLifecycleAbort( error ) ) errors.push( error.message ); };
	page.on( 'pageerror', onError );
	return {
		settle(): { reasons: string[]; diagnostics: string[] } {
			const subframe = reports.slice( start ).filter( report => ! report.main );
			const reasons: string[] = [];
			const diagnostics: string[] = [];
			for ( const message of errors ) {
				const index = subframe.findIndex( report => report.message === message );
				if ( index < 0 ) reasons.push( `source runtime error: ${ message }` );
				else diagnostics.push( `subframe runtime error (${ subframe.splice( index, 1 )[ 0 ]!.origin }): ${ message }` );
			}
			return { reasons: [ ...new Set( reasons ) ], diagnostics: [ ...new Set( diagnostics ) ] };
		},
		dispose: () => { page.off( 'pageerror', onError ); },
	};
}
