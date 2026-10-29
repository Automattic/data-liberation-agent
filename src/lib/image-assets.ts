import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import * as cheerio from 'cheerio';
import postcss from 'postcss';
import { srcsetCandidates } from './srcset.js';
import { downloadMedia, extensionFromContentType, safeFilename } from './media-fetch/media.js';
import { isIntegrityError } from './failure-class.js';
import { getPlaywright } from './browser-kit/index.js';
import { MediaStubStore } from './resume-state/index.js';

/** Capture-owned identity. Export copies these bytes, never a negotiated rendition. */
export interface ImageAssetRecord {
	source_urls: string[];
	resolved_original: string;
	original: {
		source_url: string;
		content_type: string;
		width: number;
		height: number;
		/** At least one non-opaque decoded pixel; not inferred from a file extension. */
		alpha: boolean;
		sha256: string;
	} | null;
	local_path?: string;
	error?: string;
}

type ImageDocuments = Iterable<{ html: string; url: string }>;

export function resolvedImageOriginal( value: string ): string {
	const seen = new Set<string>();
	while ( ! seen.has( value ) ) {
		seen.add( value );
		const url = new URL( value );
		const target = url.pathname === '/_next/image' ? url.searchParams.get( 'url' ) : null;
		if ( ! target ) break;
		const next = new URL( target, url );
		if ( ! /^https?:$/.test( next.protocol ) ) break;
		value = next.href;
	}
	return value;
}

