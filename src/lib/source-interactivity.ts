import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import * as cheerio from 'cheerio';
import type { CapturedResourceManifest } from './screenshot/resource-capture.js';

export const SOURCE_INTERACTIVITY_SCHEMA = 'data-liberation/source-interactivity/v1';
const MAX_SCRIPT_BYTES = 128 * 1024;
const MAX_SCRIPTS = 32;

export type MotionSignal = 'canvas-2d' | 'pointer-input' | 'animation-frame' | 'timed-dom-update' | 'click-input';
export interface SourceInteractivityPage {
	url: string;
	status: 'not_detected' | 'unreproduced';
	signals: MotionSignal[];
	/** Identifies captured source code without exporting executable bytes. */
	scripts: Array< { url: string; sha256: string; bytes: number } >;
}

/** Evidence about source behavior lost when executable provider scripts are removed. */
export function inspectSourceInteractivity(
	html: string,
	pageUrl: string,
	outputDir: string,
	resources: CapturedResourceManifest
): SourceInteractivityPage {
	const $ = cheerio.load( html );
	const hasCanvas = $( 'canvas' ).length > 0;
	const canvasIds = $( 'canvas[id]' )
		.map( ( _, element ) => $( element ).attr( 'id' ) ?? '' )
		.get();
	const scripts: SourceInteractivityPage[ 'scripts' ] = [];
	const bodies: string[] = [];
	for ( const element of $( 'script' ).toArray().slice( 0, MAX_SCRIPTS ) ) {
		const script = $( element );
		const type = ( script.attr( 'type' ) ?? '' ).trim().toLowerCase();
		if (
			type &&
			! [ 'module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript' ].includes( type )
		) continue;
		const src = script.attr( 'src' );
		let body: string;
		let url = pageUrl;
		if ( src ) {
			try {
				url = new URL( src, pageUrl ).href;
			} catch {
				continue;
			}
			if ( new URL( url ).origin !== new URL( pageUrl ).origin ) continue;
			const resource = resources.resources[ url ];
			if ( ! resource || ! /(?:java|ecma)script/i.test( resource.contentType ) ) continue;
			const file = resolve( outputDir, resource.path );
			const root = resolve( outputDir ) + sep;
			if ( ! file.startsWith( root ) || ! existsSync( file ) ) continue;
			const stats = statSync( file );
			if ( ! stats.isFile() || stats.size > MAX_SCRIPT_BYTES ) continue;
			body = readFileSync( file, 'utf8' );
		} else body = script.text();
		const bytes = Buffer.byteLength( body );
		if ( ! bytes || bytes > MAX_SCRIPT_BYTES ) continue;
		bodies.push( body );
		scripts.push( { url, bytes, sha256: createHash( 'sha256' ).update( body ).digest( 'hex' ) } );
	}
	const source = bodies.join( '\n' );
	const addressesCanvas = canvasIds.some( ( id ) =>
		[ `getElementById('${ id }')`, `getElementById("${ id }")`, `querySelector('#${ id }')`, `querySelector("#${ id }")` ]
			.some( ( reference ) => source.includes( reference ) )
	)
		|| /(?:querySelector(?:All)?|getElementsByTagName)\s*\(\s*['"]canvas['"]\s*\)/.test( source );
	const signals: MotionSignal[] = [];
	if ( hasCanvas && addressesCanvas && /\.getContext\s*\(\s*['"]2d['"]/.test( source ) ) signals.push( 'canvas-2d' );
	if ( /addEventListener\s*\(\s*['"](?:pointer|mouse|touch)(?:move|down|up)['"]/.test( source ) ) signals.push( 'pointer-input' );
	if ( /\brequestAnimationFrame\s*\(/.test( source ) ) signals.push( 'animation-frame' );
	if (
		/\bset(?:Timeout|Interval)\s*\(/.test( source ) &&
		/\.(?:textContent|innerText|innerHTML)\s*=|\.classList\.(?:add|remove|toggle)\s*\(/.test( source )
	) signals.push( 'timed-dom-update' );
	if ( /addEventListener\s*\(\s*['"]click['"]/.test( source ) ) signals.push( 'click-input' );
	const motion = signals.includes( 'canvas-2d' ) && signals.includes( 'animation-frame' )
		|| signals.includes( 'timed-dom-update' ) && signals.includes( 'click-input' );
	return { url: pageUrl, status: motion ? 'unreproduced' : 'not_detected', signals, scripts };
}
