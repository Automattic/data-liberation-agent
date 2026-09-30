import type { Page } from 'playwright';

export const SOURCE_BEHAVIOR_SCHEMA = 'data-liberation/source-behavior/v1';

export interface BehaviorTrace {
	text: Record< string, Array< { at: number; text: string } > >;
	settledText?: Record< string, string >;
	visibility: Record< string, Array< { at: number; visible: boolean } > >;
	events: Array< { selector: string; event: string } >;
	canvas: Record< string, { methods: Record< string, number >; sample: Array< { method: string; args: unknown[] } > } >;
	truncated: boolean;
}

export interface SourceBehavior {
	schema: typeof SOURCE_BEHAVIOR_SCHEMA;
	url: string;
	viewport: number;
	startup: BehaviorTrace;
	clockSamples?: Record< string, string >;
	pointer: { before: Record< string, string >; after: Record< string, string >; trace: BehaviorTrace };
	replays: Array< { selector: string; trace: BehaviorTrace } >;
	/** Observing drawing activity does not identify its algorithm or establish reproducibility. */
	status: 'observed_untranslated';
}

/** Installs bounded instrumentation before source scripts execute. No source names, scripts or effects are assumed. */
async function instrument( page: Page ): Promise< void > {
	await page.addInitScript( () => {
		type Trace = {
			text: Record< string, Array< { at: number; text: string } > >;
			visibility: Record< string, Array< { at: number; visible: boolean } > >;
			events: Array< { selector: string; event: string } >;
			canvas: Record< string, { methods: Record< string, number >; sample: Array< { method: string; args: unknown[] } > } >;
			truncated: boolean;
		};
		const empty = (): Trace => ( { text: {}, visibility: {}, events: [], canvas: {}, truncated: false } );
		let trace = empty();
		let epoch = performance.now();
		let samples = 0;
		const listeners: Array< { selector: string; event: string } > = [];
		function selector( target: EventTarget | Element ): string {
			if ( target === window ) return 'window';
			if ( target === document ) return 'document';
			if ( ! ( target instanceof Element ) ) return '';
			if ( target.id && document.querySelectorAll( '#' + CSS.escape( target.id ) ).length === 1 ) return '#' + CSS.escape( target.id );
			const parts: string[] = [];
			let element: Element | null = target;
			while ( element && element !== document.documentElement && parts.length < 12 ) {
				const tag = element.localName;
				const siblings: Element[] = element.parentElement ? Array.from( element.parentElement.children ).filter( ( node ) => node.localName === tag ) : [];
				parts.unshift( `${ tag }:nth-of-type(${ siblings.indexOf( element ) + 1 })` );
				element = element.parentElement;
			}
			return element === document.documentElement ? 'html>' + parts.join( '>' ) : '';
		}
		const add = EventTarget.prototype.addEventListener;
		EventTarget.prototype.addEventListener = function( event, listener, options ) {
			if ( /^(?:click|pointermove|mousemove|touchmove)$/.test( event ) ) {
				const key = selector( this );
				if ( key && ! listeners.some( ( row ) => row.selector === key && row.event === event ) ) {
					if ( listeners.length < 64 ) listeners.push( { selector: key, event } );
					else trace.truncated = true;
				}
			}
			return add.call( this, event, listener, options );
		};
		// Record drawing operations, not an invented effect label. Different source
		// algorithms retain different evidence (e.g. arcs versus strokes).
		for ( const method of [ 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'arc', 'ellipse', 'bezierCurveTo', 'quadraticCurveTo', 'fill', 'stroke', 'drawImage', 'fillText', 'putImageData' ] ) {
			const prototype = CanvasRenderingContext2D.prototype as unknown as Record< string, ( ...args: unknown[] ) => unknown >;
			const original = prototype[ method ];
			if ( typeof original !== 'function' ) continue;
			prototype[ method ] = function( this: CanvasRenderingContext2D, ...args: unknown[] ) {
				const key = selector( this.canvas );
				if ( key ) {
					if ( ! trace.canvas[ key ] && Object.keys( trace.canvas ).length < 8 ) trace.canvas[ key ] = { methods: {}, sample: [] };
					const record = trace.canvas[ key ];
					if ( record ) {
						record.methods[ method ] = Math.min( 100000, ( record.methods[ method ] ?? 0 ) + 1 );
						if ( record.sample.length < 48 ) record.sample.push( { method, args: args.map( ( value ) => typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' ? value : null ) } );
					}
				}
				return original.apply( this, args );
			};
		}
		function sample(): void {
			if ( ! document.body ) return;
			if ( ++samples > 2000 ) { trace.truncated = true; return; }
			const nodes = Array.from( document.body.querySelectorAll( '*' ) );
			if ( nodes.length > 512 ) trace.truncated = true;
			for ( const element of nodes.slice( 0, 512 ) ) {
				if ( element.closest( 'script,style,noscript,template' ) ) continue;
				const key = selector( element );
				if ( ! key ) continue;
				const at = Math.round( performance.now() - epoch );
				if ( ! element.children.length && element.localName !== 'canvas' ) {
					const text = element.textContent ?? '';
					if ( text.length <= 512 ) {
						const history = trace.text[ key ] ??= [];
						if ( history.at( -1 )?.text !== text ) {
							if ( history.length < 128 ) history.push( { at, text } );
							else trace.truncated = true;
						}
					}
				}
				const style = getComputedStyle( element );
				const visible = style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
				const states = trace.visibility[ key ] ??= [];
				if ( states.at( -1 )?.visible !== visible ) {
					if ( states.length < 64 ) states.push( { at, visible } );
					else trace.truncated = true;
				}
			}
		}
		const start = () => {
			epoch = performance.now();
			sample();
			new MutationObserver( sample ).observe( document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [ 'class', 'style', 'hidden', 'aria-busy' ] } );
		};
		add.call( document, 'DOMContentLoaded', start, { once: true } );
		( window as unknown as { __dlaBehavior: unknown } ).__dlaBehavior = {
			snapshot: () => {
				sample(); trace.events = listeners.slice();
				const settledText: Record< string, string > = {};
				for ( const key of Object.keys( trace.text ) ) {
					const element = document.querySelector( key );
					if ( element && ! element.children.length ) settledText[ key ] = element.textContent ?? '';
				}
				return { ...trace, settledText };
			},
			reset: () => { trace = empty(); epoch = performance.now(); samples = 0; sample(); },
		};
	} );
}

async function snapshot( page: Page ): Promise< BehaviorTrace > {
	return page.evaluate( () => ( window as unknown as { __dlaBehavior: { snapshot: () => BehaviorTrace } } ).__dlaBehavior.snapshot() );
}

/** Bounded source-only probe. Its output is evidence for translation, never a fidelity pass. */
export async function captureSourceBehavior( page: Page, url: string, options: { startupMs?: number; replayMs?: number; maxClicks?: number; fixedTime?: string } = {} ): Promise< SourceBehavior > {
	const startupMs = Math.min( 15000, Math.max( 100, options.startupMs ?? 15000 ) );
	const replayMs = Math.min( 6000, Math.max( 100, options.replayMs ?? 5000 ) );
	const maxClicks = Math.min( 8, Math.max( 0, options.maxClicks ?? 8 ) );
	if ( options.fixedTime ) await page.clock.setFixedTime( new Date( options.fixedTime ) );
	await instrument( page );
	await page.goto( url, { waitUntil: 'domcontentloaded', timeout: 30000 } );
	await page.waitForTimeout( startupMs );
	const startup = await snapshot( page );
	const clockSamples = await page.evaluate( () => {
		const now = new Date();
		const two = ( value: number ) => String( value ).padStart( 2, '0' );
		const locale = document.documentElement.lang || 'en-US';
		const parts = new Intl.DateTimeFormat( locale, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' } ).formatToParts( now );
		const part = ( type: string ) => parts.find( ( value ) => value.type === type )?.value ?? '';
		const offset = -now.getTimezoneOffset() / 60;
		return {
			hour12: two( now.getHours() % 12 || 12 ), hour24: two( now.getHours() ), minute: two( now.getMinutes() ),
			ampm: now.getHours() < 12 ? 'AM' : 'PM', iso: now.toISOString(),
			gmtOffset: `(GMT ${ offset >= 0 ? '+' : '' }${ offset })`,
			dateUpper: `${ part( 'weekday' ) }, ${ part( 'month' ) } ${ part( 'day' ) }, ${ part( 'year' ) }`.toUpperCase(),
		};
	} );
	const bitmap = () => page.evaluate( () => Object.fromEntries( Array.from( document.querySelectorAll( 'canvas' ) ).slice( 0, 8 ).map( ( canvas, index ) => {
		let image = '';
		try { image = canvas.toDataURL(); } catch { image = 'unreadable'; }
		return [ canvas.id ? '#' + CSS.escape( canvas.id ) : `canvas:${ index }`, image ];
	} ) ) );
	const before = await bitmap();
	await page.evaluate( () => ( window as unknown as { __dlaBehavior: { reset: () => void } } ).__dlaBehavior.reset() );
	const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
	await page.mouse.move( viewport.width * .25, viewport.height * .5 );
	await page.mouse.move( viewport.width * .6, viewport.height * .52 );
	await page.waitForTimeout( 200 );
	const pointer = { before, after: await bitmap(), trace: await snapshot( page ) };
	const replays: SourceBehavior[ 'replays' ] = [];
	for ( const listener of startup.events.filter( ( row ) => row.event === 'click' && ! [ 'window', 'document' ].includes( row.selector ) ).slice( 0, maxClicks ) ) {
		const target = page.locator( listener.selector );
		if ( await target.count() !== 1 || ! await target.isVisible() ) continue;
		// Restrict probing to same-document handlers; navigation/submit controls
		// remain owned by the established interaction capture primitives.
		if ( await target.evaluate( ( element ) => !! element.closest( 'a[href],form' ) ) ) continue;
		await page.evaluate( () => ( window as unknown as { __dlaBehavior: { reset: () => void } } ).__dlaBehavior.reset() );
		await target.click( { force: true, timeout: 3000 } );
		await page.waitForTimeout( replayMs );
		if ( page.url() !== url ) break;
		replays.push( { selector: listener.selector, trace: await snapshot( page ) } );
	}
	return { schema: SOURCE_BEHAVIOR_SCHEMA, url, viewport: viewport.width, startup, clockSamples, pointer, replays, status: 'observed_untranslated' };
}
