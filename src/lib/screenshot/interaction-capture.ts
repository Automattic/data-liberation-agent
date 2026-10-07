import type { Page } from 'playwright';
import type { CapturedGallery } from './gallery-capture.js';
import { sweepSourceCleanup } from '../source-cleanup.js';
import { rememberDropdownAncestors, observeDropdownAncestors, verifyDropdownRestoration, type CapturedDropdownAncestorState } from './dropdown-ancestor-state.js';

export const INTERACTION_STATES_SCHEMA = 'data-liberation/interaction-states/v2';
export const LEGACY_INTERACTION_STATES_SCHEMA = 'data-liberation/interaction-states/v1';

const MAX_TRIGGERS = 8;
/** Plain buttons with no popup semantics that may still open a dialog; probed last. */
const MAX_PLAIN_BUTTON_PROBES = 4;
/** Labelled header/nav buttons that may reveal a link panel on activation; probed after declared popups. */
const MAX_NAV_DROPDOWN_PROBES = 6;
const MAX_INITIAL_DIALOGS = 8;
const MAX_DIALOG_HTML_BYTES = 512 * 1024;
const DIALOG_WAIT_MS = 2_000;
const POPUP_HASPOPUP = [ 'dialog', 'listbox', 'menu', 'tree', 'grid' ];
const MAX_ROUTE_CONTROLS = 12;

export interface CapturedRouteNavigation {
	selector: string;
	id?: string;
	label: string;
	siblings: string[];
	url: string;
}

/** Observe the result of clicking visible navigation buttons, never infer a route from a label. */
export async function captureRouteNavigation( page: Page, sourceUrl: string ): Promise< CapturedRouteNavigation[] > {
	const candidates = await page.evaluate( ( limit: number ) => {
		return Array.from( document.querySelectorAll< HTMLButtonElement >( 'nav button,[role="navigation"] button' ) )
			.filter( button => {
				const rect = button.getBoundingClientRect();
				const style = getComputedStyle( button );
				return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight &&
					style.display !== 'none' && style.visibility !== 'hidden' && ! button.disabled &&
					! button.closest( 'form,a,[hidden],[inert]' ) &&
					! button.matches( '[aria-haspopup],[aria-expanded],[aria-controls],[role="tab"],[aria-pressed]' ) &&
					! button.querySelector( 'a' );
			} ).slice( 0, limit ).map( button => {
				const parts: string[] = [];
				for ( let node: Element | null = button; node && node !== document.body; node = node.parentElement ) {
					const siblings = Array.from( node.parentElement?.children ?? [] ).filter( sibling => sibling.tagName === node!.tagName );
					parts.unshift( `${ node.tagName.toLowerCase() }:nth-of-type(${ siblings.indexOf( node ) + 1 })` );
				}
				return {
					selector: `body > ${ parts.join( ' > ' ) }`,
					...( button.id ? { id: button.id } : {} ),
					label: ( button.getAttribute( 'aria-label' ) || button.textContent || '' ).replace( /\s+/g, ' ' ).trim(),
					siblings: Array.from( button.parentElement?.children ?? [] ).filter( child => child.tagName === 'BUTTON' )
						.map( child => ( child.getAttribute( 'aria-label' ) || child.textContent || '' ).replace( /\s+/g, ' ' ).trim() ),
				};
			} );
	}, MAX_ROUTE_CONTROLS );
	const original = new URL( sourceUrl );
	const routes: CapturedRouteNavigation[] = [];
	for ( const candidate of candidates ) {
		if ( ! candidate.label || page.url() !== sourceUrl ) break;
		try {
			await page.locator( candidate.selector ).click( { timeout: 1_000 } );
			await page.waitForFunction( ( before: string ) => location.href !== before, sourceUrl, { timeout: 500 } ).catch( () => undefined );
			const after = new URL( page.url() );
			if ( after.origin !== original.origin || after.href === original.href || after.pathname === original.pathname && after.search === original.search ) continue;
			routes.push( { ...candidate, url: after.href } );
			await page.evaluate( () => history.back() );
			await page.waitForURL( sourceUrl, { timeout: 1_000 } );
			// A router may replace its navigation nodes on back; do not apply stale selectors.
			await page.waitForTimeout( 200 );
		} catch {
			if ( page.url() !== sourceUrl ) break;
		}
	}
	return routes;
}
const POPUP_SURFACE_SELECTOR =
	'dialog,[role="dialog"],[aria-modal="true"],[role="listbox"],[role="menu"],[role="tree"],[role="grid"],nav,[class*="header-menu"]';
const SEMANTIC_POPUP_SELECTOR =
	'dialog,[role="dialog"],[aria-modal="true"],[role="listbox"],[role="menu"],[role="tree"],[role="grid"]';

export interface CapturedDialogInteraction {
	status: 'captured' | 'no-dialog' | 'click-failed';
	/**
	 * Distinguishes an in-page disclosure/accordion panel (content restored in
	 * place, before HTML serialization — see `hydrateDisclosureContent`) from a
	 * runtime-created popup/menu dialog (wired post-hoc by `wireCapturedDialogs`
	 * onto the authored trigger), from a selectable set whose
	 * members drive one shared region (`selectable-set`), and from a choice group
	 * whose members change their own attributes or styles (`choice-group`), and
	 * a finite image cycle with an observed image-opened lightbox (`gallery`). Omitted/`'dialog'`
	 * preserves the pre-existing shape for callers that predate this field.
	 */
	kind?: 'dialog' | 'disclosure' | 'selectable-set' | 'choice-group' | 'typed-search' | 'gallery';
	/** Directional replay requires a complete cycle, inverse edges and source restoration. */
	gallery?: { inline: CapturedGallery; lightbox?: CapturedGallery; closed?: boolean; selection?: number[] };
	collectionFilter?: import('./typed-search-capture.js').CapturedCollectionFilter;
	trigger: {
		selector: string;
		tag: string;
		id?: string;
		role?: string;
		ariaHaspopup: string;
		ariaControls?: string;
		label?: string;
		dataBindings: Record< string, string >;
	};
	dialog?: {
		selector: string;
		tag: string;
		id?: string;
		role?: string;
		ariaModal: boolean;
		ariaLabel?: string;
		presentation?: 'modal' | 'dropdown';
		html: string;
		htmlBytes: number;
		htmlTruncated: boolean;
		/**
		 * Stylesheet rules the page added while this panel opened (for example a
		 * runtime utility-CSS engine compiling the panel's classes). The page's
		 * serialized styles predate the panel, so without these it renders unstyled.
		 */
		css?: string;
		/** Observed local ancestor transitions and panel placement, verified by source restoration. */
		ancestorState?: CapturedDropdownAncestorState;
	};
	/**
	 * Present on `kind: 'selectable-set'` states. `size` is how many members
	 * were recognised; `index` is this member's document order. Driving may
	 * stop before `size` when a cap is hit.
	 */
	set?: {
		selector: string;
		size: number;
		index: number;
	};
	/**
	 * Present on captured `kind: 'choice-group'` states. This is observed
	 * evidence, not a guessed form-value model: absent source values and
	 * selection semantics are represented as `null`.
	 */
	choiceGroup?: {
		group: {
			selector: string;
			tag: string;
			id?: string;
			label?: string;
			labelSelector?: string;
			formSelector?: string;
		};
		choices: Array< {
			index: number;
			selector: string;
			tag: string;
			id?: string;
			role?: string;
			label?: string;
			value: string | null;
		} >;
		transition: {
			selectedIndex: number;
			selected: Array< boolean | null >;
			html: string;
			htmlBytes: number;
			htmlTruncated: boolean;
		};
		/** Replay is emitted only when bounded histories show activation-determined transitions. */
		replay: 'activation-determined' | 'unsupported';
		replayReason?: string;
		/** Whether source actions restored the live group without replacing its nodes. */
		restoration: 'verified' | 'unverified';
		/** Partial drives are evidence only and cannot be replayed as complete groups. */
		coverage: 'complete' | 'partial';
	};
	error?: string;
}

