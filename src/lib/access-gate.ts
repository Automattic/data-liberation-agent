import type { Page } from 'playwright';

/**
 * Routes whose content the provider withholds behind its own login (a Wix
 * members-only page). A visitor-side capture can never see that content, and
 * the gate itself is a provider login form that cannot work anywhere else.
 * Capturing the gate ships a dead login form; skipping the route breaks every
 * menu link to it. So the route is captured as a placeholder: the site's own
 * public shell (header, navigation, footer) with its main content replaced by
 * a note telling the owner what happened and what to do, under the page's
 * menu name. Everything downstream (screenshots, geometry, HTML) then
 * describes that one consistent document.
 *
 * The gate is recognized by the source cleanup policy (`CleanupRule.accessGate`),
 * so its identity stays adapter-owned and versioned with the other removals.
 */

export interface AccessGateEvidence {
	/** The cleanup rule whose removal identified the gate. */
	rule: string;
	provider: string;
	/** Public route whose shell carries the placeholder; absent when the site root itself is gated. */
	shell?: string;
	/** Menu name the placeholder was given. */
	label?: string;
}

export function accessGateNote( provider: string ): string {
	return `This page was members-only on your ${ provider } site, so its content couldn’t be copied. Add the content here, or protect this page with a password.`;
}

/**
 * Load the site's public root in place of a gated route, so the placeholder is
 * built inside the owner's real chrome. Returns the shell URL, or undefined
 * when the gated route is the root itself or the root cannot be loaded; the
 * placeholder then goes into the gated document as it is.
 */
export async function openAccessGateShell( page: Page, route: string ): Promise< string | undefined > {
	const shell = new URL( '/', route ).href;
	if ( shell === new URL( route ).href ) return undefined;
	const response = await page.goto( shell, { waitUntil: 'load', timeout: 30_000 } ).catch( () => null );
	return response && response.status() < 400 ? shell : undefined;
}

/** Serialized into the page. Replaces the main content with the placeholder and restores the route's identity. */
export function installAccessGatePlaceholder( args: { route: string; gateTitle: string; note: string; provider: string } ): { label: string; title: string } {
	// tsx instruments nested functions with __name(); the built bundle does not.
	const globalWithName = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
	if ( typeof globalWithName.__name === 'undefined' ) globalWithName.__name = ( fn ) => fn;

	const route = new URL( args.route );
	const normalize = ( pathname: string ) => pathname.replace( /\/+$/, '' ) || '/';
	// The menu names the page; the gate's own title is the site-wide one.
	let label = '';
	for ( const link of document.querySelectorAll< HTMLAnchorElement >( 'a[href]' ) ) {
		let target: URL;
		try {
			target = new URL( link.href, location.href );
		} catch {
			continue;
		}
		if ( target.origin !== route.origin || normalize( target.pathname ) !== normalize( route.pathname ) ) continue;
		const text = ( link.textContent ?? '' ).replace( /\s+/g, ' ' ).trim();
		if ( text && text.length <= 80 ) {
			label = text;
			break;
		}
	}
	if ( ! label ) {
		const segment = decodeURIComponent( normalize( route.pathname ).split( '/' ).pop() ?? '' );
		label = segment.replace( /[-_]+/g, ' ' ).replace( /\b\w/g, ( letter ) => letter.toUpperCase() ).trim() || args.gateTitle;
	}
	const title = args.gateTitle && args.gateTitle !== label ? `${ label } | ${ args.gateTitle }` : label;

	const main = document.querySelector( 'main' ) ?? document.body;
	// Speak in the site's own type rather than the browser default.
	const headingFont = ( () => {
		const sample = main.querySelector( 'h1,h2,h3' );
		return sample ? getComputedStyle( sample ).fontFamily : '';
	} )();
	const bodyFont = ( () => {
		const sample = main.querySelector( 'p' );
		return sample ? getComputedStyle( sample ).fontFamily : '';
	} )();
	const section = document.createElement( 'section' );
	section.setAttribute( 'data-dla-access-gate', args.provider.toLowerCase() );
	section.style.cssText = 'max-width:720px;margin:64px auto;padding:0 24px;box-sizing:border-box';
	const heading = document.createElement( 'h1' );
	heading.textContent = label;
	if ( headingFont ) heading.style.fontFamily = headingFont;
	const note = document.createElement( 'p' );
	note.textContent = args.note;
	if ( bodyFont ) note.style.fontFamily = bodyFont;
	section.append( heading, note );
	main.replaceChildren( section );

	document.title = title;
	document.querySelector( 'link[rel="canonical"]' )?.setAttribute( 'href', route.href );
	document.querySelector( 'meta[property="og:url"]' )?.setAttribute( 'content', route.href );
	document.querySelector( 'meta[property="og:title"]' )?.setAttribute( 'content', title );
	if ( location.href !== route.href ) history.replaceState( history.state, '', route.href );
	return { label, title };
}
