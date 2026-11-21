/**
 * Captured panel replay evidence: JSON in two attributes whose `html` fields,
 * at any depth, hold serialized markup (`{ html, style, class }` on a dialog
 * trigger; `{ resting: { html? }, opened: { html? } }` on a reused panel).
 * Canonicalizers that rewrite saved markup rewrite these fields too, so
 * replayed panels agree with the page around them.
 */
export const PANEL_REPLAY_ATTRIBUTES = [ 'data-blocks-engine-capture-dialog-panel-state', 'data-blocks-engine-capture-existing-panel' ] as const;

/** Rewrite every `html` string in a parsed replay value; everything else is kept. */
export function rewritePanelReplayHtml( value: unknown, rewrite: ( html: string ) => string ): unknown {
	if ( Array.isArray( value ) ) return value.map( entry => rewritePanelReplayHtml( entry, rewrite ) );
	if ( ! value || typeof value !== 'object' ) return value;
	return Object.fromEntries( Object.entries( value ).map( ( [ key, entry ] ) =>
		[ key, key === 'html' && typeof entry === 'string' ? rewrite( entry ) : rewritePanelReplayHtml( entry, rewrite ) ] ) );
}