export interface CapturedInitialDialog {
	status: 'captured' | 'no-close-control' | 'dismissal-unverified';
	/** This evidence is intentionally separate from trigger-opened dialog states. */
	initiallyVisible: true;
	dialog: NonNullable< CapturedDialogInteraction[ 'dialog' ] >;
	dismissal?: {
		control: { selector: string; tag: string; label?: string };
		verified: boolean;
	};
	error?: string;
}

export interface InteractionStatesReport {
	schema: typeof INTERACTION_STATES_SCHEMA | typeof LEGACY_INTERACTION_STATES_SCHEMA;
	sourceUrl: string;
	viewport: { width: number; height: number };
	capturedAt: string;
	states: CapturedDialogInteraction[];
	routeNavigation?: CapturedRouteNavigation[];
	/** Dialogs already visible after the page's normal runtime settling. */
	initialDialogs?: CapturedInitialDialog[];
}

interface TriggerDescriptor {
	index: number;
	selector: string;
	probeSelector: string;
	tag: string;
	id?: string;
	role?: string;
	ariaHaspopup: string;
	ariaControls?: string;
	label?: string;
	dataBindings: Record< string, string >;
}

interface DialogDescriptor {
	selector: string;
	tag: string;
	id?: string;
	role?: string;
	ariaModal: boolean;
	ariaLabel?: string;
	/** `dropdown` when the panel opens in page flow or anchored, not as a viewport-covering overlay. */
	presentation?: 'modal' | 'dropdown';
	html: string;
}

interface CloseControlDescriptor {
	selector: string;
	tag: string;
	label?: string;
}

