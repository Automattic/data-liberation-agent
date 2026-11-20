import type { Page } from 'playwright';
import type { CleanupPolicy } from './source-cleanup.js';

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
/**
 * A provider can also open its login over a public page (a members pop-up
 * shown on load). Only a page the gate left without any content root is gated.
 */
export async function routeKeptContent( page: Page ): Promise< boolean > {
	return page.evaluate( () => Boolean( document.querySelector( 'main,[role="main"]' ) ) );
}

/**
 * Bound on waiting for a content-less route to show either its content or its
 * gate. Generic readiness (network and DOM quiet) knows nothing about a gate:
 * Wix serves a members-only route with an empty `#site-root` that is quiet
 * well before its runtime mounts the blocking layer (1.2–1.6 s after `load` on
 * qure.rocks/portfolio, at desktop and phone widths). Reading the gate on that
 * quiet page sees nothing; the cleanup observer then strips the gate when it
 * arrives, and the route ships empty, with neither note nor site chrome.
 */
export const ACCESS_GATE_SETTLE_MS = 10_000;

export type AccessGateSettle = 'gate' | 'content' | 'timeout' | 'no-gate-rules';

/**
 * Wait until the route has either fired an access-gate cleanup rule or shows a
 * content root, whichever comes first, within `timeoutMs`. Each poll runs the
 * installed cleanup sweep, so a gate inserted after the mutation observer's
 * round budget is still removed and recorded here.
 */
export async function awaitAccessGateOrContent( page: Page, policy: CleanupPolicy, timeoutMs: number = ACCESS_GATE_SETTLE_MS ): Promise< AccessGateSettle > {
	const rules = policy.rules.filter( ( rule ) => rule.accessGate ).map( ( rule ) => rule.id );
	if ( ! rules.length ) return 'no-gate-rules';
	return page.evaluate( ( { rules, timeoutMs } ) => new Promise< 'gate' | 'content' | 'timeout' >( ( resolve ) => {
		const started = performance.now();
		const check = () => {
			const state = ( window as unknown as { __dlaCleanup?: { report: { records: Array< { rule: string } > }; sweep: () => void } } ).__dlaCleanup;
			state?.sweep();
			if ( state?.report.records.some( ( record ) => rules.includes( record.rule ) ) ) return resolve( 'gate' );
			if ( document.querySelector( 'main,[role="main"]' ) ) return resolve( 'content' );
			if ( performance.now() - started >= timeoutMs ) return resolve( 'timeout' );
			setTimeout( check, 100 );
		};
		check();
	} ), { rules, timeoutMs } );
}

export async function openAccessGateShell( page: Page, route: string ): Promise< string | undefined > {
	const shell = new URL( '/', route ).href;
	if ( shell === new URL( route ).href ) return undefined;
	const response = await page.goto( shell, { waitUntil: 'load', timeout: 30_000 } ).catch( () => null );
	return response && response.status() < 400 ? shell : undefined;
}

/**
 * The placeholder replaces the shell's content root and keeps everything
 * around it (header, navigation, footer). A builder runtime can mount that root
 * after `load`; placing the note before it exists would have nowhere to go but
 * the whole body, taking the site chrome with it. Wait for it, within a bound.
 */
export async function awaitShellContentRoot( page: Page, timeoutMs: number = ACCESS_GATE_SETTLE_MS ): Promise< boolean > {
	return page.waitForFunction( () => Boolean( document.querySelector( 'main,[role="main"]' ) ), undefined, { timeout: timeoutMs, polling: 100 } )
		.then( () => true, () => false );
}

