import type { Page } from 'playwright';

/** Screenshot-only media pose. Never changes authored autoplay/loop/poster attributes. */
export async function holdVideoFrames( page: Page ): Promise<void> {
	await page.evaluate( async () => {
		await Promise.all( [ ...document.querySelectorAll( 'video' ) ].map( video => new Promise<void>( resolve => {
			// A not-yet-started poster is already deterministic; do not replace it
			// with a decoded frame by forcing a load or a seek.
			const poster = video.paused && video.currentTime === 0 && video.poster;
			video.pause();
			if ( poster || video.error ) { resolve(); return; }
			const finish = () => {
				clearTimeout( timer );
				video.removeEventListener( 'loadedmetadata', seek );
				video.removeEventListener( 'loadeddata', ready );
				video.removeEventListener( 'seeked', ready );
				video.removeEventListener( 'error', finish );
				resolve();
			};
			const ready = () => { if ( ! video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ) finish(); };
			const seek = () => {
				try { video.currentTime = 0; } catch { finish(); return; } // Unseekable live streams have no zero frame.
				ready();
			};
			// Missing/failed media must not stall an entire reference cell.
			const timer = setTimeout( finish, 2_000 );
			video.addEventListener( 'loadedmetadata', seek );
			video.addEventListener( 'loadeddata', ready );
			video.addEventListener( 'seeked', ready );
			video.addEventListener( 'error', finish );
			if ( video.readyState >= HTMLMediaElement.HAVE_METADATA ) seek();
		} ) ) );
		// seeked/loadeddata precede compositor presentation of the decoded frame.
		if ( document.querySelector( 'video' ) ) await new Promise<void>( resolve => requestAnimationFrame( () => requestAnimationFrame( () => resolve() ) ) );
	} );
}
