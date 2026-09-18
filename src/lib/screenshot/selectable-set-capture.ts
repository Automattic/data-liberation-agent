import type { Page } from 'playwright';
import type { CapturedDialogInteraction } from './interaction-capture.js';

export const SELECTABLE_SET_KIND = 'selectable-set' as const;

export const SELECTABLE_SET_LIMITS = {
	maxSets: 3,
	maxMembers: 24,
	maxDriveMs: 8_000,
	maxHtmlBytes: 512 * 1024,
	settleMs: 250,
} as const;

export interface SelectableSetCaptureOptions {
	maxSets?: number;
	maxMembers?: number;
	maxDriveMs?: number;
	maxHtmlBytes?: number;
	settleMs?: number;
}

interface RawSelectableRecord {
	status: 'captured' | 'no-dialog' | 'click-failed';
	trigger: { selector: string; tag: string; id?: string; role?: string; label?: string };
	region?: { selector: string; tag: string; id?: string; role?: string; html?: string };
	set: { selector: string; size: number; index: number };
	error?: string;
}

/**
 * Capture the "N selectable members drive one shared region" shape.
 *
 * Dialogs and disclosures each bind one trigger to one surface. This shape is
 * different: a repeated cluster of activatable siblings (tabs, pickers, a
 * locator list, a map of zones) mutates a region *outside* the cluster, and
 * that region's content varies per member. Recognition is structural — repeated
 * selectable targets plus a confirmed shared mutation — not vendor- or
 * media-specific.
 *
 * Runs after baseline HTML/screenshots so probing cannot rewrite the initial
 * capture. Each drive restores the region before the next member, and the
 * original selection is restored before returning.
 */
