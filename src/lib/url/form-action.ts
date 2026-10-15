import { sameHttpSite } from '../screenshot/same-origin.js';

/** Route diagnostic for a submission URL removed because its scheme is not a destination. */
export const FORM_ACTION_REMOVED = 'form_action_removed';

/** Route diagnostic for a form that submits to the source site's own handler. */
export const FORM_ACTION_SOURCE_HANDLER = 'form_action_source_handler';

export type PortableFormAction = {
	/** The attribute value to keep, or undefined to remove the attribute. */
	value?: string;
	diagnostic?: { code: string; reason: string };
};

/**
 * The export policy for a form submission URL (`action` on `<form>`,
 * `formaction` on a submit control).
 *
 * The exported site has no runtime of the source CMS, so it must never submit
 * to that CMS's own handlers, and a script or document scheme is never a
 * destination. A third-party endpoint is a real destination the form needs
 * (a hosted payment or mailing-list button), so it is kept as an absolute URL.
 *
 * - `http(s)` on another site: kept, resolved to an absolute URL.
 * - `http(s)` on the source site, or relative: rewritten to its root-relative
 *   path, the route reference the importer resolves or neutralizes like a link,
 *   and recorded as `form_action_source_handler` with the source URL.
 * - `mailto:`: kept; the importer maps it to the form's recipient.
 * - Any other scheme (`javascript:`, `data:`, ...) or an unparseable URL:
 *   removed and recorded as `form_action_removed`.
 * - Empty: removed without a record. A form without an action submits to its
 *   own document, so nothing is lost.
 *
 * `baseUrl` is the document base (`<base href>` resolved against the page) and
 * `pageUrl` the captured route. Without a page URL, nothing relative can be
 * resolved, so only third-party and `mailto:` destinations survive.
 */
export function portableFormAction( attribute: string, raw: string, baseUrl: string | undefined, pageUrl: string | undefined ): PortableFormAction {
	// Browsers drop ASCII whitespace and controls from a URL before reading its scheme.
	const compact = [ ...raw ].filter( ( character ) => character.charCodeAt( 0 ) > 0x20 ).join( '' );
	if ( compact === '' ) return {};
	const removed = ( reason: string ): PortableFormAction => ( {
		diagnostic: { code: FORM_ACTION_REMOVED, reason: `${ attribute } removed: ${ reason }` },
	} );
	let url: URL;
	try {
		url = new URL( raw.trim(), baseUrl ?? pageUrl );
	} catch {
		return removed( 'unresolvable submission URL' );
	}
	if ( url.protocol === 'mailto:' ) return { value: url.href };
	if ( url.protocol !== 'http:' && url.protocol !== 'https:' ) return removed( `${ url.protocol } is not a submission destination` );
	if ( url.username || url.password ) return removed( 'submission URL carries credentials' );
	if ( pageUrl === undefined || ! sameHttpSite( url.href, pageUrl ) ) return { value: url.href };
	const path = `${ url.pathname }${ url.search }${ url.hash }`;
	return {
		value: path,
		diagnostic: {
			code: FORM_ACTION_SOURCE_HANDLER,
			reason: `${ attribute } targets the source site's own handler ${ url.href }; kept as ${ path } so the export never submits to the source site`,
		},
	};
}
