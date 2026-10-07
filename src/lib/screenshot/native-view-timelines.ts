import type { Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { withEvaluateTimeout } from './page-helpers.js';

/** Facts from public Web Animations/Typed OM APIs, never framework configuration. */
export interface NativeViewTimelineCapture {
	schema: 'data-liberation/native-view-timelines/v1';
	profile: string;
	url: string;
	viewport: { width: number; height: number } | null;
	probeViewports: Array<{ width: number; height: number } | null>;
	samples: unknown[];
	preserved: number;
	losses: Array<{ target: string; reason: string }>;
	status: 'observed' | 'unproven';
	failures: string[];
}

// String-form browser code deliberately has no dependency on transpiler helpers.
const SNAPSHOT = `(async () => {
 const result=[];
 if(typeof ViewTimeline==='undefined')return result;
 let next=1+Math.max(-1,...Array.from(document.querySelectorAll('[data-dla-native-node]'),node=>Number(node.getAttribute('data-dla-native-node').replace(/^n/,''))).filter(Number.isFinite));
 const identity=node=>{if(!node)return null;let token=node.getAttribute('data-dla-native-node');if(!token){token='n'+next++;node.setAttribute('data-dla-native-node',token)}return token};
 const range=value=>typeof value==='string'?value:{rangeName:value.rangeName,offset:value.offset.toString()};
 const animations=document.getAnimations().filter(animation=>animation.timeline instanceof ViewTimeline&&!(animation instanceof CSSAnimation)&&!(animation instanceof CSSTransition));
 const alignment=new Map();
 try{
 for(const animation of animations){
  if(!(animation.effect instanceof KeyframeEffect))continue;
  try{const probe=new Animation(new KeyframeEffect(animation.effect.target,[],animation.effect.getTiming()),animation.timeline);alignment.set(animation,probe);probe.rangeStart=animation.rangeStart;probe.rangeEnd=animation.rangeEnd;probe.play()}catch{}
 }
 if(alignment.size)await new Promise(resolve=>setTimeout(resolve,100));
 for(const animation of animations){
  const effect=animation.effect,timeline=animation.timeline,target=effect instanceof KeyframeEffect?effect.target:null;
  const subject=timeline.subject,source=timeline.source;
  if(!(target instanceof Element)||!(subject instanceof Element)||!(source instanceof Element)){result.push({target:null,loss:'non-element target, subject or source'});continue}
  if(!document.body.contains(target)||target===document.body||!document.body.contains(subject)||subject===document.body||(source!==document.scrollingElement&&(!document.body.contains(source)||source===document.body))){result.push({target:identity(target),loss:'binding outside portable body content'});continue}
  const axis=timeline.axis,horizontal=getComputedStyle(source).writingMode==='horizontal-tb',vertical=axis==='y'||(axis==='block'&&horizontal)||(axis==='inline'&&!horizontal);
  const extent=node=>vertical?node.clientHeight:node.clientWidth;
  const inset=timeline.inset;
  const defaultTimeline=new ViewTimeline({subject,axis});
  const startOffset=timeline.startOffset?.toString(),endOffset=timeline.endOffset?.toString();
  const defaultInsetVerified=!!startOffset&&!!endOffset&&startOffset===defaultTimeline.startOffset?.toString()&&endOffset===defaultTimeline.endOffset?.toString();
  const probe=alignment.get(animation),startTime=animation.startTime?.toString(),currentTime=animation.currentTime?.toString();
  const alignmentVerified=!!probe&&!!startTime&&!!currentTime&&startTime===probe.startTime?.toString()&&currentTime===probe.currentTime?.toString();
  result.push({target:identity(target),targetSourceId:target.id,subject:identity(subject),subjectSourceId:subject.id,source:source===document.scrollingElement?'root':identity(source),axis,
   inset:inset?Array.from(inset,value=>value.toString()).join(' '):'auto',insetReadable:!!inset,defaultInsetVerified,startOffset,endOffset,subjectExtent:extent(subject),sourceExtent:extent(source),viewport:{innerWidth,innerHeight,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight,visualWidth:visualViewport?.width,visualHeight:visualViewport?.height},
   frames:effect.getKeyframes(),timing:effect.getTiming(),composite:effect.composite,iterationComposite:effect.iterationComposite??'replace',pseudoElement:effect.pseudoElement,
   playbackRate:animation.playbackRate,playState:animation.playState,startTime,currentTime,alignmentVerified,rangeStart:range(animation.rangeStart),rangeEnd:range(animation.rangeEnd)});
 }
 return result;
 }finally{for(const probe of alignment.values())probe.cancel()}
})()`;

type Range = string | { rangeName: string; offset: string };
interface Effect {
	target: string; subject: string; source: string; axis: string; inset: string;
	insetReadable: boolean; defaultInsetVerified: boolean;
	alignmentVerified: boolean;
	frames: Keyframe[]; timing: EffectTiming; composite: string; iterationComposite: string;
	pseudoElement: string | null; playbackRate: number; playState: string;
	subjectExtent: number; sourceExtent: number; rangeStart: Range; rangeEnd: Range; loss?: string;
}

/** A px offset is responsive only when independent source measurements prove it. */
export function observedRange( ranges: Range[], extents: number[] ): { value: string; coverExtent?: true } | undefined {
	const text = ( range: Range ) => typeof range === 'string' ? range : `${ range.rangeName } ${ range.offset }`;
	if ( ranges.every( range => text( range ) === text( ranges[ 0 ] ) ) ) return { value: text( ranges[ 0 ] ) };
	const pixels = ranges.map( range => {
		if ( typeof range === 'string' || range.rangeName !== 'cover' ) return NaN;
		const match = /^(?:calc\(0% \+ )?(-?\d+(?:\.\d+)?)px\)?$/.exec( range.offset );
		return match ? Number( match[ 1 ] ) : NaN;
	} );
	if ( new Set( extents ).size >= 3 && pixels.every( ( px, i ) => Number.isFinite( px ) && px === extents[ i ] ) ) {
		return { value: text( ranges[ 0 ] ), coverExtent: true };
	}
	return undefined;
}

export async function captureNativeViewTimelines( page: Page, profile: string, evaluateTimeoutMs = 5_000 ): Promise<NativeViewTimelineCapture> {
	const viewport = page.viewportSize();
	const report: NativeViewTimelineCapture = { schema: 'data-liberation/native-view-timelines/v1', profile, url: page.url(), viewport, probeViewports: [ viewport ], samples: [], preserved: 0, losses: [], status: 'observed', failures: [] };
	try { return await observeNativeViewTimelines( page, profile, evaluateTimeoutMs, report ); }
	catch ( error ) {
		report.status = 'unproven';
		report.preserved = 0;
		report.failures.push( String( error ) );
		const initial = ( report.samples[ 0 ] ?? [] ) as Effect[];
		for ( const target of new Set( initial.length ? initial.map( effect => effect.target ?? 'unknown' ) : [ 'unknown' ] ) ) {
			report.losses.push( { target, reason: 'native timeline capture or restoration is unproven' } );
		}
		return report;
	}
}

async function observeNativeViewTimelines( page: Page, profile: string, evaluateTimeoutMs: number, report: NativeViewTimelineCapture ): Promise<NativeViewTimelineCapture> {
	const viewport = report.viewport;
	const bounded = async <T>( promise: Promise<T>, operation: string ): Promise<T> => {
		try { return await withEvaluateTimeout( promise, evaluateTimeoutMs ); }
		catch ( error ) { throw new Error( `native timeline ${ operation }: ${ String( error ) }` ); }
	};
	const snapshot = () => bounded( page.evaluate<Effect[]>( SNAPSHOT ), 'snapshot' );
	const initial = await snapshot();
	if ( ! initial.length ) return report;
	const samples = [ initial ];
	report.samples = samples;
	const scroll = await bounded( page.evaluate( () => ({ x: scrollX, y: scrollY }) ), 'read scroll' );
	try {
		if ( viewport ) for ( const size of [ { width: viewport.width, height: viewport.height + 64 }, { width: viewport.width, height: Math.max( 200, viewport.height - 48 ) }, { width: viewport.width + 32, height: viewport.height + 32 } ] ) {
			await bounded( page.setViewportSize( size ), 'resize probe' );
			await delay( 800 );
			samples.push( await snapshot() );
			report.probeViewports.push( size );
		}
	} finally {
		// A timeout does not cancel a stuck renderer. Each restore is separately
		// bounded, retains its failure, and never masks the original probe failure.
		if ( viewport ) {
			try { await bounded( page.setViewportSize( viewport ), 'restore viewport' ); }
			catch ( error ) { report.failures.push( String( error ) ); }
		}
		try { await bounded( page.evaluate( ({ x, y }) => scrollTo( x, y ), scroll ), 'restore scroll' ); }
		catch ( error ) { report.failures.push( String( error ) ); }
		if ( ! report.failures.length ) await delay( 800 );
	}
	if ( report.failures.length ) throw new Error( 'native timeline restoration is unproven' );
	const restored = await snapshot();
	samples.push( restored );
	report.probeViewports.push( viewport );
	report.samples = samples;
	const configs: Array<{ target: string; config: unknown }> = [];
	for ( const effect of initial ) {
		if ( ! restored.some( candidate => candidate.target === effect.target && candidate.subject === effect.subject && JSON.stringify( candidate.frames ) === JSON.stringify( effect.frames ) ) ) {
			report.losses.push( { target: effect.target ?? 'unknown', reason: 'source effect disappeared or changed after geometry probes' } );
		}
	}
	for ( const effect of restored ) {
		const fail = ( reason: string ) => report.losses.push( { target: effect.target ?? 'unknown', reason } );
		if ( effect.loss ) { fail( effect.loss ); continue; }
		const peers = samples.map( sample => sample.filter( candidate => candidate.target === effect.target && candidate.subject === effect.subject && JSON.stringify( candidate.frames ) === JSON.stringify( effect.frames ) ) );
		if ( peers.some( matches => matches.length !== 1 ) ) { fail( 'effect identity changed or is ambiguous across geometry probes' ); continue; }
		const observations = peers.map( matches => matches[ 0 ] );
		if ( observations.some( peer => peer.axis !== effect.axis || peer.inset !== effect.inset || peer.source !== effect.source || peer.composite !== effect.composite || peer.iterationComposite !== effect.iterationComposite || peer.playbackRate !== effect.playbackRate || peer.playState !== effect.playState || JSON.stringify( peer.timing ) !== JSON.stringify( effect.timing ) ) ) { fail( 'timeline or timing changed across geometry probes' ); continue; }
		if ( observations.some( peer => ! peer.insetReadable && ! peer.defaultInsetVerified ) ) { fail( 'timeline inset is not publicly readable or independently verified as default' ); continue; }
		if ( observations.some( peer => ! peer.alignmentVerified ) ) { fail( 'animation phase is not independently verified as native range alignment' ); continue; }
		if ( effect.pseudoElement || effect.playbackRate !== 1 || effect.playState !== 'running' || effect.iterationComposite !== 'replace' ) { fail( 'unsupported pseudo-element, playback state or iteration composition' ); continue; }
		const extents = observations.map( peer => peer.subjectExtent + peer.sourceExtent );
		const start = observedRange( observations.map( peer => peer.rangeStart ), extents );
		const end = observedRange( observations.map( peer => peer.rangeEnd ), extents );
		if ( ! start || ! end ) { fail( 'range relationship is not fixed or independently validated cover extent' ); continue; }
		if ( effect.frames.some( frame => Object.entries( frame ).some( ([ key, value ]) => ! [ 'offset', 'computedOffset', 'easing', 'composite' ].includes( key ) && ( typeof value !== 'string' || /url\(|var\(/i.test( value ) ) ) ) ) { fail( 'keyframes contain unresolved or resource-dependent values' ); continue; }
		configs.push( { target: effect.target, config: { ...effect, rangeStart: start, rangeEnd: end } } );
		report.preserved++;
	}
	await bounded( page.evaluate( ({ configs, profile, losses }) => {
		for ( const node of document.querySelectorAll( '[data-dla-native-effects]' ) ) node.removeAttribute( 'data-dla-native-effects' );
		for ( const { target, config } of configs ) {
			const node = document.querySelector( `[data-dla-native-node="${ target }"]` );
			if ( ! node ) continue;
			const effects = JSON.parse( node.getAttribute( 'data-dla-native-effects' ) || '[]' );
			effects.push( config );
			node.setAttribute( 'data-dla-native-effects', JSON.stringify( effects ) );
			node.setAttribute( 'data-dla-native-profile', profile );
		}
		if ( losses.length ) document.body.setAttribute( 'data-dla-native-losses', JSON.stringify( losses ) );
	}, { configs, profile, losses: report.losses } ), 'emit bindings' );
	return report;
}