export async function captureSelectableSetStates(
	page: Page,
	options: SelectableSetCaptureOptions = {}
): Promise< CapturedDialogInteraction[] > {
	const maxSets = options.maxSets ?? SELECTABLE_SET_LIMITS.maxSets;
	const maxMembers = options.maxMembers ?? SELECTABLE_SET_LIMITS.maxMembers;
	const maxDriveMs = options.maxDriveMs ?? SELECTABLE_SET_LIMITS.maxDriveMs;
	const maxHtmlBytes = options.maxHtmlBytes ?? SELECTABLE_SET_LIMITS.maxHtmlBytes;
	const settleMs = options.settleMs ?? SELECTABLE_SET_LIMITS.settleMs;

	let raw: RawSelectableRecord[];
	try {
		const result = await page.evaluate(
			async ( limits: {
				maxSets: number;
				maxMembers: number;
				maxDriveMs: number;
				settleMs: number;
			} ) => {
				const wait = ( ms: number ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );
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
							siblings.length > 1
								? `${ tag }:nth-of-type(${ siblings.indexOf( node ) + 1 })`
								: tag
						);
					}
					return `body > ${ parts.join( ' > ' ) }`;
				};
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
				const textOf = ( element: Element ) =>
					( element.textContent || '' ).replace( /\s+/g, ' ' ).trim();
				const fingerprint = ( element: Element ) =>
					`${ element.hasAttribute( 'hidden' ) || element.getAttribute( 'aria-hidden' ) === 'true' }|${
						element.childElementCount
					}|${ textOf( element ) }`;
				const isChrome = ( element: Element ) =>
					Boolean(
						element.closest(
							'header, footer, nav, [role="banner"], [role="navigation"], [role="contentinfo"]'
						)
					);
				const isNavigable = ( element: Element ) => {
					if ( element.tagName !== 'A' ) return false;
					const href = ( element.getAttribute( 'href' ) ?? '' ).trim();
					if ( ! href || href === '#' || href.startsWith( '#' ) ) return false;
					if ( href.toLowerCase().startsWith( 'javascript:' ) ) return false;
					return true;
				};
				const isDisclosureTrigger = ( element: Element ) => {
					if ( ! element.hasAttribute( 'aria-expanded' ) || ! element.hasAttribute( 'aria-controls' ) ) {
						return false;
					}
					const target = document.getElementById( element.getAttribute( 'aria-controls' ) || '' );
					return Boolean( target && target.getAttribute( 'role' ) === 'region' );
				};
				const isPagerControl = ( element: Element ) =>
					element.hasAttribute( 'data-dla-pager-control' ) ||
					Boolean( element.closest( '[data-dla-pager-stage]' ) );
				const looksSelectable = ( element: Element ): boolean => {
					if ( ! visible( element ) ) return false;
					if ( element.getAttribute( 'aria-disabled' ) === 'true' || element.hasAttribute( 'disabled' ) ) {
						return false;
					}
					if ( isNavigable( element ) ) return false;
					if ( element.hasAttribute( 'aria-haspopup' ) ) return false;
					if ( isDisclosureTrigger( element ) ) return false;
					if ( isPagerControl( element ) ) return false;
					if ( isChrome( element ) ) return false;
					const tag = element.tagName.toLowerCase();
					if (
						tag === 'input' ||
						tag === 'textarea' ||
						tag === 'select' ||
						tag === 'option' ||
						tag === 'script' ||
						tag === 'style' ||
						tag === 'link' ||
						tag === 'meta'
					) {
						return false;
					}
					const role = ( element.getAttribute( 'role' ) || '' ).toLowerCase();
					if (
						[ 'tab', 'option', 'radio', 'button', 'menuitem', 'menuitemradio' ].includes( role )
					) {
						return true;
					}
					if ( tag === 'button' ) {
						const type = ( element.getAttribute( 'type' ) || 'submit' ).toLowerCase();
						if ( type === 'submit' && element.closest( 'form' ) ) return false;
						return true;
					}
					if ( element.hasAttribute( 'aria-selected' ) || element.hasAttribute( 'aria-pressed' ) ) {
						return true;
					}
					if ( ( element as HTMLElement ).tabIndex >= 0 && tag !== 'a' ) return true;
					return getComputedStyle( element ).cursor === 'pointer';
				};
				const signature = ( element: Element ) =>
					`${ element.tagName.toLowerCase() }|${ ( element.getAttribute( 'role' ) || '' ).toLowerCase() }`;
				const isPageRoot = ( element: Element | null ) => {
					if ( ! element ) return true;
					const tag = element.tagName.toLowerCase();
					if ( [ 'html', 'body', 'main' ].includes( tag ) ) return true;
					const role = ( element.getAttribute( 'role' ) || '' ).toLowerCase();
					return [ 'main', 'document' ].includes( role );
				};
				const isExplicitContainer = ( element: Element ) => {
					const role = ( element.getAttribute( 'role' ) || '' ).toLowerCase();
					return [ 'tablist', 'radiogroup', 'listbox', 'list', 'menu', 'toolbar', 'grid', 'tree' ].includes(
						role
					);
				};
				const isStrong = ( root: Element, members: Element[] ) =>
					isExplicitContainer( root ) ||
					members.every( ( member ) => ( member.getAttribute( 'role' ) || '' ).toLowerCase() === 'tab' ) ||
					members.some( ( member ) => member.hasAttribute( 'aria-selected' ) );
				const collectSelectables = (): Element[] => {
					const semantic = Array.from(
						document.querySelectorAll(
							'button, [role="button"], [role="tab"], [role="option"], [role="radio"], [role="menuitem"], [role="menuitemradio"], [aria-selected], [aria-pressed], [tabindex]:not([tabindex="-1"])'
						)
					);
					const extra: Element[] = [];
					for ( const parent of Array.from( document.querySelectorAll( 'body *' ) ) ) {
						const kids = Array.from( parent.children );
						if ( kids.length < 2 ) continue;
						const byTag = new Map< string, Element[] >();
						for ( const kid of kids ) {
							const list = byTag.get( kid.tagName ) ?? [];
							list.push( kid );
							byTag.set( kid.tagName, list );
						}
						for ( const repeats of byTag.values() ) {
							if ( repeats.length < 2 ) continue;
							for ( const kid of repeats ) {
								if ( looksSelectable( kid ) ) extra.push( kid );
							}
						}
					}
					const unique = [ ...new Set( [ ...semantic, ...extra ].filter( looksSelectable ) ) ];
					return unique.filter(
						( element ) => ! unique.some( ( other ) => other !== element && other.contains( element ) )
					);
				};
				const documentOrder = ( a: Element, b: Element ) =>
					a.compareDocumentPosition( b ) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
				const findGroups = ( selectables: Element[] ) => {
					const assigned = new Set< Element >();
					const groups: Array< { root: Element; members: Element[] } > = [];
					for ( const element of selectables ) {
						if ( assigned.has( element ) ) continue;
						let found: { root: Element; members: Element[] } | null = null;
						for (
							let node = element.parentElement;
							node && ! isPageRoot( node );
							node = node.parentElement
						) {
							const peers = selectables.filter(
								( candidate ) => node!.contains( candidate ) && signature( candidate ) === signature( element )
							);
							if ( peers.length >= 2 ) {
								found = { root: node, members: peers };
								break;
							}
						}
						if ( ! found ) continue;
						for ( const member of found.members ) assigned.add( member );
						found.members.sort( documentOrder );
						groups.push( found );
					}
					groups.sort( ( a, b ) => {
						const strong =
							Number( isStrong( b.root, b.members ) ) - Number( isStrong( a.root, a.members ) );
						if ( strong !== 0 ) return strong;
						return documentOrder( a.members[ 0 ], b.members[ 0 ] );
					} );
					return groups;
				};
				const regionCandidates = ( groupRoot: Element, members: Element[] ) => {
					const out: Element[] = [];
					let node: Element | null = groupRoot;
					for ( let depth = 0; depth < 8 && node && node !== document.body; depth++ ) {
						for ( const child of Array.from( node.children ) ) {
							if ( child === groupRoot || groupRoot.contains( child ) || child.contains( groupRoot ) ) {
								continue;
							}
							if ( members.some( ( member ) => child.contains( member ) || member.contains( child ) ) ) {
								continue;
							}
							if ( ! visible( child ) ) continue;
							out.push( child );
						}
						node = node.parentElement;
					}
					return out;
				};
				const currentRoute = () => `${ location.pathname }${ location.search }`;
				const activate = async (
					element: Element
				): Promise< { ok: true } | { ok: false; error: string; navigated?: boolean } > => {
					const before = currentRoute();
					const beforeState = history.state;
					try {
						( element as HTMLElement ).click();
					} catch ( error ) {
						return {
							ok: false,
							error: ( error instanceof Error ? error.message : String( error ) ).slice( 0, 500 ),
						};
					}
					await wait( limits.settleMs );
					if ( currentRoute() !== before ) {
						try {
							history.pushState( beforeState, '', before );
							window.dispatchEvent( new PopStateEvent( 'popstate', { state: beforeState } ) );
						} catch {
							/* ignore */
						}
						return { ok: false, error: 'navigated', navigated: true };
					}
					return { ok: true };
				};
				const snapshotHtml = ( element: Element ) => {
					const clone = element.cloneNode( true ) as Element;
					for ( const unsafe of Array.from( clone.querySelectorAll( 'script,style,noscript,iframe' ) ) ) {
						unsafe.remove();
					}
					for ( const node of [ clone, ...Array.from( clone.querySelectorAll( '*' ) ) ] ) {
						for ( const attribute of Array.from( node.attributes ) ) {
							if ( /^on/i.test( attribute.name ) || attribute.name.startsWith( 'data-lib-selectable' ) ) {
								node.removeAttribute( attribute.name );
							}
						}
					}
					return clone.outerHTML;
				};
				const describeTrigger = ( element: Element ) => {
					const title = element.querySelector( 'title' );
					const label = (
						element.getAttribute( 'aria-label' ) ||
						element.getAttribute( 'title' ) ||
						title?.textContent ||
						element.textContent ||
						element.id ||
						''
					)
						.replace( /\s+/g, ' ' )
						.trim()
						.slice( 0, 40 );
					return {
						selector: sourceSelector( element ),
						tag: element.tagName.toLowerCase(),
						...( element.id ? { id: element.id } : {} ),
						...( element.getAttribute( 'role' )
							? { role: element.getAttribute( 'role' )! }
							: {} ),
						...( label ? { label } : {} ),
					};
				};
				const describeRegion = ( element: Element, html?: string ) => ( {
					selector: element.id
						? `#${ cssEscape( element.id ) }`
						: sourceSelector( element ),
					tag: element.tagName.toLowerCase(),
					...( element.id ? { id: element.id } : {} ),
					...( element.getAttribute( 'role' ) ? { role: element.getAttribute( 'role' )! } : {} ),
					...( html !== undefined ? { html } : {} ),
				} );
				const selectedMember = ( members: Element[] ) =>
					members.find(
						( member ) =>
							member.getAttribute( 'aria-selected' ) === 'true' ||
							member.getAttribute( 'aria-pressed' ) === 'true' ||
							member.getAttribute( 'aria-current' ) === 'true'
					);

				const records: RawSelectableRecord[] = [];
				const deadline = Date.now() + limits.maxDriveMs;
				const groups = findGroups( collectSelectables() ).slice( 0, limits.maxSets );

				for ( const group of groups ) {
					const candidates = regionCandidates( group.root, group.members );
					const setRecord = ( index: number ) => ( {
						selector: sourceSelector( group.root ),
						size: group.members.length,
						index,
					} );
					const pushOutcome = (
						status: RawSelectableRecord[ 'status' ],
						index: number,
						extra: Partial< RawSelectableRecord > = {}
					) => {
						records.push( {
							status,
							trigger: describeTrigger( group.members[ index ] ),
							set: setRecord( index ),
							...extra,
						} );
					};

					if ( candidates.length === 0 ) {
						if ( isStrong( group.root, group.members ) ) pushOutcome( 'no-dialog', 0 );
						continue;
					}

					const initialFp = candidates.map( fingerprint );
					const initialText = candidates.map( textOf );
					const initialHtml = candidates.map( ( candidate ) => candidate.innerHTML );
					let regionIdx = -1;
					const variants: Array< { fp: string } > = [];
					let navigated = false;
					let discoveryError: { index: number; error: string } | undefined;

					const consider = () => {
						const fps = candidates.map( fingerprint );
						const texts = candidates.map( textOf );
						if ( regionIdx < 0 ) {
							const changed: number[] = [];
							for ( let index = 0; index < candidates.length; index++ ) {
								if ( fps[ index ] !== initialFp[ index ] && texts[ index ] !== initialText[ index ] ) {
									changed.push( index );
								}
							}
							if ( changed.length === 0 ) return;
							changed.sort(
								( a, b ) =>
									Math.abs( texts[ b ].length - initialText[ b ].length ) -
									Math.abs( texts[ a ].length - initialText[ a ].length )
							);
							regionIdx = changed[ 0 ];
						}
						const fp = fps[ regionIdx ];
						if ( ! variants.some( ( variant ) => variant.fp === fp ) ) variants.push( { fp } );
					};

					const probeLimit = Math.min( group.members.length, 4 );
					for (
						let index = 0;
						index < probeLimit && variants.length < 2 && Date.now() < deadline;
						index++
					) {
						const result = await activate( group.members[ index ] );
						if ( ! result.ok ) {
							discoveryError ??= { index, error: result.error };
							if ( result.navigated ) {
								navigated = true;
								break;
							}
							continue;
						}
						consider();
					}

					if ( navigated ) {
						pushOutcome( 'click-failed', discoveryError?.index ?? 0, {
							error: discoveryError?.error ?? 'navigated',
						} );
						continue;
					}
					if ( variants.length < 2 || regionIdx < 0 ) {
						if ( isStrong( group.root, group.members ) ) {
							if ( discoveryError && variants.length === 0 ) {
								pushOutcome( 'click-failed', discoveryError.index, { error: discoveryError.error } );
							} else {
								pushOutcome( 'no-dialog', 0 );
							}
						}
						if ( regionIdx >= 0 ) candidates[ regionIdx ].innerHTML = initialHtml[ regionIdx ];
						continue;
					}

					const region = candidates[ regionIdx ];
					region.setAttribute( 'data-lib-selectable-region', 'true' );
					const original = selectedMember( group.members );
					const drivenCount = Math.min( group.members.length, limits.maxMembers );

					for ( let index = 0; index < drivenCount && Date.now() < deadline; index++ ) {
						const member = group.members[ index ];
						const liveRegion =
							document.querySelector( '[data-lib-selectable-region]' ) ?? region;
						const before = fingerprint( liveRegion );
						const wasSelected =
							member.getAttribute( 'aria-selected' ) === 'true' ||
							member.getAttribute( 'aria-pressed' ) === 'true';
						const result = await activate( member );
						if ( ! result.ok ) {
							pushOutcome( 'click-failed', index, { error: result.error } );
							if ( result.navigated ) {
								navigated = true;
								break;
							}
							continue;
						}
						const afterRegion =
							document.querySelector( '[data-lib-selectable-region]' ) ?? liveRegion;
						const after = fingerprint( afterRegion );
						if ( after === before && ! wasSelected ) {
							pushOutcome( 'no-dialog', index, { region: describeRegion( afterRegion ) } );
							continue;
						}
						pushOutcome( 'captured', index, {
							region: describeRegion( afterRegion, snapshotHtml( afterRegion ) ),
						} );
					}

					const restoreTarget =
						document.querySelector( '[data-lib-selectable-region]' ) ?? region;
					if ( original && Date.now() < deadline ) await activate( original );
					restoreTarget.innerHTML = initialHtml[ regionIdx ];
					restoreTarget.removeAttribute( 'data-lib-selectable-region' );
					if ( navigated ) continue;
				}

				return records;
			},
			{ maxSets, maxMembers, maxDriveMs, settleMs }
		);
		raw = Array.isArray( result ) ? ( result as RawSelectableRecord[] ) : [];
	} catch {
		raw = [];
	}

	return raw.map( ( record ): CapturedDialogInteraction => {
		const bounded =
			record.region?.html !== undefined ? boundHtml( record.region.html, maxHtmlBytes ) : undefined;
		return {
			status: record.status,
			kind: SELECTABLE_SET_KIND,
			trigger: {
				selector: record.trigger.selector,
				tag: record.trigger.tag,
				...( record.trigger.id ? { id: record.trigger.id } : {} ),
				...( record.trigger.role ? { role: record.trigger.role } : {} ),
				ariaHaspopup: '',
				...( record.region?.id ? { ariaControls: record.region.id } : {} ),
				...( record.trigger.label ? { label: record.trigger.label } : {} ),
				dataBindings: {},
			},
			...( bounded && record.region
				? {
						dialog: {
							selector: record.region.selector,
							tag: record.region.tag,
							...( record.region.id ? { id: record.region.id } : {} ),
							...( record.region.role ? { role: record.region.role } : {} ),
							ariaModal: false,
							html: bounded.html,
							htmlBytes: bounded.bytes,
							htmlTruncated: bounded.truncated,
						},
				  }
				: {} ),
			set: record.set,
			...( record.error ? { error: record.error } : {} ),
		};
	} );
}

function boundHtml(
	html: string,
	maxBytes: number
): { html: string; bytes: number; truncated: boolean } {
	const bytes = Buffer.byteLength( html );
	if ( bytes <= maxBytes ) return { html, bytes, truncated: false };
	return { html: Buffer.from( html ).subarray( 0, maxBytes ).toString(), bytes, truncated: true };
}
