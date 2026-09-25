import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { CapturedResourceStore } from './resource-capture.js';

// Still frames are filed under a path of their own on the source origin: they
// have no source URL, and the copy must never reference the session-only
// `blob:` URL they were taken from.
const FRAME_PATH = '/_dla/video-frames/';
const FRAME_MARKER = 'data-dla-video-frame';
const MAX_FRAME_WIDTH = 1920;
const FRAME_QUALITY = 0.85;

/**
 * Give every stream-backed video a poster the copy can show.
 *
 * A video fed through Media Source Extensions (HLS and DASH players) plays
 * from a `blob:` URL that only exists inside the live page session, so
 * `capturePageHtml` drops it. Without a poster the copy is left with an empty
 * player where a full-bleed band used to be. In order of preference, the
 * poster is the one the element already declares (`poster`, then the
 * lazy-loading `data-poster` many players use), or else a still of the frame
 * the live element is showing, stored as an image asset.
 *
 * An adapter that knows its platform's durable rendition or poster can set it
 * in `beforeSerialize`, which runs first; this step then leaves it alone.
 *
 * Best-effort: a video with no decoded frame, or one whose frame the page may
 * not read, keeps no poster.
 */
export async function preserveStreamedVideoPosters(
	page: Page,
	resourceStore: CapturedResourceStore,
	documentUrl: string
): Promise< void > {
	const frames = await page.evaluate(
		( { marker, maxWidth, quality } ) => {
			const isSessionUrl = ( value: string | null | undefined ) => /^blob:/i.test( value?.trim() ?? '' );
			const frames: Array< { id: string; dataUrl: string } > = [];
			for ( const video of document.querySelectorAll( 'video' ) ) {
				video.removeAttribute( marker );
				const streamed =
					isSessionUrl( video.currentSrc ) ||
					isSessionUrl( video.getAttribute( 'src' ) ) ||
					[ ...video.querySelectorAll( 'source' ) ].some( ( source ) =>
						isSessionUrl( source.getAttribute( 'src' ) )
					);
				if ( ! streamed ) continue;
				const poster = video.getAttribute( 'poster' )?.trim();
				if ( poster && ! isSessionUrl( poster ) ) continue;
				const declared = video.getAttribute( 'data-poster' )?.trim();
				if ( declared && ! isSessionUrl( declared ) && ! declared.startsWith( 'data:' ) ) {
					try {
						video.setAttribute( 'poster', new URL( declared, document.baseURI ).href );
						continue;
					} catch {
						// Fall through to a still frame.
					}
				}
				video.removeAttribute( 'poster' );
				if ( video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || ! video.videoWidth || ! video.videoHeight )
					continue;
				const scale = Math.min( 1, maxWidth / video.videoWidth );
				const canvas = document.createElement( 'canvas' );
				canvas.width = Math.max( 1, Math.round( video.videoWidth * scale ) );
				canvas.height = Math.max( 1, Math.round( video.videoHeight * scale ) );
				let dataUrl: string;
				try {
					canvas.getContext( '2d' )?.drawImage( video, 0, 0, canvas.width, canvas.height );
					// Throws for a cross-origin frame the page may not read.
					dataUrl = canvas.toDataURL( 'image/jpeg', quality );
				} catch {
					continue;
				}
				if ( ! dataUrl.startsWith( 'data:image/jpeg;base64,' ) ) continue;
				const id = String( frames.length );
				video.setAttribute( marker, id );
				frames.push( { id, dataUrl } );
			}
			return frames;
		},
		{ marker: FRAME_MARKER, maxWidth: MAX_FRAME_WIDTH, quality: FRAME_QUALITY }
	);
	if ( ! Array.isArray( frames ) || frames.length === 0 ) return;

	const posters: Record< string, string > = {};
	for ( const { id, dataUrl } of frames ) {
		const body = Buffer.from( dataUrl.slice( dataUrl.indexOf( ',' ) + 1 ), 'base64' );
		const hash = createHash( 'sha256' ).update( body ).digest( 'hex' ).slice( 0, 16 );
		const url = new URL( `${ FRAME_PATH }${ hash }.jpg`, documentUrl ).href;
		if ( resourceStore.recordGeneratedResource( url, body, 'image/jpeg' ) ) posters[ id ] = url;
	}
	await page.evaluate(
		( { marker, posters } ) => {
			for ( const video of document.querySelectorAll( `video[${ marker }]` ) ) {
				const poster = posters[ video.getAttribute( marker ) ?? '' ];
				if ( poster ) video.setAttribute( 'poster', poster );
				video.removeAttribute( marker );
			}
		},
		{ marker: FRAME_MARKER, posters }
	);
}