/** Capture user-triggered dialogs after all baseline page artifacts are complete. */
export async function captureTriggeredDialogs(
	page: Page,
	sourceUrl: string
): Promise< InteractionStatesReport > {
	const viewport = page.viewportSize() ?? { width: 0, height: 0 };
	await rememberBaselinePanels( page );
	const initialDialogs = await captureInitiallyVisibleDialogs( page );
	const triggers = ( await page.evaluate( ( { limit, popupTypes, plainLimit, navLimit }: { limit: number; popupTypes: string[]; plainLimit: number; navLimit: number } ) => {
		const visible = ( element: Element ): boolean => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle( element );
			return (
				rect.width > 0 &&
				rect.height > 0 &&
				style.display !== 'none' &&
				style.visibility !== 'hidden' &&
				Number.parseFloat( style.opacity || '1' ) > 0.1
			);
		};
		const cssEscape = ( value: string ) =>
			globalThis.CSS?.escape
				? globalThis.CSS.escape( value )
				: value.replace( /[^a-zA-Z0-9_-]/g, '\\$&' );
		const sourceSelector = ( element: Element ): string => {
			if ( element.id ) return `#${ cssEscape( element.id ) }`;
			const parts: string[] = [];
			for (
				let node: Element | null = element;
				node && node !== document.body;
				node = node.parentElement
			) {
				const tag = node.tagName.toLowerCase();
				const siblings = node.parentElement
					? Array.from( node.parentElement.children ).filter(
							( sibling ) => sibling.tagName === node!.tagName
					  )
					: [];
				parts.unshift(
					siblings.length > 1 ? `${ tag }:nth-of-type(${ siblings.indexOf( node ) + 1 })` : tag
				);
			}
			return `body > ${ parts.join( ' > ' ) }`;
		};
		const probeSelector = ( element: Element, index: number ): string => {
			if ( element.id ) return `#${ cssEscape( element.id ) }`;
			element.setAttribute( 'data-lib-interaction-trigger', String( index ) );
			return `[data-lib-interaction-trigger="${ index }"]`;
		};
		const isPlainActionButton = ( element: Element ): boolean => {
			if ( element.tagName !== 'BUTTON' && element.getAttribute( 'role' ) !== 'button' ) return false;
			if ( element.hasAttribute( 'disabled' ) || element.getAttribute( 'aria-disabled' ) === 'true' ) return false;
			// Controls that declare any state or relationship are probed (or captured) elsewhere.
			if ( element.matches( '[aria-haspopup],[aria-expanded],[aria-controls],[aria-pressed],[aria-selected],[aria-checked]' ) ) return false;
			const type = ( element.getAttribute( 'type' ) ?? '' ).toLowerCase();
			if ( type === 'submit' || type === 'reset' ) return false;
			if ( element.closest( 'form,nav,li,[role="navigation"],[role="tablist"],[role="menu"],[role="listbox"],[role="dialog"],dialog,header' ) ) return false;
			// A list item or a row of sibling buttons is a selectable set, not a single opener.
			const siblingButtons = Array.from( element.parentElement?.children ?? [] ).filter(
				( sibling ) => sibling.tagName === 'BUTTON' || sibling.getAttribute( 'role' ) === 'button'
			);
			if ( siblingButtons.length > 1 ) return false;
			if ( ( element.textContent ?? '' ).replace( /\s+/g, '' ).length === 0 ) return false;
			// Scroll-reveal sections start at opacity 0 until scrolled into view; the probe
			// click scrolls them in, so only layout presence is required here.
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle( element );
			return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
		};
		// A navigation item that is a button rather than a link opens a panel of
		// links (React-state dropdowns). It declares no popup semantics, so it is
		// recognized by where it sits and by being a short text label. A chevron
		// icon only orders the likelier openers first.
		const isNavDropdownButton = ( element: Element ): boolean => {
			if ( element.tagName !== 'BUTTON' && element.getAttribute( 'role' ) !== 'button' ) return false;
			if ( element.hasAttribute( 'disabled' ) || element.getAttribute( 'aria-disabled' ) === 'true' ) return false;
			if ( ! element.closest( 'header,nav,[role="navigation"]' ) ) return false;
			if ( element.closest( 'form,[role="dialog"],dialog,[role="menu"]' ) ) return false;
			const type = ( element.getAttribute( 'type' ) ?? '' ).toLowerCase();
			if ( type === 'submit' || type === 'reset' ) return false;
			const text = ( element.textContent ?? '' ).replace( /\s+/g, ' ' ).trim();
			if ( text.length === 0 || text.length > 30 ) return false;
			return visible( element );
		};
		const navDropdowns = Array.from( document.querySelectorAll( 'button,[role="button"]' ) )
			.filter( isNavDropdownButton )
			.sort( ( a, b ) => Number( b.querySelector( 'svg' ) !== null ) - Number( a.querySelector( 'svg' ) !== null ) )
			.slice( 0, navLimit );
		const plain = Array.from( document.querySelectorAll( 'button,[role="button"]' ) )
			.filter( isPlainActionButton )
			.slice( 0, plainLimit );
		const candidates = Array.from(
			document.querySelectorAll(
				'button[aria-haspopup],a[aria-haspopup],[role="button"][aria-haspopup],[role="combobox"],button,[role="button"]'
			)
		).filter( ( element ) => {
			if ( element.getAttribute( 'aria-disabled' ) === 'true' ) return false;
			if ( ! visible( element ) ) return false;
			const name = (
				element.getAttribute( 'aria-label' ) ||
				element.textContent ||
				''
			).replace( /\s+/g, ' ' );
			const popup = ( element.getAttribute( 'aria-haspopup' ) ?? '' ).toLowerCase();
			// `aria-haspopup="true"` is an ambiguous legacy alias for a menu.
			// Probe it only when the control also declares a collapsed/expanded
			// state; a visible newly revealed panel is still required to capture.
			if ( popupTypes.includes( popup ) || ( popup === 'true' && element.hasAttribute( 'aria-expanded' ) ) ) {
				const hasBinding =
					Boolean( element.getAttribute( 'aria-controls' ) ) ||
					Array.from( element.attributes ).some(
						( attribute ) =>
							/^data-(?:popup|modal|dialog)(?:id|target)?$/i.test( attribute.name ) &&
							Boolean( attribute.value )
					);
				const href = element.tagName === 'A' ? ( element.getAttribute( 'href' ) ?? '' ).trim() : '';
				if ( href && href !== '#' && ! href.startsWith( '#' ) && ! hasBinding ) return false;
				return true;
			}
			// A menu control is a menu control whether authored as <button> or as
			// role="button" (site builders often render the latter).
			const isButton = element.tagName === 'BUTTON' || element.getAttribute( 'role' ) === 'button';
			return element.getAttribute( 'role' ) === 'combobox' || ( isButton && /\bmenu\b/i.test( name ) );
		} );

		const ordered = [ ...candidates ];
		for ( const element of [ ...navDropdowns, ...plain ] ) {
			if ( ! ordered.includes( element ) ) ordered.push( element );
		}
		return ordered.slice( 0, limit ).map( ( element, index ) => {
			const dataBindings: Record< string, string > = {};
			for ( const attribute of Array.from( element.attributes ) ) {
				if (
					/^data-(?:popup|modal|dialog)(?:id|target)?$/i.test( attribute.name ) &&
					attribute.value
				) {
					dataBindings[ attribute.name.toLowerCase() ] = attribute.value;
				}
			}
			return {
				index,
				selector: sourceSelector( element ),
				probeSelector: probeSelector( element, index ),
				tag: element.tagName.toLowerCase(),
				...( element.id ? { id: element.id } : {} ),
				...( element.getAttribute( 'role' ) ? { role: element.getAttribute( 'role' )! } : {} ),
				ariaHaspopup: element.getAttribute( 'aria-haspopup' ) ?? '',
				label: (
					element.getAttribute( 'aria-label' ) ||
					element.textContent ||
					''
				)
					.replace( /\s+/g, ' ' )
					.trim()
					.slice( 0, 40 ),
				...( element.getAttribute( 'aria-controls' )
					? { ariaControls: element.getAttribute( 'aria-controls' )! }
					: {} ),
				dataBindings,
			};
		} );
	}, { limit: MAX_TRIGGERS, popupTypes: POPUP_HASPOPUP, plainLimit: MAX_PLAIN_BUTTON_PROBES, navLimit: MAX_NAV_DROPDOWN_PROBES } ) ) as TriggerDescriptor[];

	const states: CapturedDialogInteraction[] = [];
	for ( const trigger of triggers ) {
		// Probe an opening transition even when the source rests expanded. Restore
		// that resting state afterwards; closing a tall in-flow menu reveals body
		// content by displacement, which is not popup evidence.
		const initiallyExpanded = await page.locator( trigger.probeSelector ).first().getAttribute( 'aria-expanded' ).catch( () => null ) === 'true';
		if ( initiallyExpanded ) {
			await activateTrigger( page, trigger.probeSelector ).catch( () => undefined );
			await page.waitForTimeout( 100 );
			if ( await page.locator( trigger.probeSelector ).first().getAttribute( 'aria-expanded' ).catch( () => null ) === 'true' ) {
				states.push( { status: 'no-dialog', trigger: triggerRecord( trigger ) } );
				continue;
			}
		}
		let before: string[] = [];
		try {
			await activateTrigger( page, trigger.probeSelector, async () => {
				before = await visibleDialogSelectors( page );
				await markVisibleBeforeActivation( page );
				await rememberDropdownAncestors( page, trigger.probeSelector );
			} );
		} catch ( error ) {
			const intercepting = await describeInterceptingElement( page, trigger.probeSelector );
			states.push( {
				status: 'click-failed',
				trigger: triggerRecord( trigger ),
				error: formatClickFailure( error, intercepting ),
			} );
			if ( initiallyExpanded ) await restoreExpandedTrigger( page, trigger.probeSelector );
			continue;
		}

		let dialog: DialogDescriptor | undefined;
		const deadline = Date.now() + DIALOG_WAIT_MS;
		do {
			// Source cleanup removes provider dialogs as they open, but its
			// observer has a budget a busy page can spend before the probes run.
			// Sweep explicitly so a policy-removed dialog is never recorded.
			await sweepSourceCleanup( page ).catch( () => undefined );
			dialog = await firstNewVisibleDialog( page, before, trigger.probeSelector );
			if ( dialog ) break;
			await page.waitForTimeout( 100 );
		} while ( Date.now() < deadline );

		if ( ! dialog ) {
			states.push( { status: 'no-dialog', trigger: triggerRecord( trigger ) } );
			await page.keyboard.press( 'Escape' ).catch( () => undefined );
			if ( initiallyExpanded ) await restoreExpandedTrigger( page, trigger.probeSelector );
			continue;
		}
		await waitForDialogContentStable( page, dialog.selector );
		const presentation = dialog.presentation;
		const baselineSelector = await page.locator( dialog.selector ).first().evaluate( element =>
			( globalThis as unknown as { __dlaPanelSelectors?: WeakMap< Element, string > } ).__dlaPanelSelectors?.get( element )
		);
		dialog = ( await snapshotDialog( page, dialog.selector ) ) ?? dialog;
		if ( presentation && ! dialog.presentation ) dialog = { ...dialog, presentation };

		const bounded = boundHtml( dialog.html );
		const addedCss = await rulesAddedSinceActivation( page );
		const ancestorState = dialog.presentation === 'dropdown' ? await observeDropdownAncestors( page, dialog.selector ) : undefined;
		await closeCapturedDialog( page, dialog.selector, trigger.probeSelector );
		const restoredAncestorState = ancestorState ? await verifyDropdownRestoration( page, ancestorState, dialog.selector ) : undefined;
		states.push( {
			status: 'captured',
			trigger: triggerRecord( trigger ),
			dialog: {
				selector: baselineSelector ?? dialog.selector,
				tag: dialog.tag,
				...( dialog.id ? { id: dialog.id } : {} ),
				...( dialog.role ? { role: dialog.role } : {} ),
				ariaModal: dialog.ariaModal,
				...( dialog.ariaLabel ? { ariaLabel: dialog.ariaLabel } : {} ),
				...( dialog.presentation ? { presentation: dialog.presentation } : {} ),
				html: bounded.html,
				htmlBytes: bounded.bytes,
				htmlTruncated: bounded.truncated,
				...( addedCss ? { css: addedCss } : {} ),
				...( restoredAncestorState ? { ancestorState: restoredAncestorState } : {} ),
			},
		} );

		if ( initiallyExpanded ) await restoreExpandedTrigger( page, trigger.probeSelector );
	}

	await page.evaluate( () => {
		delete ( globalThis as unknown as { __dlaPanelSelectors?: WeakMap< Element, string > } ).__dlaPanelSelectors;
		delete ( globalThis as unknown as { __dlaDropdownAncestors?: unknown } ).__dlaDropdownAncestors;
		for ( const element of document.querySelectorAll( '[data-lib-interaction-trigger]' ) ) {
			element.removeAttribute( 'data-lib-interaction-trigger' );
		}
		for ( const element of document.querySelectorAll( '[data-lib-interaction-dialog]' ) ) {
			element.removeAttribute( 'data-lib-interaction-dialog' );
		}
		for ( const element of document.querySelectorAll( '[data-lib-visible-before],[data-lib-offscreen-pos],[data-lib-motion-reveal]' ) ) {
			element.removeAttribute( 'data-lib-visible-before' );
			element.removeAttribute( 'data-lib-offscreen-pos' );
			element.removeAttribute( 'data-lib-motion-reveal' );
		}
		for ( const element of document.querySelectorAll( '[data-lib-initial-dialog],[data-lib-initial-close]' ) ) {
			element.removeAttribute( 'data-lib-initial-dialog' );
			element.removeAttribute( 'data-lib-initial-close' );
		}
	} );

	return {
		schema: INTERACTION_STATES_SCHEMA,
		sourceUrl,
		viewport,
		capturedAt: new Date().toISOString(),
		states,
		...( initialDialogs.length > 0 ? { initialDialogs } : {} ),
	};
}

