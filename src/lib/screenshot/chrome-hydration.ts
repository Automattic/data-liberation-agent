/**
 * Site chrome serializes the same way on every route only once its runtime
 * controls have hydrated (#1261).
 *
 * A third-party chrome widget (a store's cart button in the site header) is
 * often server-rendered as a placeholder link: an `<a>` with no `href` and no
 * accessible name, which its runtime later turns into the live control by
 * giving it a destination, a label and a count. When the baseline document is
 * serialized before that happens, one route (or one device profile of a
 * route) ships the placeholder while the others ship the hydrated control, so
 * identical chrome is captured with different markup and responsive assembly
 * splits it into per-viewport fragments.
 *
 * A link without `href` is a placeholder for where a link would otherwise be,
 * and a rendered control without an accessible name is one a reader cannot use.
 * A rendered placeholder link without a name inside a chrome landmark is
 * therefore a control that is still waiting for its runtime: the capture waits,
 * bounded, until every such link has gained a destination or a name (or left the
 * document) before snapshotting. A chrome without such links does not wait.
 */

/** Upper bound for chrome controls to hydrate before the baseline snapshot. */
export const CHROME_HYDRATION_TIMEOUT_MS = 12_000;

/** Site chrome landmarks whose controls are shared across routes. */
export const CHROME_HYDRATION_LANDMARKS = 'header,[role="banner"],nav,[role="navigation"]';

export interface ChromeHydrationOutcome {
	/** Placeholder links found when the wait started. */
	placeholders: number;
	/** Placeholder links still unhydrated when the wait ended. */
	pending: number;
	/** Element descriptors of the links still pending, for evidence. */
	pendingLinks: string[];
	waitedMs: number;
}

/**
 * Runs in the page: wait (bounded) until no rendered, nameless placeholder link
 * remains inside a chrome landmark. Self-contained so it serializes into
 * `page.evaluate`.
 */
export function waitForChromePlaceholderLinks( { timeoutMs, landmarks }: { timeoutMs: number; landmarks: string } ): Promise<ChromeHydrationOutcome> {
	const started = Date.now();
	const named = ( link: Element ): boolean => {
		if ( ( link.getAttribute( 'aria-label' ) ?? '' ).trim() || ( link.getAttribute( 'title' ) ?? '' ).trim() ) return true;
		const labelledBy = ( link.getAttribute( 'aria-labelledby' ) ?? '' ).split( /\s+/ ).filter( Boolean );
		if ( labelledBy.some( id => ( document.getElementById( id )?.textContent ?? '' ).trim() ) ) return true;
		if ( ( link.textContent ?? '' ).trim() ) return true;
		return Array.from( link.querySelectorAll( 'img[alt],[aria-label]' ) ).some( child =>
			( child.getAttribute( 'alt' ) ?? child.getAttribute( 'aria-label' ) ?? '' ).trim() );
	};
	const rendered = ( link: Element ): boolean => {
		if ( link.closest( '[hidden],[inert],[aria-hidden="true"]' ) ) return false;
		const style = getComputedStyle( link );
		if ( style.display === 'none' || style.visibility === 'hidden' ) return false;
		const box = link.getBoundingClientRect();
		return box.width > 0 && box.height > 0;
	};
	const pending = (): Element[] => Array.from( document.querySelectorAll( `:is(${ landmarks }) a:not([href])` ) )
		.filter( link => rendered( link ) && ! named( link ) );
	const describe = ( link: Element ): string => {
		const classes = ( link.getAttribute( 'class' ) ?? '' ).trim().split( /\s+/ ).filter( Boolean ).slice( 0, 3 );
		const hook = Array.from( link.attributes ).find( attribute => attribute.name.startsWith( 'data-' ) && attribute.value && attribute.value.length <= 64 );
		return `a${ link.id ? `#${ link.id }` : '' }${ classes.map( name => `.${ name }` ).join( '' ) }${ hook ? `[${ hook.name }="${ hook.value }"]` : '' }`;
	};
	const initial = pending();
	if ( initial.length === 0 ) return Promise.resolve( { placeholders: 0, pending: 0, pendingLinks: [], waitedMs: 0 } );
	return new Promise<ChromeHydrationOutcome>( resolve => {
		let done = false;
		let scheduled: ReturnType< typeof setTimeout > | undefined;
		const finish = () => {
			if ( done ) return;
			done = true;
			observer.disconnect();
			clearTimeout( timer );
			if ( scheduled !== undefined ) clearTimeout( scheduled );
			const left = pending();
			resolve( { placeholders: initial.length, pending: left.length, pendingLinks: left.slice( 0, 8 ).map( describe ), waitedMs: Date.now() - started } );
		};
		// A hydrating runtime mutates in bursts: re-check at most once per burst.
		const observer = new MutationObserver( () => {
			if ( scheduled !== undefined ) return;
			scheduled = setTimeout( () => {
				scheduled = undefined;
				if ( pending().length === 0 ) finish();
			}, 50 );
		} );
		const timer = setTimeout( finish, timeoutMs );
		observer.observe( document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true } );
	} );
}

/** Upper bound for an opened dialog's lazily mounted content. */
export const DIALOG_CONTENT_MOUNT_MS = 6_000;

/**
 * Runs in the page: a chrome dialog whose runtime mounts its content only on
 * first open (a store's side cart) is revealed as an empty shell first. A
 * dialog with no text, media or control in it has nothing to show yet, so the
 * capture waits, bounded, until it gains any; a dialog with content returns at
 * once. Resolves `present` when the content was already there, `mounted` when
 * it arrived during the wait, and `empty` when the bound ended without it.
 */
export function waitForDialogContent( { selector, timeoutMs }: { selector: string; timeoutMs: number } ): Promise<'present' | 'mounted' | 'empty'> {
	const CONTENT = 'img,svg,video,canvas,iframe,picture,input,select,textarea,button,a[href],[role="button"],[role="link"]';
	const dialog = document.querySelector( selector );
	if ( ! dialog ) return Promise.resolve( 'empty' );
	const hasContent = () => Boolean( ( dialog.textContent ?? '' ).trim() || dialog.querySelector( CONTENT ) );
	if ( hasContent() ) return Promise.resolve( 'present' );
	return new Promise<'mounted' | 'empty'>( resolve => {
		const finish = () => {
			observer.disconnect();
			clearTimeout( timer );
			resolve( hasContent() ? 'mounted' : 'empty' );
		};
		const observer = new MutationObserver( () => { if ( ! dialog.isConnected || hasContent() ) finish(); } );
		const timer = setTimeout( finish, timeoutMs );
		observer.observe( document.documentElement, { subtree: true, childList: true, characterData: true } );
	} );
}
