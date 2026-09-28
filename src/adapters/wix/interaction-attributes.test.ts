// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { restoreInteractionAttributes, snapshotInteractionAttributes } from './capture.js';

describe( 'Wix interaction attribute restoration', () => {
	it( 'returns menu items to their resting state after the capture clicked them', () => {
		document.body.innerHTML =
			'<ul><li id="a" data-part="menu-item" data-animation-name="none"></li><li id="b" data-part="menu-item" data-animation-name="wash" data-animation-state="enterDone"></li></ul>';
		snapshotInteractionAttributes();
		const a = document.getElementById( 'a' )!;
		const b = document.getElementById( 'b' )!;
		// What observing an anchor leaves behind.
		a.setAttribute( 'data-animation-name', 'calm' );
		a.setAttribute( 'data-animation-state', 'exitDone' );
		b.setAttribute( 'data-animation-state', 'exitDone' );
		b.setAttribute( 'data-open', 'true' );
		restoreInteractionAttributes();
		expect( a.getAttribute( 'data-animation-name' ) ).toBe( 'none' );
		expect( a.hasAttribute( 'data-animation-state' ) ).toBe( false );
		expect( b.getAttribute( 'data-animation-state' ) ).toBe( 'enterDone' );
		expect( b.hasAttribute( 'data-open' ) ).toBe( false );
	} );

	it( 'is a no-op without a snapshot', () => {
		document.body.innerHTML = '<li data-part="menu-item" data-animation-name="calm"></li>';
		restoreInteractionAttributes();
		expect( document.querySelector( 'li' )!.getAttribute( 'data-animation-name' ) ).toBe( 'calm' );
	} );
} );
