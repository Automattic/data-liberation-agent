import type { LiberationHooks } from '../page-actions.js';
import { preserveSquarespaceProductJsonLd } from './product-jsonld.js';

const VIDEO_MARKER = 'data-blocks-engine-capture-squarespace-video';

/**
 * The poster Squarespace publishes for one of its hosted videos.
 *
 * A native video block or video background carries its video record as JSON
 * in an attribute (`data-config-video`, `data-config-native-video`,
 * `data-current-context`). The record's `alexandriaUrl` is a rendition
 * template, `https://video.squarespace-cdn.com/content/v1/<library>/<asset>/{variant}`.
 * Its renditions are an HLS playlist of AES-128-encrypted MPEG-TS segments,
 * with no progressive MP4 to download, but the `thumbnail` variant is a
 * full-size JPEG still. Squarespace's own player uses it as `data-poster`.
 */
export function squarespaceVideoPoster( config: string ): string | undefined {
	const template = /"alexandriaUrl"\s*:\s*"([^"]+)"/.exec( config.replace( /&quot;|&#34;/g, '"' ) )?.[ 1 ];
	if ( ! template?.includes( '{variant}' ) ) return undefined;
	try {
		const url = new URL( template.replace( '{variant}', 'thumbnail' ) );
		return url.protocol === 'https:' && url.hostname === 'video.squarespace-cdn.com' ? url.href : undefined;
	} catch {
		return undefined;
	}
}