async function restoreExpandedTrigger( page: Page, selector: string ): Promise< void > {
	if ( await page.locator( selector ).first().getAttribute( 'aria-expanded' ).catch( () => null ) !== 'true' ) {
		await activateTrigger( page, selector ).catch( () => undefined );
	}
}

async function captureInitiallyVisibleDialogs( page: Page ): Promise< CapturedInitialDialog[] > {
	await sweepSourceCleanup( page ).catch( () => undefined );
	const dialogs = await visibleSemanticDialogs( page );
	const states: CapturedInitialDialog[] = [];
	for ( const dialog of dialogs.slice( 0, MAX_INITIAL_DIALOGS ) ) {
		await waitForDialogContentStable( page, dialog.selector );
		const snapshot = ( await snapshotDialog( page, dialog.selector ) ) ?? dialog;
		const bounded = boundHtml( snapshot.html );
		const capturedDialog = {
			selector: snapshot.selector,
			tag: snapshot.tag,
			...( snapshot.id ? { id: snapshot.id } : {} ),
			...( snapshot.role ? { role: snapshot.role } : {} ),
			ariaModal: snapshot.ariaModal,
			...( snapshot.ariaLabel ? { ariaLabel: snapshot.ariaLabel } : {} ),
			html: bounded.html,
			htmlBytes: bounded.bytes,
			htmlTruncated: bounded.truncated,
		};
		const close = await findCloseControl( page, dialog.selector );
		if ( ! close ) {
			states.push( { status: 'no-close-control', initiallyVisible: true, dialog: capturedDialog } );
			continue;
		}
		try {
			await page.locator( close.selector ).first().click( { timeout: 1_000 } );
			await page.waitForTimeout( 100 );
			const verified = !( await page.locator( dialog.selector ).first().isVisible().catch( () => false ) );
			states.push( {
				status: verified ? 'captured' : 'dismissal-unverified',
				initiallyVisible: true,
				dialog: capturedDialog,
				dismissal: { control: close, verified },
			} );
		} catch ( error ) {
			states.push( {
				status: 'dismissal-unverified',
				initiallyVisible: true,
				dialog: capturedDialog,
				dismissal: { control: close, verified: false },
				error: boundedError( error ),
			} );
		}
	}
	return states;
}

function triggerRecord( trigger: TriggerDescriptor ): CapturedDialogInteraction[ 'trigger' ] {
	return {
		selector: trigger.selector,
		tag: trigger.tag,
		...( trigger.id ? { id: trigger.id } : {} ),
		...( trigger.role ? { role: trigger.role } : {} ),
		ariaHaspopup: trigger.ariaHaspopup,
		...( trigger.ariaControls ? { ariaControls: trigger.ariaControls } : {} ),
		...( trigger.label ? { label: trigger.label } : {} ),
		dataBindings: trigger.dataBindings,
	};
}

