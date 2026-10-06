import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname, relative, resolve, sep } from 'node:path';
export const TRANSPARENT_IMAGE_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
export function fileHash( path: string ): string {
	return createHash( 'sha256' ).update( readFileSync( path ) ).digest( 'hex' );
}

export function uniqueAssetPath(
	requestedPath: string,
	contentHash: string,
	hashesByPath: Map< string, string >
): string {
	const existingHash = hashesByPath.get( requestedPath );
	if ( existingHash === undefined || existingHash === contentHash ) return requestedPath;
	const extension = extname( requestedPath );
	return `${ requestedPath.slice(
		0,
		requestedPath.length - extension.length
	) }-${ contentHash.slice( 0, 12 ) }${ extension }`;
}

export function pathWithin( root: string, candidate: string ): boolean {
	const rel = relative( resolve( root ), resolve( candidate ) );
	return rel === '' || ( ! rel.startsWith( `..${ sep }` ) && rel !== '..' );
}


export function portableResourcePath( path: string, contentType: string ): string | undefined {
	const requestedPath = path.replace( /^resources[\\/]/, '' );
	if ( extname( basename( requestedPath ) ) ) return requestedPath;

	const extension =
		{
			'application/ecmascript': '.js',
			'application/javascript': '.js',
			'application/json': '.json',
			'application/manifest+json': '.json',
			'application/ld+json': '.json',
			'application/pdf': '.pdf',
			'application/xml': '.xml',
			'application/wasm': '.wasm',
			'audio/mpeg': '.mp3',
			'audio/ogg': '.ogg',
			'audio/wav': '.wav',
			'font/otf': '.otf',
			'font/ttf': '.ttf',
			'font/woff': '.woff',
			'font/woff2': '.woff2',
			'application/font-otf': '.otf',
			'application/font-ttf': '.ttf',
			'application/font-woff': '.woff',
			'application/font-woff2': '.woff2',
			'application/x-font-otf': '.otf',
			'application/x-font-ttf': '.ttf',
			'application/x-font-woff': '.woff',
			'application/x-font-woff2': '.woff2',
			'image/avif': '.avif',
			'image/gif': '.gif',
			'image/jpeg': '.jpg',
			'image/png': '.png',
			'image/svg+xml': '.svg',
			'image/webp': '.webp',
			'text/css': '.css',
			'text/ecmascript': '.js',
			'text/html': '.html',
			'text/javascript': '.js',
			'text/plain': '.txt',
			'text/xml': '.xml',
			'video/mp4': '.mp4',
			'video/ogg': '.ogg',
			'video/webm': '.webm',
		}[ contentType.toLowerCase().split( ';', 1 )[ 0 ].trim() ] ?? '';

	return extension ? `${ requestedPath }${ extension }` : undefined;
}

/** Encode a copied file's URL without changing its on-disk path. */
export function portableAssetUrl( path: string ): string {
	return '/' + path.replace( /\\/g, '/' ).split( '/' ).map( encodeURIComponent ).join( '/' );
}
