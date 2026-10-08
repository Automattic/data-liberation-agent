/** Current native properties and authored reset defaults are separate facts.
 * Markup retains authored attributes; this versioned, inert contract carries
 * properties which HTML cannot express independently of those defaults.
 */
export type NativeControlState =
	| { version: 1; kind: 'input'; type: string; value: string; defaultValue: string; checked: boolean; defaultChecked: boolean; indeterminate: boolean }
	| { version: 1; kind: 'textarea'; value: string; defaultValue: string }
	| { version: 1; kind: 'select'; options: Array< { selected: boolean; defaultSelected: boolean } > }
	| { version: 1; kind: 'file' };

export const NATIVE_CONTROL_STATE_ATTRIBUTE = 'data-dla-native-control-state';

/** Closure-free browser primitive, also used by capture's serialization task. */
export function observeNativeControlState( control: Element ): NativeControlState | null {
	if ( control instanceof HTMLInputElement ) {
		if ( control.type === 'file' ) return { version: 1, kind: 'file' };
		return { version: 1, kind: 'input', type: control.type, value: control.value, defaultValue: control.defaultValue,
			checked: control.checked, defaultChecked: control.defaultChecked, indeterminate: control.indeterminate };
	}
	if ( control instanceof HTMLTextAreaElement ) return { version: 1, kind: 'textarea', value: control.value, defaultValue: control.defaultValue };
	if ( control instanceof HTMLSelectElement ) return { version: 1, kind: 'select', options: Array.from( control.options,
		option => ( { selected: option.selected, defaultSelected: option.defaultSelected } ) ) };
	return null;
}

/** Fixed offline interpreter. No source code, selectors or property names are
 * executable inputs. Restore once; native form.reset() subsequently owns reset.
 * This function is closure-free so capture and portable export share its bytes.
 */
export function restoreNativeControlState( root: Document ): void {
	const inputs: Array< { control: HTMLInputElement; state: Extract< NativeControlState, { kind: 'input' } > } > = [];
	for ( const control of root.querySelectorAll( 'input[data-dla-native-control-state],textarea[data-dla-native-control-state],select[data-dla-native-control-state]' ) ) {
		let state: NativeControlState;
		try { state = JSON.parse( control.getAttribute( 'data-dla-native-control-state' )! ); } catch { continue; }
		if ( ! state || state.version !== 1 ) continue;
		if ( control instanceof HTMLInputElement && state.kind === 'input' && control.type !== 'file' && state.type === control.type &&
			typeof state.value === 'string' && typeof state.defaultValue === 'string' && typeof state.checked === 'boolean' &&
			typeof state.defaultChecked === 'boolean' && typeof state.indeterminate === 'boolean' ) {
			// Avoid introducing absent attributes when the default already matches.
			if ( control.defaultValue !== state.defaultValue ) control.defaultValue = state.defaultValue;
			if ( control.defaultChecked !== state.defaultChecked ) control.defaultChecked = state.defaultChecked;
			if ( control.value !== state.value ) control.value = state.value;
			inputs.push( { control, state } );
		} else if ( control instanceof HTMLTextAreaElement && state.kind === 'textarea' &&
			typeof state.value === 'string' && typeof state.defaultValue === 'string' ) {
			// Also recovers textarea defaults after an intermediate HTML parser has
			// consumed a leading LF. Defaults are never replaced by current values.
			if ( control.defaultValue !== state.defaultValue ) control.defaultValue = state.defaultValue;
			control.value = state.value;
		} else if ( control instanceof HTMLSelectElement && state.kind === 'select' && Array.isArray( state.options ) &&
			state.options.length === control.options.length && state.options.every( option => option &&
				typeof option.selected === 'boolean' && typeof option.defaultSelected === 'boolean' ) &&
			( control.multiple || state.options.filter( option => option.selected ).length <= 1 ) ) {
			state.options.forEach( ( option, index ) => {
				if ( control.options[ index ]!.defaultSelected !== option.defaultSelected ) control.options[ index ]!.defaultSelected = option.defaultSelected;
			} );
			control.selectedIndex = -1;
			state.options.forEach( ( option, index ) => { control.options[ index ]!.selected = option.selected; } );
		}
	}
	// Clear radio peers before selecting the observed winners, including groups
	// with no selected member. Form ownership remains entirely browser-native.
	for ( const { control } of inputs ) control.checked = false;
	for ( const { control, state } of inputs ) { control.checked = state.checked; control.indeterminate = state.indeterminate; }
}

export const NATIVE_CONTROL_STATE_RUNTIME = `(${ restoreNativeControlState.toString() })(document);`;

/** Install owned code after sanitization, never whitelist a source script by its
 * marker. String insertion avoids another lossy textarea parse/serialization.
 * A body-end script restores all properties synchronously before load.
 */
export function wireNativeControlState( html: string ): string {
	const clean = html.replace( /<script\b[^>]*\bdata-dla-native-control-runtime\b[^>]*>[\s\S]*?<\/script\s*>/gi, '' );
	if ( ! clean.includes( `${ NATIVE_CONTROL_STATE_ATTRIBUTE }=` ) ) return clean;
	const script = `<script data-dla-native-control-runtime>${ NATIVE_CONTROL_STATE_RUNTIME }</script>`;
	return /<\/body\s*>/i.test( clean ) ? clean.replace( /<\/body\s*>/i, `${ script }</body>` ) : clean + script;
}