async function visibleDialogSelectors( page: Page ): Promise< string[] > {
	return page.evaluate(
		( { surfaceSelector, semanticSelector }: { surfaceSelector: string; semanticSelector: string } ) => {
			const visible = ( element: Element ): boolean => {
				const rect = element.getBoundingClientRect();
				const style = getComputedStyle( element );
				let opacity = Number.parseFloat( style.opacity || '1' );
				for ( let ancestor = element.parentElement; ancestor && opacity > 0.1; ancestor = ancestor.parentElement ) {
					opacity *= Number.parseFloat( getComputedStyle( ancestor ).opacity || '1' );
				}
				return (
					rect.width > 0 &&
					rect.height > 0 &&
					style.display !== 'none' &&
					style.visibility !== 'hidden' &&
					opacity > 0.1
				);
			};
			const selector = ( element: Element, index: number ): string => {
				if ( element.id ) {
					const id = globalThis.CSS?.escape
						? globalThis.CSS.escape( element.id )
						: element.id.replace( /[^a-zA-Z0-9_-]/g, '\\$&' );
					return `#${ id }`;
				}
				return `dialog-candidate:${ index }`;
			};
			return Array.from( document.querySelectorAll( surfaceSelector ) )
				.filter( visible )
				.filter( ( element ) => {
					const rect = element.getBoundingClientRect();
					return element.matches( semanticSelector ) || rect.width * rect.height > 40_000;
				} )
				.map( selector );
		},
		{ surfaceSelector: POPUP_SURFACE_SELECTOR, semanticSelector: SEMANTIC_POPUP_SELECTOR }
	);
}

async function visibleSemanticDialogs( page: Page ): Promise< DialogDescriptor[] > {
	return page.evaluate( ( limit: number ) => {
		const visible = ( element: Element ): boolean => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle( element );
			return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
				style.visibility !== 'hidden' && Number.parseFloat( style.opacity || '1' ) > 0.1;
		};
		const cssEscape = ( value: string ) => globalThis.CSS?.escape
			? globalThis.CSS.escape( value ) : value.replace( /[^a-zA-Z0-9_-]/g, '\\$&' );
		return Array.from( document.querySelectorAll( 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]' ) )
			.filter( visible )
			.slice( 0, limit )
			.map( ( dialog, index ) => {
				const selector = dialog.id
					? `#${ cssEscape( dialog.id ) }`
					: `[data-lib-initial-dialog="${ index }"]`;
				if ( !dialog.id ) dialog.setAttribute( 'data-lib-initial-dialog', String( index ) );
				const clone = dialog.cloneNode( true ) as Element;
				clone.removeAttribute( 'data-lib-initial-dialog' );
				for ( const unsafe of Array.from( clone.querySelectorAll( 'script,style,noscript,iframe' ) ) ) unsafe.remove();
				for ( const element of [ clone, ...Array.from( clone.querySelectorAll( '*' ) ) ] ) {
					for ( const attribute of Array.from( element.attributes ) ) {
						if ( /^on/i.test( attribute.name ) ) element.removeAttribute( attribute.name );
					}
				}
				return {
					selector,
					tag: dialog.tagName.toLowerCase(),
					...( dialog.id ? { id: dialog.id } : {} ),
					...( dialog.getAttribute( 'role' ) ? { role: dialog.getAttribute( 'role' )! } : {} ),
					ariaModal: dialog.getAttribute( 'aria-modal' ) === 'true',
					...( dialog.getAttribute( 'aria-label' ) ? { ariaLabel: dialog.getAttribute( 'aria-label' )! } : {} ),
					html: clone.outerHTML,
				};
			} );
	}, MAX_INITIAL_DIALOGS ) as Promise< DialogDescriptor[]>;
}

async function findCloseControl(
	page: Page,
	dialogSelector: string
): Promise< CloseControlDescriptor | undefined > {
	return page.locator( dialogSelector ).first().evaluate( ( dialog ) => {
		const control = Array.from( dialog.querySelectorAll(
			'[aria-label*="close" i],[title*="close" i],button[class*="close" i],[data-dismiss],[data-testid*="close" i]'
		) ).find( ( element ) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle( element );
			return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
		} );
		if ( !control ) return undefined;
		if ( control.id ) return {
			selector: `#${ globalThis.CSS?.escape ? globalThis.CSS.escape( control.id ) : control.id }`,
			tag: control.tagName.toLowerCase(),
			...( ( control.getAttribute( 'aria-label' ) || control.textContent?.trim() )
				? { label: ( control.getAttribute( 'aria-label' ) || control.textContent!.trim() ).slice( 0, 80 ) }
				: {} ),
		};
		const index = document.querySelectorAll( '[data-lib-initial-close]' ).length;
		control.setAttribute( 'data-lib-initial-close', String( index ) );
		return {
			selector: `[data-lib-initial-close="${ index }"]`,
			tag: control.tagName.toLowerCase(),
			...( ( control.getAttribute( 'aria-label' ) || control.textContent?.trim() )
				? { label: ( control.getAttribute( 'aria-label' ) || control.textContent!.trim() ).slice( 0, 80 ) }
				: {} ),
		};
	} ).catch( () => undefined );
}

/** Rules present now that were not present when the trigger was activated. */
async function rulesAddedSinceActivation( page: Page ): Promise< string > {
	const css = await page.evaluate( () => {
		const before = new Set( ( globalThis as unknown as { __dlaRulesBefore?: string[] } ).__dlaRulesBefore ?? [] );
		const added: string[] = [];
		for ( const sheet of Array.from( document.styleSheets ) ) {
			try {
				for ( const rule of Array.from( sheet.cssRules ) ) {
					if ( ! before.has( rule.cssText ) ) added.push( rule.cssText );
				}
			} catch {
				// Unreadable (cross-origin) sheet.
			}
		}
		return added.join( '\n' );
	} ).catch( () => '' );
	return Buffer.byteLength( css ) <= MAX_DIALOG_HTML_BYTES ? css : '';
}

async function rememberBaselinePanels( page: Page ): Promise< void > {
	await page.evaluate( () => {
		// Record authored identities before activation can mount or reorder nodes.
		// Temporary probe attributes are absent from the serialized baseline.
		const selectors = new WeakMap< Element, string >();
		selectors.set( document.body, 'body' );
		for ( const element of document.body.querySelectorAll( '*' ) ) {
			const siblings = Array.from( element.parentElement!.children ).filter( sibling => sibling.tagName === element.tagName );
			const tag = element.tagName.toLowerCase();
			selectors.set( element, element.id ? `#${ CSS.escape( element.id ) }` :
				`${ selectors.get( element.parentElement! ) } > ${ tag }:nth-of-type(${ siblings.indexOf( element ) + 1 })` );
		}
		( globalThis as unknown as { __dlaPanelSelectors?: WeakMap< Element, string > } ).__dlaPanelSelectors = selectors;
	} );
}

