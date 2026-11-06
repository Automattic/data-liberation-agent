import { describe, expect, it } from 'vitest';
import { isMediaPlaybackLifecycleAbort, watchSourceRuntimeErrors } from './source-readiness.js';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';

describe( 'watchSourceRuntimeErrors', () => {
	it( 'keeps unattributed errors blocking without suppressing or duplicating them', async () => {
		const page = Object.assign( new EventEmitter(), {
			exposeBinding: async () => {}, addInitScript: async () => {},
		} );
		const watcher = await watchSourceRuntimeErrors( page as unknown as Page );
		page.emit( 'pageerror', new Error( 'Neutral runtime fault' ) );
		page.emit( 'pageerror', new Error( 'Neutral runtime fault' ) );
		expect( watcher.settle() ).toEqual( { reasons: [ 'source runtime error: Neutral runtime fault' ], diagnostics: [] } );
		watcher.dispose();
		expect( page.listenerCount( 'pageerror' ) ).toBe( 0 );
	} );
} );

describe( 'isMediaPlaybackLifecycleAbort', () => {
	it( 'recognizes only media play lifecycle AbortErrors', () => {
		for ( const message of [
			'The play() request was interrupted by a call to pause().',
			'The play() request was interrupted by a new load request.',
		] ) expect( isMediaPlaybackLifecycleAbort( { name: 'AbortError', message } ) ).toBe( true );
		expect( isMediaPlaybackLifecycleAbort( { name: 'AbortError', message: 'other abort' } ) ).toBe( false );
		expect( isMediaPlaybackLifecycleAbort( { name: 'Error', message: 'The play() request was interrupted by a call to pause().' } ) ).toBe( false );
	} );
} );
