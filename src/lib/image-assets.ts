import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve as resolvePath } from 'node:path';
import * as cheerio from 'cheerio';
import postcss from 'postcss';
import { srcsetCandidates } from './srcset.js';
import { deriveFilenameFromUrl, downloadMedia, extensionFromContentType, safeFilename, type DownloadResult } from './media-fetch/media.js';
import { isIntegrityError } from './failure-class.js';
import { getPlaywright } from './browser-kit/index.js';
import { MediaStubStore } from './resume-state/index.js';
import { pathWithin } from './portable-assets.js';
import type { CapturedResourceManifest } from './screenshot/resource-capture.js';

/** Capture-owned resource identity. Export copies these bytes, never a substitute. */
export interface AssetRecord {
	kind?: 'image' | 'font' | 'document' | 'video';
	destination_owner?: 'theme' | 'media-library';
	source_urls: string[];
	/** Each captured use resolves via source_url to this record's exported bytes. */
	references: AssetReference[];
	resolved_original: string;
	original: {
		source_url: string;
		content_type: string;
		width?: number;
		height?: number;
		/** At least one non-opaque decoded pixel; not inferred from a file extension. */
		alpha?: boolean;
		sha256: string;
	} | null;
	local_path?: string;
	error?: string;
}

/** @deprecated Use AssetRecord. */
export type ImageAssetRecord = AssetRecord;
/** @deprecated Use AssetReference. */
export type ImageAssetReference = AssetReference;

export interface AssetReference {
	kind: 'content' | 'navigation' | 'head' | 'CSS';
	document_url: string;
	/** Element index in the captured document, or a stylesheet declaration index. */
	location: string;
	source_url: string;
	font_face?: { family?: string; weight?: string; style?: string; unicode_range?: string; format?: string };
}

type ImageDocuments = Iterable<{ html: string; url: string }>;
type ImageResolver = import('../platform/types.js').Platform['resolveImageOriginal'];

