import type { Page } from 'playwright';

export const DROPDOWN_ANCESTOR_ATTRIBUTE_PATTERN = /^(?:class|style|hidden|aria-[a-z0-9-]+|data-(?!lib-|dla-)[a-z0-9_.:-]+)$/;

export interface CapturedDropdownAncestorState {
	status: 'verified' | 'unverified';
	reason?: string;
	ancestors: Array< {
		selector: string;
		tag: string;
		depth: number;
		closed: Record< string, string | null >;
		opened: Record< string, string | null >;
	} >;
	placement?: {
		parentSelector: string;
		parentDepth: number;
		beforeSelector: string | null;
		position: string;
	};
}

interface AncestorSnapshot {
	placement?: { parent: Element; before: Element | null };
	rows: Array< {
		node: Element;
		selector: string;
		tag: string;
		depth: number;
		closed: Record< string, string | null >;
		opened?: Record< string, string | null >;
	} >;
	reason?: string;
}
type CaptureGlobals = typeof globalThis & {
	__dlaPanelSelectors?: WeakMap< Element, string >;
	__dlaDropdownAncestors?: AncestorSnapshot;
};

/** Reuse identities recorded before source actions can mount or reorder nodes. */
export async function rememberDropdownAncestors( page: Page, triggerSelector: string ): Promise< void > {
	await page.locator( triggerSelector ).first().evaluate( ( trigger, pattern ) => {
		const globals = globalThis as CaptureGlobals;
		const allowed = new RegExp( pattern );
		const snapshot: AncestorSnapshot = { rows: [] };
		globals.__dlaDropdownAncestors = snapshot;
		let depth = 0;
		for ( let node = trigger.parentElement; node; node = node.parentElement ) {
			if ( ++depth > 8 ) { snapshot.reason = 'ancestor-limit'; break; }
			const selector = globals.__dlaPanelSelectors?.get( node );
			if ( !selector ) { snapshot.reason = 'source-identity-unavailable'; break; }
			const closed: Record< string, string | null > = {};
			for ( const attribute of Array.from( node.attributes ) ) {
				if ( allowed.test( attribute.name ) ) closed[ attribute.name ] = attribute.value;
			}
			if ( Object.keys( closed ).length > 32 ) { snapshot.reason = 'ancestor-attribute-count-limit'; break; }
			if ( Object.values( closed ).some( value => new TextEncoder().encode( value ?? '' ).length > 4096 ) ) {
				snapshot.reason = 'ancestor-attribute-limit'; break;
			}
			snapshot.rows.push( { node, selector, tag: node.tagName.toLowerCase(), depth, closed } );
			if ( node === document.body ) break;
		}
	}, DROPDOWN_ANCESTOR_ATTRIBUTE_PATTERN.source, { timeout: 1000 } ).catch( async () => {
		await page.evaluate( () => { ( globalThis as CaptureGlobals ).__dlaDropdownAncestors = { rows: [], reason: 'trigger-snapshot-unavailable' }; } ).catch( () => undefined );
	} );
}

