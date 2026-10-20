/** Ignore only Chromium's unhandled media play/pause or reload lifecycle rejection. */
export function isMediaPlaybackLifecycleAbort( error: { name?: string; message?: string } ): boolean {
	return error.name === 'AbortError' && /The play\(\) request was interrupted by (?:a call to pause\(\)|a new load request)/i.test( error.message ?? '' );
}