export function resolvedImageOriginal( value: string, resolve?: ImageResolver ): string {
	const seen = new Set<string>();
	while ( seen.size < 32 && ! seen.has( value ) ) {
		seen.add( value );
		const target = resolve?.( value );
		if ( ! target ) break;
		const next = new URL( target, value );
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

/** Fail closed on unknown signatures; response headers and extensions are not evidence. */
export function resourceContentType( bytes: Buffer, kind: NonNullable<ImageAssetRecord['kind']> ): string | undefined {
	const magic = bytes.toString( 'latin1', 0, 4 );
	if ( kind === 'font' ) {
		if ( bytes.length < 12 ) return undefined;
		const tables = bytes.readUInt16BE( 4 );
		if ( bytes.length >= 48 && bytes.readUInt16BE( 12 ) > 0 && bytes.readUInt32BE( 8 ) === bytes.length ) {
			if ( magic === 'wOF2' ) return 'font/woff2';
			if ( magic === 'wOFF' ) return 'font/woff';
		}
		if ( tables > 0 && tables <= 512 && bytes.length >= 12 + tables * 16 ) {
			if ( magic === 'OTTO' ) return 'font/otf';
			if ( bytes.readUInt32BE( 0 ) === 0x00010000 || magic === 'true' ) return 'font/ttf';
		}
	}
	if ( kind === 'document' ) {
		if ( bytes.subarray( 0, 5 ).toString() === '%PDF-' && bytes.subarray( -1024 ).includes( Buffer.from( '%%EOF' ) ) ) return 'application/pdf';
		if ( bytes.length >= 22 && bytes.readUInt32LE( 0 ) === 0x04034b50 ) {
			// OOXML packages declare their document kind in the ZIP member inventory.
			if ( bytes.includes( Buffer.from( '[Content_Types].xml' ) ) ) {
				if ( bytes.includes( Buffer.from( 'word/document.xml' ) ) ) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
				if ( bytes.includes( Buffer.from( 'xl/workbook.xml' ) ) ) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
				if ( bytes.includes( Buffer.from( 'ppt/presentation.xml' ) ) ) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
			}
			return 'application/zip';
		}
		if ( bytes.subarray( 0, 2 ).equals( Buffer.from( [ 0x1f, 0x8b ] ) ) ) return 'application/gzip';
		if ( bytes.subarray( 0, 6 ).equals( Buffer.from( [ 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c ] ) ) ) return 'application/x-7z-compressed';
		if ( bytes.toString( 'ascii', 0, 5 ) === '{\\rtf' ) return 'application/rtf';
	}
	if ( kind === 'video' ) {
		if ( bytes.length >= 16 && bytes.toString( 'ascii', 4, 8 ) === 'ftyp' ) return 'video/mp4';
		if ( bytes.length >= 16 && bytes.readUInt32BE( 0 ) === 0x1a45dfa3 && bytes.subarray( 0, 4096 ).includes( Buffer.from( 'webm' ) ) ) return 'video/webm';
		if ( magic === 'OggS' && bytes.includes( Buffer.from( 'theora' ) ) ) return 'video/ogg';
	}
	return undefined;
}

export function readAssets( root: string ): ImageAssetRecord[] {
	const path = join( root, 'image-assets.json' );
	return existsSync( path ) ? JSON.parse( readFileSync( path, 'utf8' ) ).images.map( ( record: ImageAssetRecord ) => ( { ...record, kind: record.kind ?? 'image', destination_owner: record.destination_owner ?? ( record.kind === 'font' ? 'theme' : 'media-library' ), references: record.references ?? [] } ) ) : [];
}

/** Inventory all retained resource uses. Explicit image relationships join before fetching;
 * other URL aliases join only after their hashes verify identical bytes.
 * Documents are streamed: only the identity inventory outlives each parsed page.
 */
export function collectAssets( documents: ImageDocuments, resolve?: ImageResolver ): ImageAssetRecord[] {
	const groups: Array<{ urls: Set<string>; original: string; size: number; references: ImageAssetReference[]; kind: NonNullable<ImageAssetRecord['kind']> }> = [];
	const add = ( values: string[], preferred: string, base: string, references: ImageAssetReference[], size = 0, kind: NonNullable<ImageAssetRecord['kind']> = 'image' ) => {
		const urls = new Set<string>();
		for ( const value of values ) {
			try {
				const url = new URL( value, base );
				if ( /^https?:$/.test( url.protocol ) ) {
					urls.add( url.href );
					urls.add( kind === 'image' ? resolvedImageOriginal( url.href, resolve ) : url.href );
				}
			} catch { /* Invalid references cannot be fetched. */ }
		}
		if ( ! urls.size ) return;
		let original: string;
		try { original = kind === 'image' ? resolvedImageOriginal( new URL( preferred, base ).href, resolve ) : new URL( preferred, base ).href; }
		catch { original = [ ...urls ][ 0 ]; }
		if ( ! urls.has( original ) ) original = [ ...urls ][ 0 ];
		const overlapping = groups.filter( group => group.kind === kind && [ ...urls ].some( url => group.urls.has( url ) ) );
		for ( const group of overlapping ) {
			for ( const url of group.urls ) urls.add( url );
			references.push( ...group.references );
			// A CSS reference or smaller document must not demote the srcset original.
			if ( group.size > size ) { original = group.original; size = group.size; }
			groups.splice( groups.indexOf( group ), 1 );
		}
		groups.push( { urls, original, size, references, kind } );
	};
	for ( const { html, url: documentUrl } of documents ) {
		const $ = cheerio.load( html );
		let url = documentUrl;
		try { url = new URL( $( 'base[href]' ).first().attr( 'href' ) ?? documentUrl, documentUrl ).href; }
		catch { /* Malformed base: retain the document URL. */ }
		const reference = ( value: string, kind: ImageAssetReference['kind'], location: string ): ImageAssetReference[] => {
			try {
				const source = new URL( value, url );
				return /^https?:$/.test( source.protocol ) ? [ { kind, document_url: documentUrl, location, source_url: source.href } ] : [];
			} catch { return []; }
		};
		$( 'img,picture source' ).each( ( _i, node ) => {
			const candidates = srcsetCandidates( $( node ).attr( 'srcset' ) ?? '' ).sort( ( a, b ) => a.size - b.size );
			const values = [ $( node ).attr( 'src' ) ?? '', ...candidates.map( candidate => candidate.url ) ].filter( Boolean );
			const kind = $( node ).closest( 'nav,[role=navigation]' ).length ? 'navigation' : 'content';
			const src = $( node ).attr( 'src' );
			const references = [
				...( src ? reference( src, kind, `image:${ _i }:src` ) : [] ),
				...candidates.flatMap( ( candidate, index ) => reference( candidate.url, kind, `image:${ _i }:srcset:${ index }` ) ),
			];
			// Only image links enclosing an image establish a lightbox relationship;
			// ordinary page links must never merge otherwise unrelated resources.
			const link = $( node ).closest( 'a[href]' );
			const href = link.attr( 'href' );
			const lightbox = href && ( /\.(?:avif|webp|png|jpe?g|gif|svg)(?:[?#]|$)/i.test( href ) || link.is( '[data-lightbox],[data-fancybox]' ) ) ? href : undefined;
			if ( lightbox ) {
				values.push( lightbox );
			}
			if ( values.length ) add( values, lightbox ?? candidates.at( -1 )?.url ?? values[ 0 ], url, references, lightbox ? Infinity : candidates.at( -1 )?.size ?? 0 );
		} );
		$( 'a[href]' ).each( ( i, node ) => {
			const href = $( node ).attr( 'href' )!;
			if ( ! /\.(?:avif|webp|png|jpe?g|gif|svg)(?:[?#]|$)/i.test( href ) && ! $( node ).is( '[data-lightbox],[data-fancybox]' ) ) return;
			const kind = $( node ).closest( 'nav,[role=navigation]' ).length ? 'navigation' : 'content';
			add( [ href ], href, url, reference( href, kind, `anchor:${ i }:href` ) );
		} );
		$( 'a[href]' ).each( ( i, node ) => {
			const href = $( node ).attr( 'href' )!;
			if ( /\.(?:avif|webp|png|jpe?g|gif|svg)(?:[?#]|$)/i.test( href ) ) return;
			if ( ! $( node ).is( '[download]' ) && ! /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|gz|7z|txt|csv|rtf|epub)(?:[?#]|$)/i.test( href ) ) return;
			const kind = $( node ).closest( 'nav,[role=navigation]' ).length ? 'navigation' : 'content';
			add( [ href ], href, url, reference( href, kind, `download:${ i }:href` ), 0, 'document' );
		} );
		$( 'video' ).each( ( i, node ) => {
			const poster = $( node ).attr( 'poster' );
			if ( poster ) add( [ poster ], poster, url, reference( poster, 'content', `video:${ i }:poster` ) );
		} );
		$( 'video[src],video source[src]' ).each( ( i, node ) => {
			const src = $( node ).attr( 'src' )!;
			add( [ src ], src, url, reference( src, 'content', `video:${ i }:src` ), 0, 'video' );
		} );
		$( 'link[href]' ).each( ( i, node ) => {
			if ( ! /(?:^|\s)(?:icon|apple-touch-icon|apple-touch-icon-precomposed)(?:\s|$)/i.test( $( node ).attr( 'rel' ) ?? '' ) ) return;
			const href = $( node ).attr( 'href' )!;
			add( [ href ], href, url, reference( href, 'head', `link:${ i }` ) );
		} );
		const styles: string[] = [];
		$( 'style' ).each( ( _i, node ) => { styles.push( $( node ).text() ); } );
		$( '[style]' ).each( ( _i, node ) => { styles.push( $( node ).attr( 'style' )! ); } );
		let declarationIndex = 0;
		for ( const css of styles ) {
			try {
				postcss.parse( css ).walkDecls( declaration => {
					if ( declaration.prop.toLowerCase() === 'src' && declaration.parent?.type === 'atrule' && declaration.parent.name.toLowerCase() === 'font-face' ) {
						const location = `declaration:${ declarationIndex++ }:src`;
						const descriptors = new Map<string, string>();
						declaration.parent.walkDecls( descriptor => { descriptors.set( descriptor.prop.toLowerCase(), descriptor.value ); } );
						for ( const match of declaration.value.matchAll( /url\(\s*["']?([^\s"')]+)["']?\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/gi ) ) {
							const refs = reference( match[ 1 ], 'CSS', location );
							for ( const ref of refs ) ref.font_face = { family: descriptors.get( 'font-family' ), weight: descriptors.get( 'font-weight' ), style: descriptors.get( 'font-style' ), unicode_range: descriptors.get( 'unicode-range' ), format: match[ 2 ] };
							add( [ match[ 1 ] ], match[ 1 ], url, refs, 0, 'font' );
						}
						return;
					}
					if ( ! /^(?:background(?:-image)?|(?:-webkit-)?mask(?:-image)?|border-image(?:-source)?|list-style(?:-image)?|content)$/i.test( declaration.prop ) ) return;
					const location = `declaration:${ declarationIndex++ }:${ declaration.prop }`;
					for ( const match of declaration.value.matchAll( /url\(\s*["']?([^\s"')]+)["']?\s*\)/gi ) ) add( [ match[ 1 ] ], match[ 1 ], url, reference( match[ 1 ], 'CSS', location ) );
				} );
			} catch { /* The stylesheet owner reports malformed CSS. */ }
		}
	}
	return groups.map( group => ( {
		kind: group.kind, destination_owner: group.kind === 'font' ? 'theme' : 'media-library',
		source_urls: [ ...group.urls ], references: [ ...new Map( group.references.map( ref => [ JSON.stringify( ref ), ref ] ) ).values() ], resolved_original: group.original, original: null,
		error: `unresolved ${ group.kind } original: ${ group.original }`,
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
export async function captureAssets( root: string, documents: ImageDocuments, deadline?: number, resolve?: ImageResolver ): Promise<ImageAssetRecord[]> {
	const images = collectAssets( documents, resolve );
	mkdirSync( root, { recursive: true } );
	const stubs = MediaStubStore.load( root );
	const manifestPath = join( root, 'resources', 'manifest.json' );
	const resources: CapturedResourceManifest['resources'] = existsSync( manifestPath )
		? JSON.parse( readFileSync( manifestPath, 'utf8' ) ).resources ?? {} : {};
	const names = new Map<string, number>();
	const mediaDir = join( root, 'media' );
	if ( existsSync( mediaDir ) ) for ( const name of readdirSync( mediaDir ) ) names.set( name, 1 );
	let browser: import('playwright').Browser | undefined;
	try {
		if ( images.length ) {
			let page: import('playwright').Page | undefined;
			for ( const record of images ) {
				const source = record.resolved_original;
				try {
					if ( /\/_missing-media\/|\/(?:placeholder|missing-image)\.(?:svg|png|gif|webp)(?:[?#]|$)/i.test( source ) )
						throw new Error( 'source references a known image placeholder' ); // failure-class: operational
					// Reuse the URL-owned file, never a filename guess or a different rendition.
					const cachedPath = [ resources[ source ]?.path, stubs.get( source )?.localPath ]
						.filter( ( path ): path is string => Boolean( path ) )
						.map( path => resolvePath( root, path ) )
						.find( path => pathWithin( root, path ) && existsSync( path ) );
					if ( ! cachedPath && deadline !== undefined && Date.now() >= deadline )
						throw new Error( 'resource acquisition deadline reached' ); // failure-class: operational
					// Keep verification/extension correction in media/, without mutating captured resources.
					let result: Pick<DownloadResult, 'localPath' | 'filename' | 'error'>;
					if ( cachedPath && pathWithin( mediaDir, cachedPath ) ) {
						result = { localPath: cachedPath, filename: basename( cachedPath ), error: null };
					} else if ( cachedPath ) {
						mkdirSync( mediaDir, { recursive: true } );
						const filename = safeFilename( deriveFilenameFromUrl( new URL( source ) ) || basename( cachedPath ), names );
						const destination = join( mediaDir, filename );
						copyFileSync( cachedPath, destination );
						result = { localPath: destination, filename, error: null };
					} else {
						result = await downloadMedia( source, mediaDir, names, undefined, { preserveOriginal: true } );
					}
					if ( ! result.localPath ) throw new Error( result.error ?? 'resource download failed' ); // failure-class: operational
					const bytes = readFileSync( result.localPath );
					const contentType = record.kind === 'image' ? imageContentType( bytes ) : resourceContentType( bytes, record.kind! );
					if ( ! contentType ) throw new Error( 'unverified resource bytes or placeholder' ); // failure-class: operational
					if ( record.kind === 'font' && record.references.some( ref => {
						const format = ref.font_face?.format?.toLowerCase();
						const expected = { woff: 'font/woff', woff2: 'font/woff2', truetype: 'font/ttf', opentype: 'font/otf' }[ format ?? '' ];
						return expected && expected !== contentType;
					} ) ) throw new Error( 'font bytes do not match declared format' ); // failure-class: operational
					if ( record.kind === 'image' && ! page ) {
						const pw = await getPlaywright();
						browser ??= await pw.chromium.launch( { headless: true, timeout: 30000 } );
						page = await browser.newPage();
						await page.route( '**/*', route => route.abort() );
					}
					const metadata = record.kind === 'image' ? await decodeImage( page!, bytes, contentType ) : {};
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
			record.error = `Resource verification unavailable: ${ String( error ) }`;
			for ( const url of record.source_urls ) stubs.markFailure( url, record.error );
		}
	} finally { await browser?.close().catch( () => {} ); }
	// Query aliases collapse only after verification: query parameters can select different bytes.
	const verified = new Map<string, ImageAssetRecord>();
	for ( let i = 0; i < images.length; i++ ) {
		const record = images[ i ];
		if ( ! record.original || record.kind === 'image' ) continue;
		const key = `${ record.kind }:${ record.original.sha256 }`;
		const previous = verified.get( key );
		if ( ! previous ) { verified.set( key, record ); continue; }
		previous.source_urls = [ ...new Set( [ ...previous.source_urls, ...record.source_urls ] ) ];
		previous.references.push( ...record.references );
		for ( const url of record.source_urls ) stubs.markSuccess( url, previous.local_path! );
		images.splice( i--, 1 );
	}
	stubs.flush();
	const path = join( root, 'image-assets.json' );
	writeFileSync( `${ path }.tmp`, JSON.stringify( { version: 1, images }, null, 2 ) + '\n' );
	renameSync( `${ path }.tmp`, path );
	return images;
}
