import type { CDPSession, Frame, Page } from 'playwright';

/** Ignore only Chromium's unhandled media play/pause or reload lifecycle rejection. */
export function isMediaPlaybackLifecycleAbort( error: { name?: string; message?: string } ): boolean {
	return error.name === 'AbortError' && /The play\(\) request was interrupted by (?:a call to pause\(\)|a new load request)/i.test( error.message ?? '' );
}

export const SOURCE_SUBFRAME_RUNTIME_ERROR = 'source_subframe_runtime_error';

function frameOrigin( url: string ): string {
	try {
		const origin = new URL( url ).origin;
		return origin === 'null' ? url : origin;
	} catch { return url; }
}

/**
 * Runtime exceptions carry an execution context even when a classic cross-origin
 * script's in-page error event is muted. Each OOPIF needs its own Runtime session;
 * same-process frames are already covered by the main session.
 */
export async function watchSourceRuntimeErrors( page: Page, limit = 100 ) {
	const errors: { main: boolean; origin: string; message: string }[] = [];
	const sessions = new Set< CDPSession >();
	const attaching = new Set< Frame >();
	let disposed = false;
	const attach = async ( frame: Frame ) => {
		if ( disposed || attaching.has( frame ) ) return;
		attaching.add( frame );
		let session: CDPSession | undefined;
		try {
			session = await page.context().newCDPSession( frame );
			if ( disposed ) { await session.detach(); return; }
			sessions.add( session );
			session.on( 'close', () => { sessions.delete( session! ); attaching.delete( frame ); } );
			const { frameTree } = await session.send( 'Page.getFrameTree' );
			const rootId = frameTree.frame.id;
			const contexts = new Map< number, { frameId: string; origin: string } >();
			session.on( 'Runtime.executionContextCreated', ( { context } ) => {
				if ( context.auxData?.frameId ) contexts.set( context.id, { frameId: String( context.auxData.frameId ), origin: context.origin } );
			} );
			session.on( 'Runtime.executionContextDestroyed', ( { executionContextId } ) => { contexts.delete( executionContextId ); } );
			session.on( 'Runtime.executionContextsCleared', () => contexts.clear() );
			session.on( 'Runtime.exceptionThrown', ( { exceptionDetails: details } ) => {
				if ( disposed || errors.length >= limit ) return;
				const context = contexts.get( details.executionContextId ?? -1 );
				const exception = details.exception;
				const properties = exception?.preview?.properties;
				const name = properties?.find( property => property.name === 'name' )?.value ?? exception?.className;
				const description = exception?.description ?? exception?.value?.toString() ?? details.text;
				// Drop the Error name and stack, as Playwright's pageerror.message does.
				const message = description.replace( /\n\s+at [\s\S]*$/, '' ).replace( /^(?:Uncaught (?:\(in promise\) )?)?(?:\w*Error: )?/, '' );
				if ( isMediaPlaybackLifecycleAbort( { name, message } ) ) return;
				const main = ! context || ( frame === page.mainFrame() && context.frameId === rootId );
				errors.push( { main, origin: context?.origin || frameOrigin( frame.url() ), message } );
			} );
			await session.send( 'Runtime.enable' );
		} catch {
			// Same-process child frames have no separate CDP target. The page's
			// Runtime session covers them; detached frames need no more observation.
			if ( session ) { sessions.delete( session ); await session.detach().catch( () => {} ); }
			attaching.delete( frame );
		}
	};
	const onFrame = ( frame: Frame ) => { void attach( frame ); };
	page.on( 'frameattached', onFrame );
	page.on( 'framenavigated', onFrame );
	await attach( page.mainFrame() );
	await Promise.all( page.frames().filter( frame => frame !== page.mainFrame() ).map( attach ) );
	return {
		settle(): { reasons: string[]; diagnostics: string[] } {
			return {
				reasons: [ ...new Set( errors.filter( error => error.main ).map( error => `source runtime error: ${ error.message }` ) ) ],
				diagnostics: [ ...new Set( errors.filter( error => ! error.main ).map( error => `subframe runtime error (${ error.origin }): ${ error.message }` ) ) ],
			};
		},
		dispose: () => {
			disposed = true;
			page.off( 'frameattached', onFrame );
			page.off( 'framenavigated', onFrame );
			for ( const session of sessions ) void session.detach().catch( () => {} );
		},
	};
}
