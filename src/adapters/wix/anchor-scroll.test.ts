import { afterEach, expect, it, vi } from 'vitest';
import { waitForWixAnchorScroll } from './capture.js';

afterEach( () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
} );

it.each( [ 1500, 750 ] )( 'ends a stable no-movement wait at %ims rather than the full scroll bound', async ( noMoveMs ) => {
	vi.useFakeTimers( { toFake: [ 'setTimeout', 'performance' ] } );
	vi.stubGlobal( 'scrollY', 0 );
	vi.stubGlobal( 'document', { documentElement: { scrollHeight: 2400 } } );
	const settled = vi.fn();
	const result = waitForWixAnchorScroll( { initialScroll: 0, maxWait: 3000, noMoveMs } ).then( settled );
	await vi.advanceTimersByTimeAsync( noMoveMs - 1 );
	expect( settled ).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync( 1 );
	await result;
	expect( settled ).toHaveBeenCalledWith( false );
} );

it( 'keeps the full bound when document height changes without movement', async () => {
	vi.useFakeTimers( { toFake: [ 'setTimeout', 'performance' ] } );
	vi.stubGlobal( 'scrollY', 0 );
	const root = { scrollHeight: 2400 };
	vi.stubGlobal( 'document', { documentElement: root } );
	const settled = vi.fn();
	const result = waitForWixAnchorScroll( { initialScroll: 0, maxWait: 3000, noMoveMs: 1500 } ).then( settled );
	await vi.advanceTimersByTimeAsync( 500 );
	root.scrollHeight = 3000;
	await vi.advanceTimersByTimeAsync( 2499 );
	expect( settled ).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync( 1 );
	await result;
	expect( settled ).toHaveBeenCalledWith( false );
} );

it( 'keeps observing a delayed landing until its position is stable', async () => {
	vi.useFakeTimers( { toFake: [ 'setTimeout', 'performance' ] } );
	vi.stubGlobal( 'scrollY', 0 );
	vi.stubGlobal( 'document', { documentElement: { scrollHeight: 2400 } } );
	const settled = vi.fn();
	const result = waitForWixAnchorScroll( { initialScroll: 0, maxWait: 3000, noMoveMs: 1500 } ).then( settled );
	await vi.advanceTimersByTimeAsync( 1000 );
	vi.stubGlobal( 'scrollY', 1000 );
	await vi.advanceTimersByTimeAsync( 200 );
	expect( settled ).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync( 50 );
	await result;
	expect( settled ).toHaveBeenCalledWith( true );
} );