/** Signature identification is followed by real decode before a record is verified. */
export function imageContentType( bytes: Buffer ): string | undefined {
	if ( bytes.subarray( 0, 8 ).equals( Buffer.from( [ 137, 80, 78, 71, 13, 10, 26, 10 ] ) ) ) return 'image/png';
	if ( bytes[ 0 ] === 255 && bytes[ 1 ] === 216 && bytes[ 2 ] === 255 ) return 'image/jpeg';
	if ( /^GIF8[79]a$/.test( bytes.toString( 'ascii', 0, 6 ) ) ) return 'image/gif';
	if ( bytes.toString( 'ascii', 0, 4 ) === 'RIFF' && bytes.toString( 'ascii', 8, 12 ) === 'WEBP' ) return 'image/webp';
	if ( bytes.toString( 'ascii', 4, 8 ) === 'ftyp' && /avif|avis/.test( bytes.toString( 'ascii', 8, 32 ) ) ) return 'image/avif';
	if ( /^(?:\s*<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test( bytes.toString( 'utf8' ).trimStart() ) ) return 'image/svg+xml';
	return undefined;
}

export function readImageAssets( root: string ): ImageAssetRecord[] {
	const path = join( root, 'image-assets.json' );
	return existsSync( path ) ? JSON.parse( readFileSync( path, 'utf8' ) ).images : [];
}

/** Group explicit srcset relationships, optimizer targets and CSS references before fetching.
 * Documents are streamed: only the identity inventory outlives each parsed page.
 */
export function collectImageAssets( documents: ImageDocuments ): ImageAssetRecord[] {
	const groups: Array<{ urls: Set<string>; original: string; size: number }> = [];
	const add = ( values: string[], preferred: string, base: string, size = 0 ) => {
		const urls = new Set<string>();
		for ( const value of values ) {
			try {
				const url = new URL( value, base );
				if ( /^https?:$/.test( url.protocol ) ) {
					urls.add( url.href );
					urls.add( resolvedImageOriginal( url.href ) );
				}
			} catch { /* Invalid references cannot be fetched. */ }
		}
		if ( ! urls.size ) return;
		let original: string;
		try { original = resolvedImageOriginal( new URL( preferred, base ).href ); }
		catch { original = [ ...urls ][ 0 ]; }
		if ( ! urls.has( original ) ) original = [ ...urls ][ 0 ];
		const overlapping = groups.filter( group => [ ...urls ].some( url => group.urls.has( url ) ) );
		for ( const group of overlapping ) {
			for ( const url of group.urls ) urls.add( url );
			// A CSS reference or smaller document must not demote the srcset original.
			if ( group.size > size ) { original = group.original; size = group.size; }
			groups.splice( groups.indexOf( group ), 1 );
		}
		groups.push( { urls, original, size } );
	};
	for ( const { html, url: documentUrl } of documents ) {
		const $ = cheerio.load( html );
		let url = documentUrl;
		try { url = new URL( $( 'base[href]' ).first().attr( 'href' ) ?? documentUrl, documentUrl ).href; }
		catch { /* Malformed base: retain the document URL. */ }
		$( 'img,picture source' ).each( ( _i, node ) => {
			const candidates = srcsetCandidates( $( node ).attr( 'srcset' ) ?? '' ).sort( ( a, b ) => a.size - b.size );
			const values = [ $( node ).attr( 'src' ) ?? '', ...candidates.map( candidate => candidate.url ) ].filter( Boolean );
			if ( values.length ) add( values, candidates.at( -1 )?.url ?? values[ 0 ], url, candidates.at( -1 )?.size ?? 0 );
		} );
		const styles: string[] = [];
		$( 'style' ).each( ( _i, node ) => { styles.push( $( node ).text() ); } );
		$( '[style]' ).each( ( _i, node ) => { styles.push( $( node ).attr( 'style' )! ); } );
		for ( const css of styles ) {
			try {
				postcss.parse( css ).walkDecls( declaration => {
					if ( ! /^(?:background(?:-image)?|(?:-webkit-)?mask(?:-image)?|border-image(?:-source)?|list-style(?:-image)?|content)$/i.test( declaration.prop ) ) return;
					for ( const match of declaration.value.matchAll( /url\(\s*["']?([^\s"')]+)["']?\s*\)/gi ) ) add( [ match[ 1 ] ], match[ 1 ], url );
				} );
			} catch { /* The stylesheet owner reports malformed CSS. */ }
		}
	}
	return groups.map( group => ( {
		source_urls: [ ...group.urls ], resolved_original: group.original, original: null,
		error: `unresolved image original: ${ group.original }`,
	} ) );
}

async function decodeImage( page: import('playwright').Page, bytes: Buffer, contentType: string ) {
	return page.evaluate( async ( data ) => {
		const image = new Image();
		image.src = data;
		await Promise.race( [ image.decode(), new Promise<never>( ( _resolve, reject ) => {
			setTimeout( () => reject( new Error( 'image decode timeout' ) ), 10000 ); // failure-class: operational
		} ) ] );
		if ( ! image.width || ! image.height || image.width * image.height > 40_000_000 )
			throw new Error( 'image dimensions outside decode bound' ); // failure-class: operational
		const canvas = document.createElement( 'canvas' );
		canvas.width = image.width;
		canvas.height = image.height;
		const ctx = canvas.getContext( '2d' )!;
		ctx.drawImage( image, 0, 0 );
		const pixels = ctx.getImageData( 0, 0, image.width, image.height ).data;
		let alpha = false;
		for ( let i = 3; i < pixels.length; i += 4 ) if ( pixels[ i ] < 255 ) { alpha = true; break; }
		return { width: image.width, height: image.height, alpha };
	}, `data:${ contentType };base64,${ bytes.toString( 'base64' ) }` );
}

/** One acquisition per record; stub aliases are a compatibility projection, not identity owners. */
export async function captureImageAssets( root: string, documents: ImageDocuments, deadline?: number ): Promise<ImageAssetRecord[]> {
	const images = collectImageAssets( documents );
	mkdirSync( root, { recursive: true } );
	const stubs = MediaStubStore.load( root );
	const names = new Map<string, number>();
	const mediaDir = join( root, 'media' );
	if ( existsSync( mediaDir ) ) for ( const name of readdirSync( mediaDir ) ) names.set( name, 1 );
	let browser: import('playwright').Browser | undefined;
	try {
		if ( images.length ) {
			const pw = await getPlaywright();
			browser = await pw.chromium.launch( { headless: true, timeout: 30000 } );
			const page = await browser.newPage();
			await page.route( '**/*', route => route.abort() );
			for ( const record of images ) {
				const source = record.resolved_original;
				try {
					if ( deadline !== undefined && Date.now() >= deadline )
						throw new Error( 'image acquisition deadline reached' ); // failure-class: operational
					if ( /\/_missing-media\/|\/(?:placeholder|missing-image)\.(?:svg|png|gif|webp)(?:[?#]|$)/i.test( source ) )
						throw new Error( 'source references a known image placeholder' ); // failure-class: operational
					const result = await downloadMedia( source, mediaDir, names, undefined, { preserveOriginal: true } );
					if ( ! result.localPath ) throw new Error( result.error ?? 'image download failed' ); // failure-class: operational
					const bytes = readFileSync( result.localPath );
					const contentType = imageContentType( bytes );
					if ( ! contentType ) throw new Error( 'unverified image bytes or placeholder' ); // failure-class: operational
					const metadata = await decodeImage( page, bytes, contentType );
					// Even a lying response header's extension follows the verified bytes.
					const extension = extensionFromContentType( contentType );
					const currentExtension = extname( result.localPath );
					let localPath = result.localPath;
					if ( currentExtension.toLowerCase() !== extension ) {
						const base = currentExtension ? result.filename!.slice( 0, -currentExtension.length ) : result.filename!;
						localPath = join( mediaDir, safeFilename( `${ base }${ extension }`, names ) );
						renameSync( result.localPath, localPath );
					}
					record.original = { source_url: source, content_type: contentType, ...metadata, sha256: createHash( 'sha256' ).update( bytes ).digest( 'hex' ) };
					record.local_path = localPath;
					delete record.error;
					for ( const url of record.source_urls ) stubs.markSuccess( url, localPath );
				} catch ( error ) {
					if ( isIntegrityError( error ) ) throw error; // failure-class: integrity
					record.error = String( error );
					for ( const url of record.source_urls ) stubs.markFailure( url, record.error );
				}
			}
		}
	} catch ( error ) {
		if ( isIntegrityError( error ) ) throw error; // failure-class: integrity
		for ( const record of images ) if ( ! record.original ) {
			record.error = `Image verification unavailable: ${ String( error ) }`;
			for ( const url of record.source_urls ) stubs.markFailure( url, record.error );
		}
	} finally { await browser?.close().catch( () => {} ); }
	stubs.flush();
	const path = join( root, 'image-assets.json' );
	writeFileSync( `${ path }.tmp`, JSON.stringify( { version: 1, images }, null, 2 ) + '\n' );
	renameSync( `${ path }.tmp`, path );
	return images;
}
