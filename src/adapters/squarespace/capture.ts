import type { LiberationHooks } from '../page-actions.js';

const VIDEO_MARKER = 'data-dla-squarespace-video';

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
				let style = document.querySelector< HTMLStyleElement >( 'style[data-dla-squarespace-header-style]' );
				if ( ! style ) {
					style = document.createElement( 'style' );
					style.setAttribute( 'data-dla-squarespace-header-style', '' );
				}
				style.textContent = ':is(#dla-squarespace-header-visible,header[data-test="header"]){transition:none!important;transform:none!important}';
				( document.body ?? document.head ?? document.documentElement ).append( style );
			}
			for ( const menu of document.querySelectorAll< HTMLElement >( '[data-test="header-menu"]' ) ) {
				if ( menu.style.getPropertyValue( 'padding-top' ) ) {
					menu.setAttribute( 'data-dla-fluid-ignore-padding', '' );
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
	beforeSerialize: async ( page ) => {
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
