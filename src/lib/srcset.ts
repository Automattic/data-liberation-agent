export interface SrcsetCandidate {
	url: string;
	size: number;
	density: boolean;
}

/** Preserve commas inside URL tokens; descriptors end at candidate separators. */
export function srcsetCandidates( value: string ): SrcsetCandidate[] {
	const candidates: SrcsetCandidate[] = [];
	let offset = 0;
	while ( offset < value.length ) {
		while ( offset < value.length && /[\s,]/.test( value[ offset ] ) ) offset++;
		if ( offset >= value.length ) break;
		const start = offset;
		while ( offset < value.length && ! /\s/.test( value[ offset ] ) ) offset++;
		const url = value.slice( start, offset ).replace( /,+$/, '' );
		const descriptorStart = offset;
		while ( offset < value.length && value[ offset ] !== ',' ) offset++;
		const descriptor = value.slice( descriptorStart, offset );
		if ( offset < value.length ) offset++;
		if ( ! url ) continue;
		const parsed = /(\d+(?:\.\d+)?)([wx])/i.exec( descriptor );
		candidates.push( {
			url,
			size: parsed ? Number( parsed[ 1 ] ) : 1,
			density: parsed?.[ 2 ].toLowerCase() === 'x',
		} );
	}
	return candidates;
}

export function srcsetReferences( value: string ): string[] {
	return srcsetCandidates( value ).map( ( candidate ) => candidate.url );
}
