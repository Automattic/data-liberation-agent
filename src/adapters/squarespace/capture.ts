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
