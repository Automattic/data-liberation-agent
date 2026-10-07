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
 * So capture does not invent a target, and does not change the element: a
 * button stays a button (focusable, styled, with its icon and label). It only
 * records which controls are member sign-in entry points, as a class
 * (`dla-member-login-<provider>`) plus a `data-dla-member-login="<provider>"`
 * attribute. The class is the durable marker: block conversion keeps classes
 * on buttons and links where it drops data attributes. A destination that has
 * a login (WordPress: `wp_login_url()`) points every marked control at it; one
 * that has none can hide them.
 */

/** Marks a member sign-in entry point; the value names the provider. */
export const MEMBER_LOGIN_ATTRIBUTE = 'data-dla-member-login';
/** Class prefix for the same marker; the provider id is appended. */
export const MEMBER_LOGIN_CLASS_PREFIX = 'dla-member-login-';

export interface MemberLoginControls {
	/** Lower-case provider id written into the marker, such as `wix`. */
	provider: string;
	/** Controls that opened the provider's login dialog (usually buttons). */
	controls: string;
	/** Same-origin path prefixes of the provider's members area, such as `/account/`. */
	memberPaths?: string[];
}

/**
 * Serialized into the page. Marks the provider's sign-in controls and
 * same-origin links into its members area, leaving each element as it is.
 * Returns how many elements were marked.
 */
export function markMemberLoginControls( args: MemberLoginControls & { attribute: string; classPrefix: string } ): number {
	// tsx instruments nested functions with __name(); the built bundle does not.
	const globalWithName = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
	if ( typeof globalWithName.__name === 'undefined' ) globalWithName.__name = ( fn ) => fn;

	const className = args.classPrefix + args.provider;
	const targets = new Set< Element >( document.querySelectorAll( args.controls ) );
	for ( const link of document.querySelectorAll< HTMLAnchorElement >( 'a[href]' ) ) {
		let target: URL;
		try {
			target = new URL( link.getAttribute( 'href' ) ?? '', location.href );
		} catch {
			continue;
		}
		if ( target.origin !== location.origin ) continue;
		if ( ( args.memberPaths ?? [] ).some( ( prefix ) => target.pathname.startsWith( prefix ) ) ) targets.add( link );
	}
	let marked = 0;
	for ( const element of targets ) {
		if ( element.classList.contains( className ) ) continue;
		element.classList.add( className );
		element.setAttribute( args.attribute, args.provider );
		marked++;
	}
	return marked;
}