/** Capture only local ancestor mutations, plus the observed source mount slot. */
export async function observeDropdownAncestors( page: Page, panelSelector: string ): Promise< CapturedDropdownAncestorState > {
	return page.locator( panelSelector ).first().evaluate( ( panel, pattern ) => {
		const globals = globalThis as CaptureGlobals;
		const allowed = new RegExp( pattern );
		const snapshot = globals.__dlaDropdownAncestors;
		const result: CapturedDropdownAncestorState = { status: 'unverified', ancestors: [] };
		if ( !snapshot || snapshot.reason ) {
			return { ...result, reason: snapshot?.reason ?? 'ancestor-snapshot-unavailable' };
		}
		for ( const row of snapshot.rows ) {
			if ( !row.node.isConnected ) return { ...result, reason: 'ancestor-replaced' };
			const opened: Record< string, string | null > = {};
			for ( const attribute of Array.from( row.node.attributes ) ) {
				if ( allowed.test( attribute.name ) ) opened[ attribute.name ] = attribute.value;
			}
			if ( Object.keys( opened ).length > 32 ) return { ...result, reason: 'ancestor-attribute-count-limit' };
			row.opened = opened;
			if ( Object.values( opened ).some( value => new TextEncoder().encode( value ?? '' ).length > 4096 ) ) {
				return { ...result, reason: 'ancestor-attribute-limit' };
			}
			// Spread, not Array.from: a legacy page library (Prototype.js) replaces
			// Array.from with one that returns [] for a Set.
			const changed = [ ...new Set( [ ...Object.keys( row.closed ), ...Object.keys( opened ) ] ) ].filter( name => ( row.closed[ name ] ?? null ) !== ( opened[ name ] ?? null ) );
			if ( changed.length > 32 ) return { ...result, reason: 'ancestor-attribute-count-limit' };
			if ( changed.length > 0 ) {
				result.ancestors.push( { selector: row.selector, tag: row.tag, depth: row.depth,
					closed: Object.fromEntries( changed.map( name => [ name, row.closed[ name ] ?? null ] ) ),
					opened: Object.fromEntries( changed.map( name => [ name, opened[ name ] ?? null ] ) ),
				} );
				if ( new TextEncoder().encode( JSON.stringify( result ) ).length > 32768 ) return { ...result, ancestors: [], reason: 'ancestor-state-byte-limit' };
			}
		}
		const parent = snapshot.rows.find( row => row.node === panel.parentElement );
		const before = panel.nextElementSibling;
		const beforeSelector = before ? globals.__dlaPanelSelectors?.get( before ) : null;
		if ( !parent || before && !beforeSelector ) return { ...result, reason: 'panel-slot-unproven' };
		snapshot.placement = { parent: parent.node, before };
		result.placement = { parentSelector: parent.selector, parentDepth: parent.depth, beforeSelector: beforeSelector ?? null, position: getComputedStyle( panel ).position };
		if ( new TextEncoder().encode( JSON.stringify( result ) ).length > 32768 ) return { status: 'unverified' as const, ancestors: [], reason: 'ancestor-state-byte-limit' };
		return result;
	}, DROPDOWN_ANCESTOR_ATTRIBUTE_PATTERN.source, { timeout: 1000 } ).catch( () => ( { status: 'unverified' as const, ancestors: [], reason: 'panel-snapshot-unavailable' } ) );
}

/** A captured transition is replayable only when source actions restore its owner. */
export async function verifyDropdownRestoration( page: Page, state: CapturedDropdownAncestorState, panelSelector: string ): Promise< CapturedDropdownAncestorState > {
	if ( state.reason ) return state;
	try {
		await page.waitForFunction( selector => {
			const snapshot = ( globalThis as CaptureGlobals ).__dlaDropdownAncestors;
			const panelVisible = Array.from( document.querySelectorAll( selector ) ).some( panel => {
				const rect = panel.getBoundingClientRect(), style = getComputedStyle( panel );
				let opacity = Number.parseFloat( style.opacity || '1' );
				for ( let parent = panel.parentElement; parent; parent = parent.parentElement ) opacity *= Number.parseFloat( getComputedStyle( parent ).opacity || '1' );
				return style.display !== 'none' && style.visibility !== 'hidden' && opacity > .1 &&
					Math.min( rect.right, innerWidth ) - Math.max( rect.left, 0 ) > 8 && Math.min( rect.bottom, innerHeight ) - Math.max( rect.top, 0 ) > 8;
			} );
			return Boolean( snapshot && snapshot.rows.every( row =>
				row.node.isConnected && document.querySelectorAll( row.selector ).length === 1 &&
				document.querySelector( row.selector ) === row.node &&
				[ ...new Set( [ ...Object.keys( row.closed ), ...Object.keys( row.opened ?? {} ) ] ) ].every( name => row.node.getAttribute( name ) === ( row.closed[ name ] ?? null ) )
			) && !panelVisible && ( !snapshot.placement?.before || snapshot.placement.before.isConnected && snapshot.placement.before.parentElement === snapshot.placement.parent ) );
		}, panelSelector, { timeout: 1000 } );
		return { ...state, status: 'verified' };
	} catch {
		return { ...state, reason: 'ancestor-restoration-unverified' };
	}
}