/**
 * Mark visibility and offscreen document positions before activation. Newly
 * shown content and positioned drawers are distinct from flow displacement.
 */
async function markVisibleBeforeActivation( page: Page ): Promise< void > {
	await page.evaluate( () => {
		const rules: string[] = [];
		for ( const sheet of Array.from( document.styleSheets ) ) {
			try {
				for ( const rule of Array.from( sheet.cssRules ) ) rules.push( rule.cssText );
			} catch {
				// Cross-origin sheets are captured with the page, not here.
			}
		}
		( globalThis as unknown as { __dlaRulesBefore?: string[] } ).__dlaRulesBefore = rules;
		for ( const element of document.querySelectorAll( '[data-lib-visible-before],[data-lib-offscreen-pos]' ) ) {
			element.removeAttribute( 'data-lib-visible-before' );
			element.removeAttribute( 'data-lib-offscreen-pos' );
		}
		// Same rule as the post-activation check, including an ancestor's
		// opacity: a menu faded in by its wrapper was not visible before.
		const opacityOf = new Map< Element, number >();
		const effectiveOpacity = ( element: Element ): number => {
			const known = opacityOf.get( element );
			if ( known !== undefined ) return known;
			const own = Number.parseFloat( getComputedStyle( element ).opacity || '1' );
			const value = own * ( element.parentElement ? effectiveOpacity( element.parentElement ) : 1 );
			opacityOf.set( element, value );
			return value;
		};
		const inViewport = ( rect: DOMRect ): boolean =>
			rect.bottom > 0 &&
			rect.right > 0 &&
			rect.top < window.innerHeight &&
			rect.left < window.innerWidth;
		for ( const element of Array.from( document.body?.querySelectorAll( '*' ) ?? [] ) ) {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle( element );
			if ( rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && effectiveOpacity( element ) > 0.1 ) {
				element.setAttribute( 'data-lib-visible-before', '' );
				if ( ! inViewport( rect ) ) {
					element.setAttribute(
						'data-lib-offscreen-pos',
						`${ Math.round( rect.left + window.scrollX ) },${ Math.round( rect.top + window.scrollY ) }`
					);
				}
			}
		}
	} ).catch( () => undefined );
}

