// src/adapters/wix/video.ts
//
// Wix's video player component renders a `<wow-video>` element whose
// `data-video-info` attribute holds the video record as JSON: the poster
// still and one progressive MP4 per quality (`sources[].types[]`, 360p up to
// 1080p). The runtime picks a rendition for the viewport, points an empty,
// invisible `<video>` at it, lays the poster `<wow-image>` over it, and draws
// its own play button above both. None of that works once the runtime is
// gone: the copy keeps a hidden `<video>` naming whichever rendition the
// runtime chose (often a 1080p file larger than a portable media file may
// be), a custom element no importer can map, and a play button wired to
// nothing.
//
// At serialization the player becomes one standard element:
// `<video controls poster>` with the rendition that fits the rendered box
// and the portable byte limit, and the rendition's intrinsic size.

import type { Page } from 'playwright';
import { MAX_PORTABLE_MEDIA_BYTES } from '../../lib/portable-media-limits.js';

const VIDEO_MARKER = 'data-blocks-engine-capture-wix-video';
const HEAD_TIMEOUT_MS = 10_000;

export interface WixVideoRendition {
	url: string;
	width: number;
	height: number;
}

export interface WixVideoRecord {
	renditions: WixVideoRendition[];
	poster?: string;
	hasAudio: boolean;
	loop: boolean;
	focalPoint?: { x: number; y: number };
}

function finitePositive( value: unknown ): number | undefined {
	return typeof value === 'number' && Number.isFinite( value ) && value > 0 ? value : undefined;
}

