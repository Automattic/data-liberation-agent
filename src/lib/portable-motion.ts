import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import * as cheerio from 'cheerio';
import { checkFidelity, type FidelityReport } from './fidelity/check.js';
import { validateMotionContract, type MotionContract } from './fidelity/candidate-motion.js';
import { startStaticServer } from './replicate/local-site/static-server.js';
import { checkSelfConsistency } from './fidelity/self-consistency.js';

export const PORTABLE_MOTION_SCHEMA = 'data-liberation/portable-motion/v1';

export interface PortableMotionRecipe {
	schema: typeof PORTABLE_MOTION_SCHEMA;
	contract: MotionContract;
	routes: Record< string, {
		/** Explicit authored behavior settings on existing, visible captured elements. */
		elements: Array< { selector: string; attributes: Record< string, string > } >;
		/** Optional visible elements hidden until the authored finite sequence clears aria-busy. */
		busyHidden?: string[];
		/** Inert configuration; runtime code comes only from separately authored scripts. */
		markers: Array< { attribute: string; value: unknown } >;
		/** Independently authored scripts, pinned by SHA-256. Captured source scripts are rejected. */
		scripts: Array< { path: string; sha256: string } >;
	} >;
}

export interface PortableMotionReceipt {
	schema: typeof PORTABLE_MOTION_SCHEMA;
	/** `learned` receipts are inferred from source observation; `authored` come from a recipe. */
	origin?: 'authored' | 'learned';
	contract: MotionContract;
	routes: Record< string, { scripts: Array< { path: string; sha256: string } > } >;
	/** Observed source behavior the portable runtime does not reproduce, per route. */
	unsupported?: Record< string, Array< { selector?: string; reason: string } > >;
}

const sha = ( source: string | Buffer ) => createHash( 'sha256' ).update( source ).digest( 'hex' );
const safeName = ( value: string ) => /^[a-z0-9][a-z0-9.-]{0,79}$/i.test( value ) && ! value.includes( '..' );
const escape = ( value: string ) => value.replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' ).replace( /</g, '&lt;' );

/** A receipt identifies what is loaded; comparison still has to execute and prove it on every run. */
export function readPortableMotion( directory: string, websiteDir: string ): PortableMotionReceipt | null {
	const path = join( directory, 'portable-motion.json' );
	if ( ! existsSync( path ) ) return null;
	const receipt = JSON.parse( readFileSync( path, 'utf8' ) ) as PortableMotionReceipt;
	if ( receipt.schema !== PORTABLE_MOTION_SCHEMA || ! receipt.routes ) throw new Error( 'Invalid portable motion receipt' );
	validateMotionContract( receipt.contract );
	for ( const entry of Object.values( receipt.routes ) ) {
		for ( const script of entry.scripts ) {
			if ( ! /^motion\/[a-f0-9]{12}-[a-z0-9.-]+$/i.test( script.path ) || ! /^[a-f0-9]{64}$/i.test( script.sha256 ) ) throw new Error( 'Invalid portable motion script receipt' );
			const file = resolve( websiteDir, script.path );
			if ( ! file.startsWith( resolve( websiteDir ) + sep ) || ! existsSync( file ) ||
				! realpathSync( file ).startsWith( realpathSync( websiteDir ) + sep ) ||
				statSync( file ).size > 128 * 1024 || sha( readFileSync( file ) ) !== script.sha256 ) {
				throw new Error( `Portable motion script missing or changed: ${ script.path }` );
			}
		}
	}
	return receipt;
}

