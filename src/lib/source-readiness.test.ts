import { describe, expect, it } from 'vitest';
import { isMediaPlaybackLifecycleAbort } from './source-readiness.js';

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