async function firstNewVisibleDialog(
	page: Page,
	before: string[],
	triggerSelector: string
): Promise< DialogDescriptor | undefined > {
	return page.evaluate( ( { existing, surfaceSelector, semanticSelector, triggerSelector }: { existing: string[]; surfaceSelector: string; semanticSelector: string; triggerSelector: string } ) => {
		const visible = ( element: Element ): boolean => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle( element );
			// A descendant's own opacity can be 1 while its opening menu is transparent.
			let opacity = Number.parseFloat( style.opacity || '1' );
			for ( let ancestor = element.parentElement; ancestor && opacity > 0.1; ancestor = ancestor.parentElement ) {
				opacity *= Number.parseFloat( getComputedStyle( ancestor ).opacity || '1' );
			}
			return (
				rect.width > 0 &&
				rect.height > 0 &&
				style.display !== 'none' &&
				style.visibility !== 'hidden' &&
				opacity > 0.1
			);
		};
		const selector = ( element: Element, index: number ): string => {
			if ( element.id ) {
				const id = globalThis.CSS?.escape
					? globalThis.CSS.escape( element.id )
					: element.id.replace( /[^a-zA-Z0-9_-]/g, '\\$&' );
				return `#${ id }`;
			}
			return `dialog-candidate:${ index }`;
		};
		const candidates = Array.from( document.querySelectorAll( surfaceSelector ) );
		const trigger = document.querySelector( triggerSelector );
		if ( trigger?.getAttribute( 'aria-expanded' ) === 'false' ) return undefined;
		const controlled = ( trigger?.getAttribute( 'aria-controls' ) ?? '' ).split( /\s+/ ).map( id => document.getElementById( id ) );
		const marked = document.querySelector( '[data-lib-visible-before]' ) !== null;
		const wasVisible = ( element: Element, index: number ): boolean =>
			marked ? element.hasAttribute( 'data-lib-visible-before' ) : existing.includes( selector( element, index ) );
		let owned = controlled.find( ( element ) => element && visible( element ) && !element.hasAttribute( 'data-lib-visible-before' ) );
		while ( owned?.parentElement && owned.parentElement !== document.body && !owned.parentElement.hasAttribute( 'data-lib-visible-before' ) ) owned = owned.parentElement;
		const surface = owned ?? candidates.find( ( element, index ) => {
			if ( ! visible( element ) || wasVisible( element, index ) ) return false;
			if ( element.matches( semanticSelector ) ) return true;
			const rect = element.getBoundingClientRect();
			return rect.width * rect.height > 40_000;
		} );
		// Otherwise the outermost element the activation revealed that holds
		// interactive content: an in-flow menu panel is often a plain <div>.
		const revealed = surface ?? ( marked ? Array.from( document.body.querySelectorAll( '*' ) ).find( ( element ) =>
			! element.hasAttribute( 'data-lib-visible-before' ) &&
			visible( element ) &&
			( element.parentElement === null || element.parentElement.hasAttribute( 'data-lib-visible-before' ) ) &&
			element.querySelector( 'a[href],button' ) !== null
		) : undefined );
		const intersectionArea = ( rect: DOMRect ): number => {
			const width = Math.min( rect.right, window.innerWidth ) - Math.max( rect.left, 0 );
			const height = Math.min( rect.bottom, window.innerHeight ) - Math.max( rect.top, 0 );
			return Math.max( 0, width ) * Math.max( 0, height );
		};
		const slidIntoView = ( element: Element ): boolean => {
			const pos = element.getAttribute( 'data-lib-offscreen-pos' );
			if ( ! pos || element.hasAttribute( 'data-lib-interaction-trigger' ) || element.closest( '[data-lib-interaction-trigger]' ) ) return false;
			if ( ! visible( element ) ) return false;
			const rect = element.getBoundingClientRect();
			if ( intersectionArea( rect ) < 10_000 ) return false;
			// Flow displacement is not a drawer animation. A movement-only fallback
			// needs an owned target, popup semantics, or its own positioned/transform box.
			const style = getComputedStyle( element );
			if ( !controlled.includes( element as HTMLElement ) && !element.matches( semanticSelector ) &&
				style.position !== 'fixed' && style.position !== 'absolute' && style.transform === 'none' ) return false;
			const [ left, top ] = pos.split( ',' ).map( ( value ) => Number.parseFloat( value ) );
			const moved =
				Math.abs( rect.left + window.scrollX - left ) > 48 ||
				Math.abs( rect.top + window.scrollY - top ) > 48;
			return moved && element.querySelector( 'a[href],button,[role="button"]' ) !== null;
		};
		const moved = revealed ?? ( marked
			? Array.from( document.querySelectorAll( '[data-lib-offscreen-pos]' ) ).find( ( element ) => {
				if ( ! slidIntoView( element ) ) return false;
				const parent = element.parentElement;
				return parent === null || ! slidIntoView( parent );
			} )
			: undefined );
		if ( moved && moved !== revealed ) moved.setAttribute( 'data-lib-motion-reveal', '' );
		const dialog = moved;
		if ( ! dialog ) return undefined;
		const dialogSelector = dialog.id
			? selector( dialog, candidates.indexOf( dialog ) )
			: '[data-lib-interaction-dialog="captured"]';
		if ( ! dialog.id ) dialog.setAttribute( 'data-lib-interaction-dialog', 'captured' );
		const clone = dialog.cloneNode( true ) as HTMLElement;
		clone.removeAttribute( 'data-lib-interaction-dialog' );
		clone.removeAttribute( 'data-lib-motion-reveal' );
		clone.removeAttribute( 'data-lib-offscreen-pos' );
		clone.removeAttribute( 'data-lib-visible-before' );
		if ( dialog.hasAttribute( 'data-lib-motion-reveal' ) ) {
			const position = getComputedStyle( dialog ).position;
			clone.style.removeProperty( 'transform' );
			clone.style.setProperty( 'transform', 'translateX(0)', 'important' );
			clone.style.setProperty( 'visibility', 'visible', 'important' );
			clone.style.setProperty( 'opacity', '1', 'important' );
			if ( position === 'fixed' || position === 'absolute' ) {
				clone.style.setProperty( 'position', 'relative', 'important' );
				clone.style.setProperty( 'inset', 'auto', 'important' );
				clone.style.setProperty( 'left', 'auto', 'important' );
				clone.style.setProperty( 'right', 'auto', 'important' );
				clone.style.setProperty( 'top', 'auto', 'important' );
				clone.style.setProperty( 'bottom', 'auto', 'important' );
			}
		}
		for ( const marked of Array.from( clone.querySelectorAll( '[data-lib-visible-before],[data-lib-offscreen-pos],[data-lib-motion-reveal]' ) ) ) {
			marked.removeAttribute( 'data-lib-visible-before' );
			marked.removeAttribute( 'data-lib-offscreen-pos' );
			marked.removeAttribute( 'data-lib-motion-reveal' );
		}
		for ( const unsafe of Array.from( clone.querySelectorAll( 'script,style,noscript,iframe' ) ) )
			unsafe.remove();
		for ( const element of [ clone, ...Array.from( clone.querySelectorAll( '*' ) ) ] ) {
			for ( const attribute of Array.from( element.attributes ) ) {
				if ( /^on/i.test( attribute.name ) ) element.removeAttribute( attribute.name );
			}
		}
		return {
			selector: dialogSelector,
			tag: dialog.tagName.toLowerCase(),
			...( dialog.id ? { id: dialog.id } : {} ),
			...( dialog.getAttribute( 'role' ) ? { role: dialog.getAttribute( 'role' )! } : {} ),
			ariaModal: dialog.getAttribute( 'aria-modal' ) === 'true',
			...( dialog.getAttribute( 'aria-label' )
				? { ariaLabel: dialog.getAttribute( 'aria-label' )! }
				: {} ),
			presentation: ( () => {
				if ( dialog.getAttribute( 'aria-modal' ) === 'true' || dialog.matches( 'dialog[open]:modal' ) ) return 'modal' as const;
				const rect = dialog.getBoundingClientRect();
				const fixed = getComputedStyle( dialog ).position === 'fixed';
				return fixed && rect.width * rect.height >= 0.6 * window.innerWidth * window.innerHeight ? 'modal' as const : 'dropdown' as const;
			} )(),
			html: clone.outerHTML,
		};
	}, {
		existing: before,
		triggerSelector,
		surfaceSelector: POPUP_SURFACE_SELECTOR,
		semanticSelector: SEMANTIC_POPUP_SELECTOR,
	} ) as Promise< DialogDescriptor | undefined >;
}

async function closeCapturedDialog( page: Page, selector: string, triggerSelector?: string ): Promise< void > {
	await page.keyboard.press( 'Escape' ).catch( () => undefined );
	await page.waitForTimeout( 100 );
	if ( ! ( await panelIntersectsViewport( page, selector ) ) ) return;
	const close = page
		.locator( selector )
		.first()
		.locator(
			'[aria-label*="close" i],[title*="close" i],button[class*="close" i],[data-dismiss],[data-close],[data-testid*="close" i]'
		)
		.first();
	if ( await close.isVisible().catch( () => false ) ) {
		await close.click( { timeout: 1_000 } ).catch( () => undefined );
		await page.waitForTimeout( 100 );
	}
	if ( triggerSelector && ( await panelIntersectsViewport( page, selector ) ) ) {
		await page.locator( triggerSelector ).first().click( { timeout: 1_000 } ).catch( () => undefined );
	}
}

async function panelIntersectsViewport( page: Page, selector: string ): Promise< boolean > {
	return page
		.locator( selector )
		.first()
		.evaluate( ( element ) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle( element );
			if ( style.display === 'none' || style.visibility === 'hidden' ) return false;
			const width = Math.min( rect.right, window.innerWidth ) - Math.max( rect.left, 0 );
			const height = Math.min( rect.bottom, window.innerHeight ) - Math.max( rect.top, 0 );
			return width > 8 && height > 8;
		}, undefined, { timeout: 1_000 } )
		.catch( () => false );
}

async function waitForDialogContentStable( page: Page, selector: string ): Promise< void > {
	let previous = -1;
	let stableSamples = 0;
	const deadline = Date.now() + DIALOG_WAIT_MS;
	while ( Date.now() < deadline ) {
		await page.waitForTimeout( 150 );
		const bytes = await page
			.locator( selector )
			.first()
			.evaluate( ( element ) => new TextEncoder().encode( element.outerHTML ).length )
			.catch( () => -1 );
		if ( bytes > 0 && bytes === previous ) stableSamples++;
		else stableSamples = 0;
		if ( stableSamples >= 2 ) return;
		previous = bytes;
	}
}

