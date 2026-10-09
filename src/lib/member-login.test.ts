import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { WIX_MEMBER_LOGIN, wixMemberPaths } from '../adapters/wix/capture.js';
import { markMemberLoginControls, MEMBER_LOGIN_ATTRIBUTE, MEMBER_LOGIN_CLASS_PREFIX } from './member-login.js';

const MARK = `${ MEMBER_LOGIN_CLASS_PREFIX }wix`;

it( 'marks Wix sign-in controls for the destination login without changing the elements', () => {
	const dom = new JSDOM( `<!doctype html><body>
		<div class="wixui-login-social-bar"><button class="O4eQsz" data-testid="handle-button" type="button" aria-haspopup="dialog"><svg></svg><span>Sign In</span></button></div>
		<a id="hero-sign-in" href="/account/my-account"><span>Sign In</span></a>
		<a id="contact" href="/contact">Contact us</a>
		<a id="elsewhere" href="https://elsewhere.example/account/my-account">Another site's account</a>
	</body>`, { url: 'https://owner.example/' } );
	const priorDocument = Object.getOwnPropertyDescriptor( globalThis, 'document' );
	const priorLocation = Object.getOwnPropertyDescriptor( globalThis, 'location' );
	Object.defineProperty( globalThis, 'document', { configurable: true, value: dom.window.document } );
	Object.defineProperty( globalThis, 'location', { configurable: true, value: dom.window.location } );
	try {
		const marked = markMemberLoginControls( { ...WIX_MEMBER_LOGIN, memberPaths: wixMemberPaths( 'https://owner.example/' ), attribute: MEMBER_LOGIN_ATTRIBUTE, classPrefix: MEMBER_LOGIN_CLASS_PREFIX } );
		const header = dom.window.document.querySelector( '.wixui-login-social-bar [data-testid="handle-button"]' )!;
		expect( marked ).toBe( 2 );
		expect( header.tagName ).toBe( 'BUTTON' );
		expect( header.classList.contains( MARK ) ).toBe( true );
		expect( header.classList.contains( 'O4eQsz' ) ).toBe( true );
		expect( header.getAttribute( MEMBER_LOGIN_ATTRIBUTE ) ).toBe( 'wix' );
		expect( header.getAttribute( 'type' ) ).toBe( 'button' );
		expect( header.textContent ).toContain( 'Sign In' );
		expect( header.querySelector( 'svg' ) ).not.toBeNull();
		const hero = dom.window.document.querySelector( '#hero-sign-in' )!;
		expect( hero.classList.contains( MARK ) ).toBe( true );
		expect( hero.getAttribute( MEMBER_LOGIN_ATTRIBUTE ) ).toBe( 'wix' );
		expect( hero.getAttribute( 'href' ) ).toContain( '/account/my-account' );
		expect( dom.window.document.querySelector( '#contact' )!.classList.contains( MARK ) ).toBe( false );
		expect( dom.window.document.querySelector( '#elsewhere' )!.classList.contains( MARK ) ).toBe( false );
		expect( dom.window.document.querySelectorAll( `.${ MARK }` ) ).toHaveLength( 2 );
	} finally {
		if ( priorDocument ) Object.defineProperty( globalThis, 'document', priorDocument );
		else delete ( globalThis as { document?: Document } ).document;
		if ( priorLocation ) Object.defineProperty( globalThis, 'location', priorLocation );
		else delete ( globalThis as { location?: Location } ).location;
		dom.window.close();
	}
} );
