/**
 * Member sign-in controls whose provider login cannot travel with the copy.
 *
 * A site builder's members feature puts "Sign In" controls on the page: a
 * header button that opens the provider's login dialog, and links into the
 * provider's members area. The login itself only works against the provider's
 * own member accounts, so capture removes it (a `provider-service` cleanup
 * rule). The controls stay, because they are part of the owner's layout, but
 * once the login is gone they lead nowhere.
 *
 * Where a reader should sign in is the destination's decision, not capture's:
 * a static host has no accounts at all, and a CMS has its own login route.
 * So capture does not invent a target. It records which controls are member
 * sign-in entry points, as links, with the `data-dla-member-login` marker
 * naming the provider. A destination that has a login (WordPress:
 * `wp_login_url()`) points every marked link at it; one that has none can
 * hide them. A button becomes a link because signing in is navigation once
 * the provider's dialog is gone, and a destination then only sets `href`.
 */

/** Marks a member sign-in entry point; the value names the provider. */
export const MEMBER_LOGIN_ATTRIBUTE = 'data-dla-member-login';

export interface MemberLoginControls {
	/** Lower-case provider id written into the marker, such as `wix`. */
	provider: string;
	/** Controls that opened the provider's login dialog (usually buttons). */
	controls: string;
	/** Same-origin path prefixes of the provider's members area, such as `/account/`. */
	memberPaths?: string[];
}

/**
 * Serialized into the page. Turns the provider's sign-in controls into
 * marked links and marks same-origin links into its members area. Returns how
 * many controls were marked.
 */
export function markMemberLoginControls( args: MemberLoginControls & { attribute: string } ): number {
	// tsx instruments nested functions with __name(); the built bundle does not.
	const globalWithName = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
	if ( typeof globalWithName.__name === 'undefined' ) globalWithName.__name = ( fn ) => fn;

	let marked = 0;
	// Attributes that only mean something on a form control or a dialog opener.
	const controlOnly = new Set( [ 'type', 'name', 'value', 'disabled', 'form', 'formaction', 'formmethod',
		'formenctype', 'formtarget', 'formnovalidate', 'aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-pressed' ] );
	for ( const control of document.querySelectorAll( args.controls ) ) {
		if ( control.hasAttribute( args.attribute ) ) continue;
		let link: Element = control;
		if ( control.tagName !== 'A' ) {
			link = document.createElement( 'a' );
			for ( const attribute of control.attributes ) {
				if ( ! controlOnly.has( attribute.name ) ) link.setAttribute( attribute.name, attribute.value );
			}
			link.append( ...control.childNodes );
			control.replaceWith( link );
		}
		link.setAttribute( args.attribute, args.provider );
		marked++;
	}
	for ( const link of document.querySelectorAll< HTMLAnchorElement >( 'a[href]' ) ) {
		if ( link.hasAttribute( args.attribute ) ) continue;
		let target: URL;
		try {
			target = new URL( link.getAttribute( 'href' ) ?? '', location.href );
		} catch {
			continue;
		}
		if ( target.origin !== location.origin ) continue;
		if ( ! ( args.memberPaths ?? [] ).some( ( prefix ) => target.pathname.startsWith( prefix ) ) ) continue;
		link.setAttribute( args.attribute, args.provider );
		marked++;
	}
	return marked;
}
