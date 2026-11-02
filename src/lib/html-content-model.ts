/**
 * Containers that must not receive a generated flow-content panel. Transparent
 * inline wrappers are treated conservatively: they may inherit a phrasing-only
 * content model from their ancestors. This is not a list of all inline tags
 * (images and other void elements cannot contain a trigger).
 */
const PHRASING_CONTENT_CONTAINERS = new Set( [
	'a', 'abbr', 'b', 'bdi', 'bdo', 'button', 'cite', 'code', 'data', 'del',
	'dfn', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'i', 'ins',
	'kbd', 'label', 'legend', 'mark', 'meter', 'output', 'p', 'pre', 'progress',
	'q', 'ruby', 'rp', 'rt', 's', 'samp', 'small', 'span', 'strike', 'strong',
	'sub', 'summary', 'sup', 'time', 'tt', 'u', 'var',
] );

export function hasPhrasingContent( tagName: string ): boolean {
	return PHRASING_CONTENT_CONTAINERS.has( tagName.toLowerCase() );
}