async function snapshotDialog(
	page: Page,
	selector: string
): Promise< DialogDescriptor | undefined > {
	return page
		.locator( selector )
		.first()
		.evaluate( ( dialog, capturedSelector ) => {
			const clone = dialog.cloneNode( true ) as HTMLElement;
			clone.removeAttribute( 'data-lib-interaction-dialog' );
			clone.removeAttribute( 'data-lib-motion-reveal' );
			clone.removeAttribute( 'data-lib-offscreen-pos' );
			clone.removeAttribute( 'data-lib-visible-before' );
			if ( dialog.hasAttribute( 'data-lib-motion-reveal' ) ) {
				const position = getComputedStyle( dialog ).position;
				clone.style.removeProperty( 'transform' );
				clone.style.setProperty( 'transform', 'translateX(0)', 'important' );
				clone.style.setProperty( 'visibility', 'visible', 'important' );
				clone.style.setProperty( 'opacity', '1', 'important' );
				if ( position === 'fixed' || position === 'absolute' ) {
					clone.style.setProperty( 'position', 'relative', 'important' );
					clone.style.setProperty( 'inset', 'auto', 'important' );
					clone.style.setProperty( 'left', 'auto', 'important' );
					clone.style.setProperty( 'right', 'auto', 'important' );
					clone.style.setProperty( 'top', 'auto', 'important' );
					clone.style.setProperty( 'bottom', 'auto', 'important' );
				}
			}
			for ( const marked of Array.from( clone.querySelectorAll( '[data-lib-visible-before],[data-lib-offscreen-pos],[data-lib-motion-reveal]' ) ) ) {
				marked.removeAttribute( 'data-lib-visible-before' );
				marked.removeAttribute( 'data-lib-offscreen-pos' );
				marked.removeAttribute( 'data-lib-motion-reveal' );
			}
			// The portable disclosure's block fallback must not collapse flex/grid
			// layouts whose descendants rely on the opened root's layout mode.
			clone.style.setProperty( 'display', getComputedStyle( dialog ).display, 'important' );
			// A runtime-owned ancestor can gate the root's visibility in CSS.
			// Preserve the observed opened root, just as we preserve its display;
			// portable hidden/resting state still owns closing the captured panel.
			clone.style.setProperty( 'visibility', getComputedStyle( dialog ).visibility, 'important' );
			for ( const unsafe of Array.from( clone.querySelectorAll( 'script,style,noscript,iframe' ) ) )
				unsafe.remove();
			for ( const element of [ clone, ...Array.from( clone.querySelectorAll( '*' ) ) ] ) {
				for ( const attribute of Array.from( element.attributes ) ) {
					if ( /^on/i.test( attribute.name ) ) element.removeAttribute( attribute.name );
				}
			}
			return {
				selector: capturedSelector,
				tag: dialog.tagName.toLowerCase(),
				...( dialog.id ? { id: dialog.id } : {} ),
				...( dialog.getAttribute( 'role' ) ? { role: dialog.getAttribute( 'role' )! } : {} ),
				ariaModal: dialog.getAttribute( 'aria-modal' ) === 'true',
				...( dialog.getAttribute( 'aria-label' )
					? { ariaLabel: dialog.getAttribute( 'aria-label' )! }
					: {} ),
				html: clone.outerHTML,
			};
		}, selector )
		.catch( () => undefined );
}

function boundHtml( html: string ): { html: string; bytes: number; truncated: boolean } {
	const bytes = Buffer.byteLength( html );
	if ( bytes <= MAX_DIALOG_HTML_BYTES ) return { html, bytes, truncated: false };
	const bounded = Buffer.from( html ).subarray( 0, MAX_DIALOG_HTML_BYTES ).toString();
	return { html: bounded, bytes, truncated: true };
}

function boundedError( error: unknown ): string {
	return ( error instanceof Error ? error.message : String( error ) ).slice( 0, 500 );
}

function formatClickFailure( error: unknown, intercepting: string | undefined ): string {
	const base = boundedError( error );
	if ( ! intercepting ) return base;
	return `Click intercepted by ${ intercepting }. ${ base }`.slice( 0, 500 );
}

async function describeInterceptingElement(
	page: Page,
	probeSelector: string
): Promise< string | undefined > {
	return page
		.locator( probeSelector )
		.first()
		.evaluate( ( element ) => {
			const rect = element.getBoundingClientRect();
			const hit = document.elementFromPoint(
				rect.left + rect.width / 2,
				rect.top + rect.height / 2
			);
			if ( ! hit || hit === element || element.contains( hit ) ) return undefined;
			const className =
				typeof ( hit as HTMLElement ).className === 'string'
					? ( hit as HTMLElement ).className.trim().replace( /\s+/g, ' ' )
					: '';
			const parts = [
				hit.id ? `id="${ hit.id }"` : '',
				className ? `class="${ className.slice( 0, 80 ) }"` : '',
			].filter( Boolean );
			return `<${ hit.tagName.toLowerCase() }${ parts.length ? ` ${ parts.join( ' ' ) }` : '' }>`;
		} )
		.catch( () => undefined );
}

export async function activateTrigger( page: Page, probeSelector: string, baseline?: () => Promise< void > ): Promise< void > {
	const locator = page.locator( probeSelector ).first();
	await locator.scrollIntoViewIfNeeded( { timeout: DIALOG_WAIT_MS } ).catch( () => undefined );
	// Native activation scrolls nested containers as well as the window. Those
	// layout movements precede the action; they are not revealed popup evidence.
	await baseline?.();
	await page.evaluate( () => {
		const preventSubmit = ( event: Event ) => event.preventDefault();
		document.addEventListener( 'submit', preventSubmit, true );
		( document as Document & { __dlaPreventSubmit?: EventListener } ).__dlaPreventSubmit = preventSubmit;
	} );
	try {
		if ( ! ( await describeInterceptingElement( page, probeSelector ) ) ) {
			try {
				if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await locator.tap({timeout:DIALOG_WAIT_MS});
				else await locator.click( { timeout: DIALOG_WAIT_MS } );
				return;
			} catch {
				/* Coordinate click failed; fall through to a node-targeted click. */
			}
		}
		await locator.evaluate( ( element ) => ( element as HTMLElement ).click() );
	} finally {
		await page.evaluate( () => {
			const documentWithListener = document as Document & { __dlaPreventSubmit?: EventListener };
			if ( documentWithListener.__dlaPreventSubmit ) {
				document.removeEventListener( 'submit', documentWithListener.__dlaPreventSubmit, true );
				delete documentWithListener.__dlaPreventSubmit;
			}
		} );
	}
}