/** Extend a captured site using authored, hash-pinned runtime code; never reattach captured source scripts. */
export async function authorPortableMotion( directory: string, recipe: PortableMotionRecipe ): Promise< FidelityReport > {
	if ( recipe?.schema !== PORTABLE_MOTION_SCHEMA || ! recipe.routes || ! Object.keys( recipe.routes ).length ) throw new Error( 'Invalid portable motion recipe' );
	validateMotionContract( recipe.contract );
	const root = resolve( directory );
	if ( existsSync( join( root, 'portable-motion.json' ) ) ) throw new Error( 'This capture already has an authored portable motion receipt; recapture before authoring again' );
	const capture = JSON.parse( readFileSync( join( root, 'capture-receipt.json' ), 'utf8' ) );
	const websiteDir = resolve( root, capture.websiteRoot ?? 'website' );
	if ( ! websiteDir.startsWith( root + sep ) || ! existsSync( websiteDir ) ) throw new Error( 'Capture website root is missing or escapes its run' );
	const sourceReport = capture.sourceInteractivity?.schema === 'data-liberation/source-interactivity/v1' && capture.sourceInteractivity?.path === 'source-interactivity.json'
		? JSON.parse( readFileSync( join( root, capture.sourceInteractivity.path ), 'utf8' ) )
		: null;
	if ( ! Array.isArray( sourceReport?.pages ) ) throw new Error( 'Authored portable motion requires a diagnosed source-interactivity report' );
	const diagnosed = new Set< string >( sourceReport.pages.filter( ( page: { status?: string } ) => page.status === 'unreproduced' ).map( ( page: { url: string } ) => page.url ) );
	const sourceHashes = new Set< string >( ( sourceReport?.pages ?? [] ).flatMap( ( page: { scripts?: Array< { sha256: string } > } ) => ( page.scripts ?? [] ).map( ( script ) => script.sha256 ) ) );
	const stage = mkdtempSync( join( tmpdir(), 'dla-portable-motion-' ) );
	let server: Awaited< ReturnType< typeof startStaticServer > > | null = null;
	try {
		cpSync( websiteDir, stage, { recursive: true, force: true } );
		const receipt: PortableMotionReceipt = { schema: PORTABLE_MOTION_SCHEMA, origin: 'authored', contract: recipe.contract, routes: {} };
		for ( const [ route, authored ] of Object.entries( recipe.routes ) ) {
			if ( ! recipe.contract.routes[ route ] || ! /^(?:\/|\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/?)$/i.test( route ) || ! authored ||
				! Array.isArray( authored.elements ) || ! Array.isArray( authored.markers ) || ! Array.isArray( authored.scripts ) ||
				authored.elements.length > 24 || authored.markers.length > 12 || authored.scripts.length > 8 || ! authored.scripts.length ) throw new Error( `Invalid portable motion route: ${ route }` );
			const sourceUrl = route === '/' ? capture.source?.url : ( capture.routes ?? [] ).find( ( entry: { url?: string } ) => new URL( entry.url ?? capture.source?.url ).pathname === route )?.url;
			if ( ! sourceUrl || ! diagnosed.has( sourceUrl ) ) throw new Error( `Portable motion route lacks diagnosed source behavior: ${ route }` );
			const routePath = route === '/' ? 'index.html' : join( route.slice( 1 ), 'index.html' );
			const pagePath = join( stage, routePath );
			if ( ! existsSync( pagePath ) ) throw new Error( `Portable motion route was not captured: ${ route }` );
			const $ = cheerio.load( readFileSync( pagePath, 'utf8' ) );
			for ( const element of authored.elements ) {
				if ( ! element || typeof element.selector !== 'string' || element.selector.length > 120 || $( element.selector ).length !== 1 || ! element.attributes || Object.keys( element.attributes ).length > 8 ) {
					throw new Error( `Authored motion element must resolve exactly once: ${ element?.selector }` );
				}
				for ( const [ name, value ] of Object.entries( element.attributes ) ) {
					if ( ! /^data-[a-z0-9-]{1,80}$/.test( name ) || typeof value !== 'string' || value.length > 256 ) throw new Error( `Invalid portable motion element attribute: ${ name }` );
					$( element.selector ).attr( name, value );
				}
			}
			if ( authored.busyHidden ) {
				if ( ! Array.isArray( authored.busyHidden ) || authored.busyHidden.length > 12 || authored.busyHidden.some( ( selector ) => ! /^#[a-z0-9_-]{1,80}$/i.test( selector ) || $( selector ).length !== 1 ) ) throw new Error( 'Invalid busy-hidden authored element' );
				$( 'head' ).append( `<style>${ authored.busyHidden.map( ( selector ) => `body[aria-busy="true"] ${ selector }{display:none!important}` ).join( '' ) }</style>` );
			}
			for ( const marker of authored.markers ) {
				if ( ! /^data-[a-z0-9-]{1,80}$/.test( marker?.attribute ?? '' ) ) throw new Error( 'Invalid portable motion marker' );
				const json = JSON.stringify( marker.value );
				if ( ! json || Buffer.byteLength( json ) > 8192 ) throw new Error( 'Portable motion marker exceeds 8192 bytes' );
				$( 'body' ).append( `<span hidden ${ marker.attribute }="${ escape( json ) }"></span>` );
			}
			const scripts: PortableMotionReceipt[ 'routes' ][ string ][ 'scripts' ] = [];
			for ( const script of authored.scripts ) {
				if ( ! script || ! safeName( basename( script.path ) ) || ! /^[a-f0-9]{64}$/i.test( script.sha256 ) ) throw new Error( 'Invalid authored portable motion script' );
				const authoredPath = realpathSync( resolve( script.path ) );
				if ( authoredPath.startsWith( root + sep ) ) throw new Error( 'Authored script must not come from the captured source run' );
				const bytes = readFileSync( authoredPath );
				const digest = sha( bytes );
				if ( bytes.length > 128 * 1024 || digest !== script.sha256 || sourceHashes.has( digest ) ) throw new Error( 'Authored script differs from its pin or matches a captured source script' );
				const path = `motion/${ digest.slice( 0, 12 ) }-${ basename( script.path ) }`;
				mkdirSync( join( stage, 'motion' ), { recursive: true } );
				writeFileSync( join( stage, path ), bytes );
				$( 'body' ).append( `<script defer src="/${ path }"></script>` );
				scripts.push( { path, sha256: digest } );
			}
			receipt.routes[ route ] = { scripts };
			writeFileSync( pagePath, $.html() );
		}
		const routes = new Map< string, string >( [ [ '/', 'index.html' ] ] );
		for ( const entry of capture.routes ?? [] ) {
			if ( typeof entry.url !== 'string' || typeof entry.path !== 'string' ) continue;
			try { routes.set( new URL( entry.url ).pathname, entry.path.replace( /^website\//, '' ) ); } catch { /* Malformed source URLs are never routes. */ }
		}
		const offline = checkSelfConsistency( stage, routes );
		if ( ! offline.pass ) throw new Error( `Authored portable site fails offline checks: ${ offline.findings.map( ( finding ) => finding.detail ).join( '; ' ) }` );
		server = await startStaticServer( stage );
		const report = await checkFidelity( { directory: root, candidateUrl: server.url, motionContract: recipe.contract, widths: recipe.contract.widths } );
		if ( ! report.pass ) throw new Error( `Portable motion did not reproduce the source: ${ report.scores.flatMap( ( score ) => score.failures ).join( '; ' ) }; ${ report.motionEvidence?.flatMap( ( row ) => row.failures ).join( '; ' ) }` );
		// Successful browser proof precedes every change to the public website.
		cpSync( stage, websiteDir, { recursive: true, force: true } );
		writeFileSync( join( root, 'portable-motion.json' ), JSON.stringify( receipt, null, 2 ) );
		return report;
	} finally {
		await server?.close();
		rmSync( stage, { recursive: true, force: true } );
	}
}
