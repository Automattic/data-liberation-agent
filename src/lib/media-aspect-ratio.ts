interface MediaDimensions {
	width?: number;
	height?: number;
}

/** Whether measured dimensions prove two files have the same crop. */
export function sameMediaAspectRatio( first: MediaDimensions, second: MediaDimensions ): boolean {
	const { width, height } = first;
	const { width: otherWidth, height: otherHeight } = second;
	// Each measured edge can be rounded by half a pixel. Compare
	// cross-products so small resizes need no arbitrary ratio epsilon.
	return !! ( width && height && otherWidth && otherHeight &&
		Math.abs( width * otherHeight - height * otherWidth ) <=
		( width + height + otherWidth + otherHeight ) / 2 );
}
