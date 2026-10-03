import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import type { RuntimeRegionObservation } from './runtime-regions.js';
import type { AcquiredHttpDocument } from './http-acquisition.js';
import { CapturedResourceStore, type CapturedResourceManifest } from './screenshot/resource-capture.js';
import { safeFetch } from './media-fetch/safe-fetch.js';

const digest = ( value: string | Buffer ) => createHash( 'sha256' ).update( value ).digest( 'hex' );
export interface RuntimeRegionAttachment { variant: string; observation: RuntimeRegionObservation }
interface EmbeddedRegion {
	url: string; variant: string; selector: string; index: number;
	documentSha256: string; html: string;
	viewport: RuntimeRegionObservation['viewport'];
}
interface EmbeddedReceipt {
	schema: 'data-liberation/embedded-documents/v1';
	regions: EmbeddedRegion[];
	documents: Record<string, { path: string; sha256: string; sourcePath: string; sourceSha256: string }>;
	verification: { rendering: 'unverified'; interactions: 'unverified' };
}

/** Stage observed child documents and dependencies; functional reconstruction remains unverified. */
export async function stageRuntimeRegions( options: { outputDir: string; attachments: readonly RuntimeRegionAttachment[] }, dependencies?: { fetch: typeof safeFetch } ): Promise<string> {
	const acquisition = JSON.parse( readFileSync( join( options.outputDir, 'http-acquisition.json' ), 'utf8' ) ) as { schema: string; documents: AcquiredHttpDocument[] };
	if ( acquisition.schema !== 'data-liberation/http-acquisition/v1' || ! Array.isArray( acquisition.documents ) || options.attachments.length > 100 ) throw new Error( 'Invalid acquisition or runtime attachment budget' );
	const receipt: EmbeddedReceipt = { schema: 'data-liberation/embedded-documents/v1', regions: [], documents: {}, verification: { rendering: 'unverified', interactions: 'unverified' } };
	const seen = new Set<string>();
	let bytes = 0;
	const pending = new Map<string, { url: string; html: string; path: string; sourceHtml: string; sourcePath: string }>();
	for ( const { variant, observation } of options.attachments ) {
		const document = acquisition.documents.find( candidate => candidate.url === observation.sourceUrl && candidate.variant === variant && candidate.status === 'acquired' );
		if ( ! document?.documentSha256 || observation.schema !== 'data-liberation/runtime-regions/v1' || observation.finalUrl !== observation.sourceUrl || ! observation.viewport ) throw new Error( 'Runtime observation does not match acquired document identity' );
		const key = JSON.stringify( [ document.url, variant ] );
		if ( seen.has( key ) ) throw new Error( 'Multiple runtime viewports require explicit selection per variant' );
		seen.add( key );
		if ( observation.regions.length > 32 || observation.regions.some( region => region.nodes.length > 16 ) ) throw new Error( 'Runtime observation exceeds region budget' );
		for ( const region of observation.regions ) {
			if ( region.status !== 'observed' || ! document.browserRegions?.some( requirement => requirement.selector === region.selector ) ) continue;
			for ( const node of region.nodes ) {
				if ( ! node.frames.length ) continue;
				if ( ! node.html || ! node.sha256 || digest( node.html ) !== node.sha256 ) throw new Error( 'Runtime region identity mismatch' );
				if ( node.frames.length > 16 || Buffer.byteLength( node.html ) > 256 * 1024 || ! Number.isInteger( node.index ) || node.index < 0 ) throw new Error( 'Runtime region exceeds node budget' );
				bytes += Buffer.byteLength( node.html );
				const $ = cheerio.load( node.html, null, false );
				const frames = $( 'iframe' );
				let attached = 0;
				for ( const child of node.frames ) {
					if ( ! child.html || ! child.sha256 || digest( child.html ) !== child.sha256 || ! child.box || ! Number.isFinite( child.box.width ) || ! Number.isFinite( child.box.height ) || child.box.width <= 0 || child.box.height <= 0 || ! /^https:\/\//.test( child.url ) ) throw new Error( 'Child document lacks valid observed identity and geometry' );
					if ( Buffer.byteLength( child.html ) > 256 * 1024 ) throw new Error( 'Child snapshot exceeds byte budget' );
					bytes += Buffer.byteLength( child.html );
					const frame = frames.filter( ( _, element ) => { try { return new URL( $( element ).attr( 'src' ) ?? '', document.url ).href === child.url; } catch { return false; } } );
					if ( frame.length !== 1 ) throw new Error( 'Observed child is not uniquely addressable in its region' );
					const childDocument = cheerio.load( child.html );
					const base = new URL( childDocument( 'base[href]' ).first().attr( 'href' ) ?? child.url, child.url ).href;
					childDocument( 'script,iframe,noscript,object,embed,meta[http-equiv="refresh"]' ).remove();
					childDocument( 'base' ).remove();
					childDocument( '[href],[src],[poster],[action]' ).each( ( _, element ) => {
						const node = childDocument( element );
						for ( const attribute of [ 'href', 'src', 'poster', 'action' ] ) {
							const value = node.attr( attribute );
							if ( value && ! value.startsWith( '#' ) ) { try { node.attr( attribute, new URL( value, base ).href ); } catch { /* Retain malformed source for sanitizer diagnostics. */ } }
						}
					} );
					childDocument( 'head' ).prepend( `<base href="${ base.replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' ) }">` );
					const html = childDocument.html();
					bytes += Buffer.byteLength( html );
					if ( bytes > 16 * 1024 * 1024 ) throw new Error( 'Embedded document staging byte budget exceeded' );
					const path = `embedded-documents/${ digest( html ) }.html`;
					const sourcePath = `embedded-source/${ child.sha256 }.html`;
					const old = receipt.documents[ child.url ];
					if ( old && old.sha256 !== digest( html ) ) throw new Error( 'Conflicting child document bodies for one source URL' );
					receipt.documents[ child.url ] = { path, sha256: digest( html ), sourcePath, sourceSha256: child.sha256 };
					pending.set( sourcePath, { url: child.url, html, path, sourcePath, sourceHtml: child.html } );
					frame.attr( 'data-dla-embedded-document', child.url );
					const authoredHeight = /^(\d+(?:\.\d+)?)(?:px)?$/.exec( frame.attr( 'height' ) ?? '' )?.[ 1 ];
					frame.attr( 'height', authoredHeight ?? String( child.box.height ) );
					if ( ! authoredHeight ) frame.attr( 'style', `${ frame.attr( 'style' ) ?? '' };box-sizing:border-box;height:${ child.box.height }px` );
					attached++;
				}
				if ( attached ) receipt.regions.push( { url: document.url, variant, selector: region.selector, index: node.index, documentSha256: document.documentSha256, html: $.html(), viewport: observation.viewport } );
			}
		}
	}
	mkdirSync( join( options.outputDir, 'embedded-documents' ), { recursive: true } );
	mkdirSync( join( options.outputDir, 'embedded-source' ), { recursive: true } );
	const store = new CapturedResourceStore( options.outputDir, acquisition.documents[ 0 ]?.url ?? 'https://example.invalid/', dependencies ? ( url, maxBytes, timeoutMs ) => dependencies.fetch( url, { maxBytes, timeoutMs } ) : undefined );
	for ( const child of pending.values() ) {
		writeFileSync( join( options.outputDir, child.sourcePath ), child.sourceHtml );
		writeFileSync( join( options.outputDir, child.path ), child.html );
		await store.captureDomDependencies( child.html, child.url );
	}
	await store.flush();
	const path = join( options.outputDir, 'embedded-documents.json' );
	writeFileSync( path, JSON.stringify( receipt, null, 2 ) + '\n' );
	return path;
}

/** Validate attachments before the exporter replaces its candidate directory. */
export function loadEmbeddedDocuments( outputDir: string ) {
	const root = realpathSync( outputDir );
	const bytes = readFileSync( join( root, 'embedded-documents.json' ) );
	if ( bytes.length > 32 * 1024 * 1024 ) throw new Error( 'Embedded receipt exceeds byte budget' );
	const receipt = JSON.parse( bytes.toString( 'utf8' ) ) as EmbeddedReceipt;
	if ( receipt.schema !== 'data-liberation/embedded-documents/v1' || ! Array.isArray( receipt.regions ) || ! receipt.documents ) throw new Error( 'Invalid embedded document receipt' );
	if ( receipt.regions.length > 1600 || Object.keys( receipt.documents ).length > 1600 || receipt.regions.some( region => ! Number.isInteger( region.index ) || region.index < 0 || typeof region.html !== 'string' ) ) throw new Error( 'Invalid embedded region budget or identity' );
	const resources: CapturedResourceManifest['resources'] = {};
	for ( const [ url, document ] of Object.entries( receipt.documents ) ) {
		const sourcePath = realpathSync( resolve( root, document.sourcePath ) );
		const sourceLocal = relative( root, sourcePath );
		if ( sourceLocal === '..' || sourceLocal.startsWith( '../' ) || isAbsolute( sourceLocal ) || digest( readFileSync( sourcePath ) ) !== document.sourceSha256 ) throw new Error( 'Embedded source identity or containment mismatch' );
		const path = realpathSync( resolve( root, document.path ) );
		const local = relative( root, path );
		if ( local === '..' || local.startsWith( '../' ) || isAbsolute( local ) || digest( readFileSync( path ) ) !== document.sha256 || ! /^https:\/\//.test( url ) ) throw new Error( 'Embedded document identity or containment mismatch' );
		resources[ url ] = { path: local, contentType: 'text/html' };
	}
	return { receipt, resources, evidence: { path: 'embedded-documents.json', sha256: digest( bytes ), verification: receipt.verification } };
}

export function projectEmbeddedRegions( html: string, url: string, variant: string, documentSha256: string | undefined, regions: EmbeddedRegion[] ): string {
	const $ = cheerio.load( html );
	for ( const region of regions.filter( region => region.url === url && region.variant === variant ) ) {
		if ( region.documentSha256 !== documentSha256 ) throw new Error( 'Runtime attachment prepared-document hash mismatch' );
		const node = $( region.selector ).eq( region.index );
		if ( ! node.length ) throw new Error( 'Runtime attachment region is missing from acquired document' );
		node.replaceWith( region.html );
	}
	return $.html();
}

/** Preserve observed child variants inside an otherwise equivalent parent document. */
export function mergeResponsiveEmbeddedRegions( options: {
	desktop: string; mobile: string; url: string; desktopVariant: string; mobileVariant: string;
	receipt: EmbeddedReceipt; switchWidth: number; scopeClasses: { desktop: string; mobile: string };
} ): { desktop: string; mobile: string } {
	const d = cheerio.load( options.desktop ), m = cheerio.load( options.mobile );
	const rules: string[] = [];
	for ( const region of options.receipt.regions.filter( region => region.url === options.url && region.variant === options.desktopVariant ) ) {
		if ( ! options.receipt.regions.some( candidate => candidate.url === region.url && candidate.variant === options.mobileVariant && candidate.selector === region.selector && candidate.index === region.index ) ) continue;
		const desktopNode = d( region.selector ).eq( region.index ), mobileNode = m( region.selector ).eq( region.index );
		const frames = ( $: cheerio.CheerioAPI, node: ReturnType<typeof d> ) => node.is( 'iframe' ) ? node : node.find( 'iframe[data-dla-embedded-document]' );
		const df = frames( d, desktopNode ), mf = frames( m, mobileNode );
		if ( df.length !== mf.length ) throw new Error( 'Responsive embedded frame identities differ structurally' );
		for ( let index = 0; index < df.length; index++ ) {
			const desktopFrame = df.eq( index ), mobileFrame = mf.eq( index );
			const desktopSource = desktopFrame.attr( 'data-dla-embedded-document' ) ?? '', mobileSource = mobileFrame.attr( 'data-dla-embedded-document' ) ?? '';
			if ( options.receipt.documents[ desktopSource ]?.sha256 === options.receipt.documents[ mobileSource ]?.sha256 && desktopFrame.attr( 'height' ) === mobileFrame.attr( 'height' ) ) continue;
			const hook = `dla-embedded-${ digest( JSON.stringify( [ region.url, region.selector, region.index, index ] ) ).slice( 0, 16 ) }`;
			const desktopClass = `${ hook }-desktop`, mobileClass = `${ hook }-mobile`;
			const pair = `<span class="${ desktopClass } ${ options.scopeClasses.desktop }">${ d.html( desktopFrame ) }</span><span class="${ mobileClass } ${ options.scopeClasses.mobile }">${ m.html( mobileFrame ) }</span>`;
			desktopFrame.replaceWith( pair ); mobileFrame.replaceWith( pair );
			rules.push( `.${ desktopClass }{display:contents}.${ mobileClass }{display:none}@media(max-width:${ options.switchWidth }px){.${ desktopClass }{display:none}.${ mobileClass }{display:contents}}` );
		}
	}
	if ( rules.length ) {
		const style = `<style data-dla-embedded-responsive>${ rules.join( '\n' ) }</style>`;
		d( 'head' ).append( style ); m( 'head' ).append( style );
	}
	return { desktop: d.html(), mobile: m.html() };
}
