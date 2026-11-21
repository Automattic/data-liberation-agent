/**
 * Captured panel replay evidence: JSON in two attributes whose `html` fields,
 * at any depth, hold serialized markup (`{ html, style, class }` on a dialog
 * trigger; `{ resting: { html? }, opened: { html? } }` on a reused panel).
 * Canonicalizers that rewrite saved markup rewrite these fields too, so
 * replayed panels agree with the page around them.
 */
export const PANEL_REPLAY_ATTRIBUTES = [ 'data-blocks-engine-capture-dialog-panel-state', 'data-blocks-engine-capture-existing-panel' ] as const;

const TOO_DEEP = Symbol( 'too deep' );

/**
 * Rewrite every `html` string in a parsed replay value; everything else is
 * kept. With `maxDepth`, a value nested deeper is returned as is (the same
 * reference), unrewritten, instead of exhausting the stack.
 */
export function rewritePanelReplayHtml( value: unknown, rewrite: ( html: string ) => string, maxDepth = Infinity ): unknown {
	const walk = ( entry: unknown, depth: number ): unknown => {
		if ( depth > maxDepth ) return TOO_DEEP;
		if ( Array.isArray( entry ) ) {
			const items = [];
			for ( const item of entry ) {
				const next = walk( item, depth + 1 );
				if ( next === TOO_DEEP ) return TOO_DEEP;
				items.push( next );
			}
			return items;
		}
		if ( ! entry || typeof entry !== 'object' ) return entry;
		const fields: Array< [ string, unknown ] > = [];
		for ( const [ key, item ] of Object.entries( entry ) ) {
			const next = key === 'html' && typeof item === 'string' ? rewrite( item ) : walk( item, depth + 1 );
			if ( next === TOO_DEEP ) return TOO_DEEP;
			fields.push( [ key, next ] );
		}
		return Object.fromEntries( fields );
	};
	const result = walk( value, 0 );
	return result === TOO_DEEP ? value : result;
}