/** Serialized into the page. Replaces the main content with the placeholder and restores the route's identity. */
export function installAccessGatePlaceholder( args: { route: string; gateTitle: string; note: string; provider: string } ): { label: string; title: string } {
	// tsx instruments nested functions with __name(); the built bundle does not.
	const globalWithName = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
	if ( typeof globalWithName.__name === 'undefined' ) globalWithName.__name = ( fn ) => fn;

	const route = new URL( args.route );
	const normalize = ( pathname: string ) => pathname.replace( /\/+$/, '' ) || '/';
	// The menu names the page; the gate's own title is the site-wide one. Only
	// navigation links count: a same-path link elsewhere (a footer, a card) is
	// not the page's name. Every navigation link to the route (desktop and
	// mobile menus) is marked current, as the source marks an ordinary route.
	const navigation = 'nav a[href],[role="navigation"] a[href],header a[href]';
	const namesRoute = ( link: HTMLAnchorElement ) => {
		try {
			const target = new URL( link.href, location.href );
			return target.origin === route.origin && normalize( target.pathname ) === normalize( route.pathname );
		} catch {
			return false;
		}
	};
	const routeLinks = [ ...document.querySelectorAll< HTMLAnchorElement >( navigation ) ].filter( namesRoute );
	let label = '';
	for ( const link of routeLinks ) {
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
	// The shell marks its own route current, and not only with aria-current: a
	// builder also flags the item's link or wrappers with a state class
	// (`menu__item--selected`, `is-active`) or attribute (`data-selected`) that
	// its stylesheet paints. Left on the shell's item, the placeholder claims the
	// root page is being served, so that item is captured (and later rebuilt)
	// in the shell's current presentation on a route it does not name. Every
	// navigation item that does not name the route is put at rest: its link and
	// the wrappers it alone fills (up to the first ancestor holding another
	// navigation link) lose their current-state markers.
	const currentToken = /(?:^|[^a-z0-9])(?:current|active|selected)(?:[^a-z0-9]|$)/i;
	const stateAttributes = [ 'aria-current', 'data-selected', 'data-active', 'data-current' ];
	const restingItems = () => {
		// Read afresh: the shell's runtime can re-render its menus.
		const navigationLinks = [ ...document.querySelectorAll< HTMLAnchorElement >( navigation ) ];
		const marked: Element[] = [];
		for ( const link of navigationLinks ) {
			if ( namesRoute( link ) ) continue;
			for ( let element: Element | null = link; element && element !== document.body; element = element.parentElement ) {
				if ( element !== link && navigationLinks.some( ( other ) => other !== link && element!.contains( other ) ) ) break;
				if ( [ ...element.classList ].some( ( name ) => currentToken.test( name ) ) || stateAttributes.some( ( name ) => element!.hasAttribute( name ) && 'false' !== element!.getAttribute( name ) ) ) marked.push( element );
			}
		}
		return marked;
	};
	const rest = () => {
		const marked = restingItems();
		for ( const element of marked ) {
			for ( const name of [ ...element.classList ] ) if ( currentToken.test( name ) ) element.classList.remove( name );
			for ( const name of stateAttributes ) if ( element.hasAttribute( name ) && 'false' !== element.getAttribute( name ) ) element.removeAttribute( name );
		}
		return marked.length;
	};
	rest();
	for ( const link of routeLinks ) link.setAttribute( 'aria-current', 'page' );
	// A gate titled with the page name already ("News | Site") is not prefixed again.
	const title = ! args.gateTitle || args.gateTitle === label ? label
		: args.gateTitle.startsWith( label ) ? args.gateTitle : `${ label } | ${ args.gateTitle }`;

	// The note replaces the content root only. Without one, a new root goes in
	// before the footer, so the shell's header and footer are never wiped.
	const contentRoot = () => document.querySelector( 'main' ) ?? document.querySelector( '[role="main"]' ) ?? ( () => {
		const root = document.createElement( 'main' );
		const footer = document.querySelector( 'footer,[role="contentinfo"]' );
		if ( footer?.parentNode ) footer.before( root );
		else document.body.append( root );
		return root;
	} )();
	const main = contentRoot();
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
	section.setAttribute( 'data-blocks-engine-capture-access-gate', args.provider.toLowerCase() );
	section.style.cssText = 'max-width:720px;margin:64px auto;padding:0 24px;box-sizing:border-box';
	// Explicit sizes: builders often set a tiny root font size and size text per component.
	const heading = document.createElement( 'h1' );
	heading.textContent = label;
	heading.style.cssText = 'font-size:32px;line-height:1.25;margin:0 0 16px';
	if ( headingFont ) heading.style.fontFamily = headingFont;
	const note = document.createElement( 'p' );
	note.textContent = args.note;
	note.style.cssText = 'font-size:18px;line-height:1.5;margin:0';
	if ( bodyFont ) note.style.fontFamily = bodyFont;
	section.append( heading, note );
	main.replaceChildren( section );

	document.title = title;
	document.querySelector( 'link[rel="canonical"]' )?.setAttribute( 'href', route.href );
	for ( const meta of document.querySelectorAll( 'meta[property="og:url"],meta[name="og:url"]' ) ) meta.setAttribute( 'content', route.href );
	for ( const meta of document.querySelectorAll( 'meta[property="og:title"],meta[name="og:title"],meta[name="twitter:title"],meta[property="twitter:title"]' ) ) meta.setAttribute( 'content', title );
	// The shell's description and share image describe the root page, not this one.
	for ( const meta of document.querySelectorAll( [ 'meta[name="description"]', 'meta[property="og:description"]', 'meta[name="og:description"]',
		'meta[property^="og:image"]', 'meta[name^="og:image"]', 'meta[name="twitter:description"]', 'meta[property="twitter:description"]',
		'meta[name^="twitter:image"]', 'meta[property^="twitter:image"]' ].join( ',' ) ) ) meta.remove();
	if ( location.href !== route.href ) history.replaceState( history.state, '', route.href );
	// The shell is a live page: its runtime can re-render the content root
	// (Wix hydrates the root page's sections after load, during lazy load or
	// probing) and silently put the root page back under the route's name. Hold
	// the note in place for the rest of the capture; serialization re-asserts it
	// once more and refuses a document without it.
	const host = window as unknown as { __dlaAccessGate?: { observer: MutationObserver; reassert: () => boolean } };
	host.__dlaAccessGate?.observer.disconnect();
	// Only repairs count against the budget, not the page's own animation.
	let repairs = 0;
	const displaced = () => {
		const root = document.querySelector( 'main' ) ?? document.querySelector( '[role="main"]' );
		return ! root || root.childNodes.length !== 1 || root.firstChild !== section || document.title !== title || restingItems().length > 0;
	};
	const reassert = () => {
		const root = contentRoot();
		if ( root.childNodes.length !== 1 || root.firstChild !== section ) root.replaceChildren( section );
		if ( document.title !== title ) document.title = title;
		// The shell's router still believes it serves the root page and can
		// re-mark that item current when it re-renders its menu.
		rest();
		return section.isConnected;
	};
	const observer = new MutationObserver( () => {
		if ( ! displaced() ) return;
		if ( ++repairs > 100 ) {
			observer.disconnect();
			return;
		}
		reassert();
	} );
	observer.observe( document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [ 'class', ...stateAttributes ] } );
	host.__dlaAccessGate = { observer, reassert };
	return { label, title };
}

/**
 * Put the placeholder back if the shell's runtime replaced it, immediately
 * before serializing. False when the document no longer carries it (the shell
 * re-initialized its document); the caller must not ship that document.
 */
export async function reassertAccessGatePlaceholder( page: Page ): Promise< boolean > {
	return page.evaluate( () => {
		const state = ( window as unknown as { __dlaAccessGate?: { reassert: () => boolean } } ).__dlaAccessGate;
		state?.reassert();
		return Boolean( document.querySelector( '[data-blocks-engine-capture-access-gate]' ) );
	} );
}
