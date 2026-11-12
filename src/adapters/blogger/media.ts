/**
 * Blogger image renditions (#1701). Blogger and its googleusercontent CDN
 * encode the rendition size in the URL: a path segment (`/s1600/`,
 * `/w640-h480-p-k-no-nu/`) or a `=s<N>` / `=w<N>-h<N>` suffix on extensionless
 * URLs. `s0` names the uploaded original.
 */
const BLOGGER_IMAGE_HOST = /(?:^|\.)(?:bp\.blogspot\.com|blogger\.googleusercontent\.com|googleusercontent\.com)$/i;
const SIZE_SEGMENT = /^[swh]\d+(?:-[a-z0-9]+)*$/i;
const SIZE_SUFFIX = /=[swh]\d+(?:-[a-z0-9]+)*$/i;

/** The original rendition of a Blogger image URL, or undefined when the URL already names it or is not a Blogger image. */
export function bloggerImageOriginal( value: string ): string | undefined {
	let url: URL;
	try { url = new URL( value ); } catch { return undefined; }
	if ( ! BLOGGER_IMAGE_HOST.test( url.hostname ) ) return undefined;
	const segments = url.pathname.split( '/' );
	const last = segments.length - 1;
	for ( let i = 1; i < last; i++ ) {
		if ( SIZE_SEGMENT.test( segments[ i ]! ) ) segments[ i ] = 's0';
	}
	segments[ last ] = segments[ last ]!.replace( SIZE_SUFFIX, '=s0' );
	url.pathname = segments.join( '/' );
	return url.href === value ? undefined : url.href;
}