export const capture: LiberationHooks = {
	/** The captured default state leaves Squarespace's overlay navigation closed;
	 * its runtime-written top padding belongs to the menu, not page geometry. */
	prepare: async ( page ) => {
		await page.evaluate( () => {
			// Squarespace's header scroll-back controller can leave its fixed header
			// translated above the viewport during the geometry sweep. Normalize its
			// observed top-of-page state here, before measuring dependent clearances.
			const header = document.querySelector< HTMLElement >( 'header[data-test="header"]' );
			if ( header ) {
				// The lazy-load sweep scrolls through the page. Squarespace leaves
				// its scroll-derived `shrink` state latched after returning to scrollY=0;
				// the page a visitor freshly opens at the declared top pose has the
				// expanded header, whose height also determines the hero geometry.
				header.classList.remove( 'shrink' );
				let style = document.querySelector< HTMLStyleElement >( 'style[data-blocks-engine-capture-squarespace-header-style]' );
				if ( ! style ) {
					style = document.createElement( 'style' );
					style.setAttribute( 'data-blocks-engine-capture-squarespace-header-style', '' );
				}
				style.textContent = ':is(#data-blocks-engine-capture-squarespace-header-visible,header[data-test="header"]){transition:none!important;transform:none!important}';
				( document.body ?? document.head ?? document.documentElement ).append( style );
			}
			for ( const menu of document.querySelectorAll< HTMLElement >( '[data-test="header-menu"]' ) ) {
				if ( menu.style.getPropertyValue( 'padding-top' ) ) {
					menu.setAttribute( 'data-blocks-engine-capture-fluid-ignore-padding', '' );
				}
			}
		} );
		// Squarespace may also have committed collapsed-header geometry into its
		// runtime model while scrolling, which removing the presentation class
		// alone does not recompute. A desktop-width round trip makes its own
		// responsive controller reconcile that model with the current top pose.
		const viewport = page.viewportSize();
		if ( viewport && viewport.width < 1440 ) {
			await page.setViewportSize( { width: 1440, height: viewport.height } );
			await page.waitForTimeout( 250 );
			await page.setViewportSize( viewport );
			await page.waitForTimeout( 250 );
		}
	},
	/**
	 * A Squarespace-hosted video plays through an HLS player whose `blob:`
	 * source dies with the page session. The generic capture falls back to a
	 * still of the current frame. Give it the platform's own poster instead,
	 * when the video does not already declare one.
	 */
	beforeSerialize: async ( page, context ) => {
		await preserveSquarespaceProductJsonLd( page, context );
		await page.evaluate( () => {
			// Slideshow galleries size their slides' contents from script, once per
			// slide activation and never on resize, so serialized inline px would
			// freeze one width. Restate the runtime's rules relative to the slide.
			// Captions: width is the slide width, and a caption taller than 90% of
			// the slide gets `.overflow` and 40% of the slide height.
			// Images: the loader cover-fits each image into its slide-sized,
			// clipping fill and centres its focal point. The slide keeps one aspect
			// ratio at every width, so whether an image fills the slide's width or
			// its height is width-independent; the offset is relative to both boxes.
			const gallery = '.sqs-gallery-design-stacked .slide';
			if ( ! document.querySelector( gallery ) ) return;
			// The runtime replaces whole style attributes as slides cycle, so each
			// image's fit lives in the stylesheet, keyed by an attribute it keeps.
			const fill = 'data-blocks-engine-capture-squarespace-fill';
			const image = `${ gallery } :is(.content-fill,.sqs-video-overlay) > img`;
			const fits = new Map< string, string >();
			for ( const img of document.querySelectorAll< HTMLImageElement >( `${ image }[data-image-dimensions]` ) ) {
				const [ width, height ] = ( img.dataset.imageDimensions ?? '' ).split( 'x' ).map( Number );
				const box = img.parentElement!.getBoundingClientRect();
				if ( ! width || ! height || ! box.width || ! box.height ) continue;
				const [ x = 0.5, y = 0.5 ] = ( img.dataset.imageFocalPoint ?? '' ).split( ',' ).map( Number ).filter( Number.isFinite );
				const wide = width / height > box.width / box.height;
				const key = `${ wide ? 'height' : 'width' } ${ wide ? x : y } ${ width }x${ height }`;
				img.setAttribute( fill, key );
				const offset = `${ ( wide ? x : y ) * -100 }%`;
				fits.set( key, `aspect-ratio:${ width }/${ height };` + ( wide
					? `height:100%!important;width:auto!important;top:0!important;left:50%!important;transform:translateX(${ offset })!important`
					: `width:100%!important;height:auto!important;left:0!important;top:50%!important;transform:translateY(${ offset })!important` ) );
			}
			let style = document.querySelector< HTMLStyleElement >( 'style[data-blocks-engine-capture-squarespace-slideshow-style]' );
			if ( ! style ) {
				style = document.createElement( 'style' );
				style.setAttribute( 'data-blocks-engine-capture-squarespace-slideshow-style', '' );
				( document.body ?? document.head ?? document.documentElement ).append( style );
			}
			style.textContent = `${ gallery } > .meta{width:100%!important}${ gallery } > .meta.overflow{height:40%!important}`
				+ `${ image }[${ fill }]{position:relative!important;max-width:none!important}`
				+ [ ...fits ].map( ( [ key, css ] ) => `${ image }[${ fill }="${ key }"]{${ css }}` ).join( '' );
		} );
		const configs = await page.evaluate( ( marker ) => {
			const configs: string[] = [];
			for ( const video of document.querySelectorAll( 'video' ) ) {
				video.removeAttribute( marker );
				if ( ! /^blob:/i.test( video.currentSrc || video.getAttribute( 'src' ) || '' ) ) continue;
				if ( video.getAttribute( 'poster' )?.trim() || video.getAttribute( 'data-poster' )?.trim() ) continue;
				for ( let node = video.parentElement; node; node = node.parentElement ) {
					const config = [ ...node.attributes ].find( ( attribute ) =>
						attribute.value.includes( 'alexandriaUrl' )
					)?.value;
					if ( ! config ) continue;
					video.setAttribute( marker, String( configs.length ) );
					configs.push( config );
					break;
				}
			}
			return configs;
		}, VIDEO_MARKER );
		const posters = configs.map( ( config ) => squarespaceVideoPoster( config ) ?? '' );
		await page.evaluate(
			( { marker, posters } ) => {
				for ( const video of document.querySelectorAll( `video[${ marker }]` ) ) {
					const poster = posters[ Number( video.getAttribute( marker ) ) ];
					if ( poster ) video.setAttribute( 'poster', poster );
					video.removeAttribute( marker );
				}
			},
			{ marker: VIDEO_MARKER, posters }
		);
	},
};
