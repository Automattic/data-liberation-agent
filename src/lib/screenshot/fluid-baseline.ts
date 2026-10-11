import type { Page } from 'playwright';

/** Capture-owned geometry belongs to a document role, not to a copied DOM id. */
export function captureFluidBaseline( page: Page, attribute: string ) {
	return page.evaluateHandle( attribute => {
		const pixel = ( value: string ) => /^-?\d+(?:\.\d+)?px$/.test( value.trim() ) ? Number.parseFloat( value ) : null;
		const elements = () => [ ...document.querySelectorAll<HTMLElement>( `[${ attribute }]` ) ];
		const element = ( id: string ) => document.querySelector<HTMLElement>( `[${ attribute }="${ id }"]` );
		const pureXTranslation = ( transform: string ) => {
			const matrix = /^matrix\(\s*([^)]*)\s*\)$/i.exec( transform )?.[ 1 ]?.split( ',' ).map( Number );
			if ( matrix && matrix.length === 6 && matrix.every( Number.isFinite ) &&
				Math.abs( matrix[ 0 ]! - 1 ) <= 0.01 && Math.abs( matrix[ 1 ]! ) <= 0.01 &&
				Math.abs( matrix[ 2 ]! ) <= 0.01 && Math.abs( matrix[ 3 ]! - 1 ) <= 0.01 && Math.abs( matrix[ 5 ]! ) <= 0.01 ) return matrix[ 4 ]!;
			const translated = /^translate(?:3d|x)?\(\s*(-?\d+(?:\.\d+)?)px(?:\s*,\s*0(?:px)?(?:\s*,\s*0(?:px)?)?)?\s*\)$/i.exec( transform );
			return translated ? Number( translated[ 1 ] ) : null;
		};
		// Keep both views: measurement interprets literal source declarations,
		// while tagging/rest read CSSOM and rest retains the whole transform.
		const readGeometry = ( node: HTMLElement ) => {
			const literal = node.getAttribute( 'style' ) ?? '';
			const transform = /(?:^|;)\s*transform\s*:\s*([^;]+)/i.exec( literal )?.[ 1 ]?.trim();
			const position = getComputedStyle( node ).position;
			const inset = position === 'absolute' ? /(?:^|;)\s*inset\s*:\s*(-?\d+(?:\.\d+)?)px\s+auto\s+auto\s+(-?\d+(?:\.\d+)?)px\s*(?:;|$)/.exec( literal ) : null;
			return { literal, style: node.style, position, parent: node.parentElement,
				inset: inset ? { top: Number( inset[ 1 ] ), left: Number( inset[ 2 ] ) } : null,
				translation: transform ? pureXTranslation( transform ) : null };
		};
		const translation = ( id: string ) => {
			const node = element( id );
			return node ? readGeometry( node ).translation : null;
		};
		interface Role {
			element: Element;
			style: string | null;
			identity: string | null;
			tag: string;
			id: string | null;
			role: string | null;
			classes: string[];
			children: Role[];
			parent?: Role;
			current?: Element;
			returned?: { element: Element; style: string | null; segment: string | null; state: string[] };
			authority?: Array<{ property: string; css: string; segmented: boolean }>;
			stateMatches?: boolean;
		}
		const roles: Role[] = [];
		let marking = true;
		const snapshot = ( element: Element, parent?: Role ): Role => {
			const role: Role = {
				element, style: element.getAttribute( 'style' ), identity: null,
				tag: element.tagName, id: element.getAttribute( 'id' ),
				role: element.getAttribute( 'role' ), classes: [ ...element.classList ], children: [], parent,
			};
			roles.push( role );
			role.children = [ ...element.children ].map( child => snapshot( child, role ) );
			return role;
		};
		const root = snapshot( document.documentElement );
		const scratch = document.createElement( 'span' );
		const geometry = [ 'width', 'height', 'font-size', 'padding-top', 'inset', 'top', 'left' ];
		const walk = ( role: Role, element: Element | undefined, restore: boolean, matched: Set<Element>, unlearnedOnly = false ) => {
			if ( ! element ) return;
			// Surviving objects prove their identity. A replacement must occupy the
			// same parent/child role and retain its source signature. In particular,
			// a spacer cloned from an active header must not borrow that header's id.
			if ( element !== role.element && ( element.tagName !== role.tag ||
				element.getAttribute( 'id' ) !== role.id || element.getAttribute( 'role' ) !== role.role ||
				role.classes.some( token => ! element.classList.contains( token ) ) ) ) return;
			matched.add( element );
			role.current = element;
			if ( ! marking || role.identity === null ) element.removeAttribute( attribute );
			else element.setAttribute( attribute, role.identity );
			const style = ( element as HTMLElement ).style;
			if ( restore && style && ( ! unlearnedOnly || role.identity === null ) ) {
				// Keep the final transform matrix for the learner's translation checks.
				scratch.style.cssText = role.style ?? '';
				const properties = new Set( [ ...geometry,
					...[ ...style, ...scratch.style ].filter( property => property.startsWith( '--' ) ),
				] );
				for ( const property of properties ) {
					const value = scratch.style.getPropertyValue( property );
					const priority = scratch.style.getPropertyPriority( property );
					if ( style.getPropertyValue( property ) === value && style.getPropertyPriority( property ) === priority ) continue;
					if ( value ) style.setProperty( property, value, priority );
					else style.removeProperty( property );
				}
				if ( role.style === null && style.cssText === '' ) {
					element.getAttribute( 'style' );
					element.removeAttribute( 'style' );
				}
			}
			// Main-world libraries can replace or delete Array.prototype.entries.
			for ( let index = 0; index < role.children.length; index++ ) {
				const child = role.children[ index ]!;
				const current = child.element.isConnected
					? child.element.parentElement === element ? child.element : undefined
					: element.children[ index ];
				walk( child, current, restore, matched, unlearnedOnly );
			}
		};
		const project = ( restore: boolean, unlearnedOnly = false ) => {
			const matched = new Set<Element>();
			for ( const role of roles ) role.current = undefined;
			walk( root, document.documentElement, restore, matched, unlearnedOnly );
			// An unproven new role cannot participate under an identity it copied.
			for ( const element of elements() ) {
				if ( ! matched.has( element ) ) element.removeAttribute( attribute );
			}
		};
		const state = ( element: Element ) => [
			[ ...element.classList ].sort().join( ' ' ),
			String( element.hasAttribute( 'hidden' ) ),
			...['aria-hidden', 'aria-expanded'].map( key => JSON.stringify( element.getAttribute( key ) ) ),
		];
		return {
			pixel, elements, element, readGeometry, translation,
			bind: () => { for ( const role of roles ) role.identity = role.element.getAttribute( attribute ); },
			reconcile: () => project( false ),
			restore: ( unlearnedOnly = false ) => project( true, unlearnedOnly ),
			activate: ( entries: Array<{ id: string; property: string; css: string; segmented: boolean }>, segmentAttribute: string, captureWidth: number | undefined ) => {
				project( false );
				for ( const role of roles ) {
					const element = role.current;
					if ( ! element ) continue;
					role.returned = { element, style: element.getAttribute( 'style' ), segment: element.getAttribute( segmentAttribute ), state: state( element ) };
					role.authority = entries.filter( entry => entry.id === role.identity );
				}
				const observer = new MutationObserver( () => {
					project( false );
					for ( const role of roles ) {
						const element = role.current as HTMLElement | undefined;
						const returned = role.returned;
						if ( ! element || ! returned ) { role.stateMatches = false; continue; }
						role.stateMatches = ( ! role.parent || role.parent.stateMatches === true ) && state( element ).every( ( value, index ) => value === returned.state[index] );
						// Opening controls is source behavior, not a rewrite of captured
						// geometry. Captured rules resume when that baseline state returns.
						if ( ! role.stateMatches ) {
							if ( returned.segment !== null ) element.removeAttribute( segmentAttribute );
							continue;
						}
						if ( element !== returned.element && document.documentElement.clientWidth === captureWidth ) {
							// A late clone (including screenshot-driven resizes) inherits its
							// own finalized width/insets, never the active source role's.
							scratch.style.cssText = returned.style ?? '';
							for ( const property of ['width', 'inset', 'top', 'left'] ) {
								const value = scratch.style.getPropertyValue( property );
								const priority = scratch.style.getPropertyPriority( property );
								if ( element.style.getPropertyValue( property ) === value && element.style.getPropertyPriority( property ) === priority ) continue;
								if ( value ) element.style.setProperty( property, value, priority );
								else element.style.removeProperty( property );
							}
							if ( returned.segment === null ) element.removeAttribute( segmentAttribute );
							else element.setAttribute( segmentAttribute, returned.segment );
							returned.element = element;
						}
						for ( const entry of role.authority ?? [] ) {
							const value = element.style.getPropertyValue( entry.property );
							if ( entry.segmented ) {
								if ( value !== '' ) element.style.removeProperty( entry.property );
							} else if ( value !== entry.css ) element.style.setProperty( entry.property, entry.css );
						}
					}
				} );
				observer.observe( document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'aria-expanded'] } );
			},
			cleanup: () => {
				marking = false;
				for ( const role of roles ) role.element.removeAttribute( attribute );
				for ( const element of elements() ) element.removeAttribute( attribute );
			},
		};
	}, attribute );
}