function httpsUrl( value: unknown, base?: string ): string | undefined {
	if ( typeof value !== 'string' || ! value.trim() ) return undefined;
	try {
		const url = new URL( value, base );
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read the progressive MP4 renditions and poster from a `data-video-info`
 * record. Adaptive (HLS) sources are skipped: they need a player runtime.
 */
export function wixVideoRecord( info: string, base?: string ): WixVideoRecord | null {
	let record: Record< string, unknown >;
	try {
		const parsed: unknown = JSON.parse( info );
		if ( ! parsed || typeof parsed !== 'object' ) return null;
		record = parsed as Record< string, unknown >;
	} catch {
		return null;
	}
	const renditions: WixVideoRendition[] = [];
	for ( const source of Array.isArray( record.sources ) ? record.sources : [] ) {
		if ( ! source || typeof source !== 'object' ) continue;
		const { width, height, types } = source as { width?: unknown; height?: unknown; types?: unknown };
		const w = finitePositive( width );
		const h = finitePositive( height );
		if ( ! w || ! h || ! Array.isArray( types ) ) continue;
		for ( const type of types ) {
			if ( ! type || typeof type !== 'object' ) continue;
			const { format, url } = type as { format?: unknown; url?: unknown };
			const resolved = format === 'mp4' ? httpsUrl( url, base ) : undefined;
			if ( resolved ) renditions.push( { url: resolved, width: w, height: h } );
		}
	}
	if ( renditions.length === 0 ) return null;
	renditions.sort( ( a, b ) => a.width - b.width || a.height - b.height );
	const poster = record.poster && typeof record.poster === 'object'
		? httpsUrl( ( record.poster as { url?: unknown } ).url, base )
		: undefined;
	const focal = record.focalPoint && typeof record.focalPoint === 'object'
		? record.focalPoint as { x?: unknown; y?: unknown }
		: undefined;
	const focalPoint = focal && typeof focal.x === 'number' && typeof focal.y === 'number'
		&& Number.isFinite( focal.x ) && Number.isFinite( focal.y )
		? { x: Math.min( 100, Math.max( 0, focal.x ) ), y: Math.min( 100, Math.max( 0, focal.y ) ) }
		: undefined;
	return {
		renditions,
		...( poster ? { poster } : {} ),
		hasAudio: record.hasAudio !== false,
		loop: record.loop === true,
		...( focalPoint ? { focalPoint } : {} ),
	};
}

/**
 * The rendition a static copy should play: the smallest one at least as wide
 * as the rendered player, among those a portable website can carry. When none
 * of the wide-enough renditions fit, the widest one that does. A rendition
 * whose size could not be read stays eligible; the export applies its own
 * limits to the file it downloads.
 */
export function selectWixVideoRendition(
	renditions: readonly WixVideoRendition[],
	renderedWidth: number,
	bytes: ReadonlyMap< string, number | undefined >,
	maxBytes: number = MAX_PORTABLE_MEDIA_BYTES,
): WixVideoRendition | undefined {
	const ordered = [ ...renditions ].sort( ( a, b ) => a.width - b.width || a.height - b.height );
	const portable = ordered.filter( ( rendition ) => {
		const size = bytes.get( rendition.url );
		return size === undefined || size <= maxBytes;
	} );
	return portable.find( ( rendition ) => rendition.width >= renderedWidth ) ?? portable[ portable.length - 1 ];
}

async function renditionBytes( page: Page, url: string ): Promise< number | undefined > {
	try {
		const response = await page.request.head( url, { timeout: HEAD_TIMEOUT_MS, maxRetries: 0 } );
		if ( ! response.ok() ) return undefined;
		const length = Number( response.headers()[ 'content-length' ] );
		return Number.isFinite( length ) && length > 0 ? length : undefined;
	} catch {
		return undefined;
	}
}

interface CollectedWixVideo {
	info: string;
	width: number;
	poster: string;
}

/**
 * Replace each Wix video player with a static `<video controls poster>`.
 * Returns how many players were replaced.
 */
export async function portWixVideoPlayers( page: Page ): Promise< number > {
	const collected = await page.evaluate( ( marker ) => {
		const players: Array< { info: string; width: number; poster: string } > = [];
		for ( const element of document.querySelectorAll( 'wow-video[data-video-info]' ) ) {
			element.removeAttribute( marker );
			// Only the player component: its root carries the `wixui-video…`
			// semantic class. A background video is a different contract.
			if ( ! element.closest( '[class*="wixui-video"]' ) ) continue;
			const image = element.querySelector( 'img' );
			element.setAttribute( marker, String( players.length ) );
			players.push( {
				info: element.getAttribute( 'data-video-info' ) ?? '',
				width: element.getBoundingClientRect().width,
				poster: image ? image.currentSrc || image.getAttribute( 'src' ) || '' : '',
			} );
		}
		return players;
	}, VIDEO_MARKER ) as CollectedWixVideo[];
	if ( collected.length === 0 ) return 0;

	const base = page.url();
	const records = collected.map( ( player ) => wixVideoRecord( player.info, base ) );
	const bytes = new Map< string, number | undefined >();
	for ( const record of records ) {
		for ( const { url } of record?.renditions ?? [] ) {
			if ( ! bytes.has( url ) ) bytes.set( url, await renditionBytes( page, url ) );
		}
	}
	const replacements = collected.map( ( player, index ) => {
		const record = records[ index ];
		const rendition = record && selectWixVideoRendition( record.renditions, player.width, bytes );
		if ( ! record || ! rendition ) return null;
		const poster = httpsUrl( player.poster, base ) ?? record.poster ?? '';
		return {
			src: rendition.url,
			width: rendition.width,
			height: rendition.height,
			poster,
			muted: ! record.hasAudio,
			loop: record.loop,
			focal: record.focalPoint ?? { x: 50, y: 50 },
		};
	} );

	return page.evaluate( ( { marker, replacements } ) => {
		let replaced = 0;
		for ( const element of document.querySelectorAll( `[${ marker }]` ) ) {
			const replacement = replacements[ Number( element.getAttribute( marker ) ) ];
			element.removeAttribute( marker );
			if ( ! replacement ) continue;
			const video = document.createElement( 'video' );
			video.setAttribute( 'src', replacement.src );
			if ( replacement.poster ) video.setAttribute( 'poster', replacement.poster );
			video.setAttribute( 'controls', '' );
			video.setAttribute( 'playsinline', '' );
			video.setAttribute( 'preload', 'metadata' );
			if ( replacement.muted ) video.setAttribute( 'muted', '' );
			if ( replacement.loop ) video.setAttribute( 'loop', '' );
			video.setAttribute( 'width', String( replacement.width ) );
			video.setAttribute( 'height', String( replacement.height ) );
			// The player filled its box with the video cropped about its focal
			// point; the static element keeps that box and crop.
			video.style.cssText = `display:block;width:100%;height:100%;object-fit:cover;object-position:${ replacement.focal.x }% ${ replacement.focal.y }%`;
			// The runtime's play button, spinner and control bar sit over the
			// video and answer to nothing once it is gone; the native controls
			// replace them. Keep only the path from the player root to the video.
			const root = element.closest( '[class*="wixui-video"]' );
			for ( let node: Element | null = element; node && node !== root; node = node.parentElement ) {
				for ( const sibling of [ ...( node.parentElement?.children ?? [] ) ] ) {
					if ( sibling !== node ) sibling.remove();
				}
			}
			element.replaceWith( video );
			replaced++;
		}
		return replaced;
	}, { marker: VIDEO_MARKER, replacements } );
}
