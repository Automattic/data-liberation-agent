/** Runs in the page: only already-hidden frames earn a bounded reveal wait. */
export function waitForHiddenEmbeds( timeoutMs = 5_000 ): Promise<void> {
	const hidden = ( frame: HTMLIFrameElement ) => {
		const style = getComputedStyle( frame );
		return style.display === 'none' || style.visibility === 'hidden';
	};
	const frames = Array.from( document.querySelectorAll<HTMLIFrameElement>( 'iframe' ) ).filter( hidden );
	if ( ! frames.length ) return Promise.resolve();
	return new Promise<void>( resolve => {
		const finish = () => {
			observer.disconnect();
			clearTimeout( timer );
			resolve();
		};
		const observer = new MutationObserver( () => {
			if ( frames.every( frame => ! frame.isConnected || ! hidden( frame ) ) ) finish();
		} );
		const timer = setTimeout( finish, timeoutMs );
		observer.observe( document.documentElement, { subtree: true, attributes: true, childList: true } );
	} );
}
