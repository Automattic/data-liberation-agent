import type { BehaviorTrace, SourceBehavior } from './screenshot/behavior-capture.js';
import { learnTextReveals, timeDependentTargets, type LearnedTextReveal } from './behavior-model.js';
import { learnClockBindings } from './clock-behavior.js';

/**
 * Learned behavior expressed in the Blocks Engine authorable motion vocabulary
 * (`data-blocks-engine-motion-steps` / `data-blocks-engine-live-clock`), so the
 * same inert, editable configuration drives the portable site and the
 * WordPress blocks. Values are inferred from browser evidence; nothing here is
 * authored per site. Anything the vocabulary cannot express is reported.
 */
export const LEARNED_MOTION_SCHEMA = 'data-liberation/learned-motion/v1';

export interface MotionReveal { selector: string; hideWith: 'visibility' | 'display' }
export interface MotionStep {
	selector: string;
	delayMs: number;
	intervalMs: number;
	pendingText?: string;
	pendingDots?: boolean;
	pendingIntervalMs?: number;
	clickSelector?: string;
	replayDelayMs?: number;
	revealSelectors?: MotionReveal[];
}
export interface LiveClockConfig {
	hourSelector: string;
	minuteSelector: string;
	timezoneSelector: string;
	ampmSelector?: string;
	dateSelector?: string;
	triggerSelector?: string;
	hourCycle: '12' | '24';
	locale: string;
	initialFrame?: string;
	stages: string;
	startDelayMs: number;
	stageDurationMs: number;
	pauseMs: number;
	dateDelayMs?: number;
	characterIntervalMs?: number;
}
export interface UnsupportedBehavior { selector?: string; reason: string }
export interface LearnedMotion {
	schema: typeof LEARNED_MOTION_SCHEMA;
	steps: MotionStep[];
	clock: LiveClockConfig | null;
	/** Time from DOMContentLoaded until the source's learned startup behavior has settled. */
	settleMs: number;
	unsupported: UnsupportedBehavior[];
}

type Frames = BehaviorTrace[ 'text' ][ string ];
const median = ( values: number[] ): number => {
	const sorted = [ ...values ].sort( ( a, b ) => a - b );
	return sorted.length ? sorted[ Math.floor( sorted.length / 2 ) ] : NaN;
};
const within = ( value: number, min: number, max: number ) => Number.isFinite( value ) && value >= min && value <= max;
const distinct = ( frames: Frames = [] ) => new Set( frames.map( ( frame ) => frame.text.trim() ) ).size;

/** First instant the reveal shows its complete value. */
function revealEnd( frames: Frames, reveal: LearnedTextReveal, final: string ): number {
	return frames.find( ( frame ) => frame.at >= reveal.startMs && frame.text === final )?.at ?? reveal.startMs + ( reveal.characters - 1 ) * reveal.intervalMs;
}

/** A static message, optionally with the common 0–3 cycling-dot suffix, shown before a reveal. */
function learnPending( frames: Frames, before: number, settled: string ): Pick< MotionStep, 'pendingText' | 'pendingDots' | 'pendingIntervalMs' > | 'unsupported' | null {
	const pending = frames.filter( ( frame ) => frame.at < before && frame.text.trim() && frame.text !== settled );
	if ( ! pending.length ) return null;
	const parsed = pending.map( ( frame ) => /^([\s\S]*?)(\.*)$/.exec( frame.text.trim() )! );
	const stem = parsed[ 0 ][ 1 ].trim();
	if ( ! stem || stem.length > 120 || parsed.some( ( match ) => match[ 1 ].trim() !== stem ) ) return 'unsupported';
	const dots = parsed.map( ( match ) => match[ 2 ].length );
	if ( new Set( dots ).size === 1 ) return dots[ 0 ] === 0 ? { pendingText: stem } : 'unsupported';
	const intervals = pending.slice( 1 ).map( ( frame, index ) => frame.at - pending[ index ].at );
	// Returning to the bare stem is the empty-dot state and may not be sampled as a separate frame.
	const pendingIntervalMs = median( intervals );
	if ( Math.max( ...dots ) > 3 || ! within( pendingIntervalMs, 100, 2000 ) ) return 'unsupported';
	return { pendingText: stem, pendingDots: true, pendingIntervalMs };
}

function learnClock( first: SourceBehavior, second: SourceBehavior, unsupported: UnsupportedBehavior[] ): { clock: LiveClockConfig | null; targets: Set< string >; end: number } {
	const { bindings, unsupported: unbound } = learnClockBindings( first, second );
	for ( const selector of unbound ) unsupported.push( { selector, reason: 'time-dependent text does not match a supported clock representation' } );
	const role = ( ...roles: string[] ) => bindings.find( ( binding ) => roles.includes( binding.role ) );
	const hour = role( 'hour12', 'hour24' );
	const minute = role( 'minute' );
	const timezone = role( 'gmtOffset' );
	const targets = new Set( bindings.map( ( binding ) => binding.selector ) );
	for ( const binding of bindings.filter( ( row ) => ! [ 'hour12', 'hour24', 'minute', 'gmtOffset', 'ampm', 'dateUpper' ].includes( row.role ) ) ) {
		unsupported.push( { selector: binding.selector, reason: `clock representation ${ binding.role } has no portable clock field` } );
	}
	if ( ! bindings.length ) return { clock: null, targets, end: 0 };
	if ( ! hour || ! minute || ! timezone ) {
		for ( const binding of bindings ) unsupported.push( { selector: binding.selector, reason: 'clock lacks an hour, minute and timezone field' } );
		return { clock: null, targets, end: 0 };
	}
	const settled = first.startup.settledText ?? {};
	// A click replay starts from a settled state, so its frame sequence is the cleanest evidence.
	const replay = first.replays.find( ( row ) => distinct( row.trace.text[ hour.selector ] ) > 1 );
	const final = settled[ hour.selector ];
	const replayFrames = replay?.trace.text[ hour.selector ] ?? [];
	const startupFrames = first.startup.text[ hour.selector ] ?? [];
	const shown = ( frames: Frames ) => [ ...frames ].reverse().find( ( frame ) => frame.text === final );
	const stagesFrom = ( frames: Frames, from: number ) => frames.slice( from, frames.indexOf( shown( frames )! ) );
	const stageFrames = replay ? stagesFrom( replayFrames, 1 ) : stagesFrom( startupFrames, 1 );
	const minuteFrames = ( replay ? replay.trace.text[ minute.selector ] : first.startup.text[ minute.selector ] ) ?? [];
	const minuteStages = minuteFrames.slice( 1, -1 ).map( ( frame ) => frame.text );
	const shownAt = shown( replay ? replayFrames : startupFrames )?.at;
	const startupShownAt = shown( startupFrames )?.at;
	const stageDurationMs = stageFrames.length > 1 ? median( stageFrames.slice( 1 ).map( ( frame, index ) => frame.at - stageFrames[ index ].at ) ) : 150;
	// Timer jitter only ever delays a frame; a slightly negative remainder is zero.
	const pauseMs = shownAt === undefined || ! stageFrames.length ? NaN : Math.max( 0, shownAt - stageFrames.at( -1 )!.at - stageDurationMs );
	const initial = startupFrames[ 0 ];
	const initialFrame = initial && initial.at < 50 && initial.text !== final ? initial.text : undefined;
	const startDelayMs = startupShownAt === undefined ? NaN : Math.max( 0, startupShownAt - stageFrames.length * stageDurationMs - pauseMs );
	const stages = stageFrames.map( ( frame ) => frame.text );
	if ( stages.some( ( stage ) => ! stage || stage.length > 8 || stage.includes( ',' ) ) || stages.join( '\u0000' ) !== minuteStages.join( '\u0000' ) ||
		stages.length > 8 || ! within( stageDurationMs, 0, 1000 ) || ! within( pauseMs, 0, 1000 ) || ! within( startDelayMs, 0, 5000 ) ) {
		for ( const binding of bindings ) unsupported.push( { selector: binding.selector, reason: 'clock startup frames do not fit the portable clock sequence' } );
		return { clock: null, targets, end: 0 };
	}
	const clock: LiveClockConfig = {
		hourSelector: hour.selector, minuteSelector: minute.selector, timezoneSelector: timezone.selector,
		hourCycle: hour.role === 'hour24' ? '24' : '12', locale: first.locale ?? 'en-US',
		stages: stages.join( ',' ), startDelayMs, stageDurationMs, pauseMs,
		...( initialFrame ? { initialFrame } : {} ),
		...( role( 'ampm' ) ? { ampmSelector: role( 'ampm' )!.selector } : {} ),
		...( replay ? { triggerSelector: replay.selector } : {} ),
	};
	let end = startupShownAt ?? 0;
	const date = role( 'dateUpper' );
	if ( date ) {
		const trace = replay?.trace ?? first.startup;
		const reveal = learnTextReveals( trace ).find( ( row ) => row.selector === date.selector );
		const dateDelayMs = reveal && shownAt !== undefined ? Math.max( 0, reveal.startMs - shownAt ) : NaN;
		if ( ! reveal || ! within( dateDelayMs, 0, 1000 ) || ! within( reveal.intervalMs, 10, 500 ) ) {
			unsupported.push( { selector: date.selector, reason: 'date text is not revealed after the clock in a supported sequence' } );
		} else {
			Object.assign( clock, { dateSelector: date.selector, dateDelayMs, characterIntervalMs: reveal.intervalMs } );
			end = ( startupShownAt ?? 0 ) + dateDelayMs + reveal.characters * reveal.intervalMs;
		}
	}
	return { clock, targets, end };
}

/** Infer an editable motion program from two controlled source observations. */
export function learnMotion( first: SourceBehavior, second: SourceBehavior ): LearnedMotion {
	const unsupported: UnsupportedBehavior[] = [];
	const dynamic = new Set( timeDependentTargets( first, second ) );
	const { clock, targets: clockTargets, end: clockEnd } = learnClock( first, second, unsupported );
	const settled = first.startup.settledText ?? {};
	const steps: MotionStep[] = [];
	let previous: { end: number; interval: number } | null = null;
	for ( const reveal of learnTextReveals( first.startup ).filter( ( row ) => ! dynamic.has( row.selector ) && ! clockTargets.has( row.selector ) ) ) {
		const frames = first.startup.text[ reveal.selector ];
		const final = settled[ reveal.selector ] ?? frames.at( -1 )!.text;
		// The vocabulary is a sequence: each step waits after the previous step's last character.
		const delayMs = previous ? reveal.startMs - previous.end - previous.interval : reveal.startMs;
		// Typing that starts before the previous reveal completed is concurrent, not sequential.
		if ( ( previous && reveal.startMs < previous.end ) || delayMs > 5000 || ! within( reveal.intervalMs, 10, 500 ) ) {
			unsupported.push( { selector: reveal.selector, reason: 'text reveal overlaps another reveal or exceeds sequence timing bounds' } );
			continue;
		}
		const step: MotionStep = { selector: reveal.selector, delayMs: Math.max( 0, delayMs ), intervalMs: reveal.intervalMs };
		const pending = learnPending( frames, reveal.startMs, final );
		if ( pending === 'unsupported' ) unsupported.push( { selector: reveal.selector, reason: 'pending text before the reveal is not a static message with cycling dots' } );
		else if ( pending ) Object.assign( step, pending );
		steps.push( step );
		previous = { end: revealEnd( frames, reveal, final ), interval: reveal.intervalMs };
	}
	if ( steps.length > 8 ) {
		for ( const step of steps.splice( 8 ) ) unsupported.push( { selector: step.selector, reason: 'more than eight sequential text reveals' } );
	}
	const bySelector = new Map( steps.map( ( step ) => [ step.selector, step ] ) );
	const transientCovered = steps.some( ( step ) => step.pendingDots );
	const explained = ( selector: string, trigger?: string ) =>
		( bySelector.has( selector ) && ( ! trigger || bySelector.get( selector )!.clickSelector === trigger ) ) ||
		( clockTargets.has( selector ) && ( ! trigger || clock?.triggerSelector === trigger ) ) ||
		( ! ( selector in settled ) && transientCovered );
	for ( const replay of first.replays ) {
		for ( const reveal of learnTextReveals( replay.trace ) ) {
			const step = bySelector.get( reveal.selector );
			if ( ! step || clockTargets.has( reveal.selector ) ) continue;
			if ( step.clickSelector && step.clickSelector !== replay.selector ) {
				unsupported.push( { selector: reveal.selector, reason: 'text replays from more than one trigger' } );
				continue;
			}
			if ( ! within( reveal.startMs, 0, 5000 ) ) {
				unsupported.push( { selector: reveal.selector, reason: 'click replay delay exceeds sequence timing bounds' } );
				continue;
			}
			Object.assign( step, { clickSelector: replay.selector, replayDelayMs: reveal.startMs } );
		}
		for ( const [ selector, frames ] of Object.entries( replay.trace.text ) ) {
			if ( distinct( frames ) > 1 && ! explained( selector, replay.selector ) ) unsupported.push( { selector, reason: `click on ${ replay.selector } changes text without a learned replay` } );
		}
	}
	for ( const [ selector, frames ] of Object.entries( first.startup.text ) ) {
		if ( distinct( frames ) > 1 && ! explained( selector ) ) unsupported.push( { selector, reason: 'startup text change is not a recognized reveal, pending message or clock' } );
	}
	// Elements hidden until a reveal starts. Descendants hidden by an ancestor follow it.
	const revealed: Array< { selector: string; at: number; via?: string } > = [];
	for ( const [ selector, states ] of Object.entries( first.startup.visibility ) ) {
		if ( states.length < 2 ) continue;
		if ( states.length !== 2 || states[ 0 ].visible || ! states[ 1 ].visible ) {
			unsupported.push( { selector, reason: 'startup visibility change is not a single reveal' } );
			continue;
		}
		revealed.push( { selector, at: states[ 1 ].at, via: states[ 0 ].via } );
	}
	for ( const row of revealed ) {
		const step = steps.find( ( candidate ) => Math.abs( revealStart( first, candidate ) - row.at ) <= 150 );
		const direct = row.via === 'display' || row.via === 'visibility';
		if ( step && direct ) ( step.revealSelectors ??= [] ).push( { selector: row.selector, hideWith: row.via as MotionReveal[ 'hideWith' ] } );
		else if ( ! step || ! revealed.some( ( other ) => other !== row && Math.abs( other.at - row.at ) <= 50 && ( other.via === 'display' || other.via === 'visibility' ) ) ) {
			unsupported.push( { selector: row.selector, reason: 'element becomes visible without a matching text reveal' } );
		}
	}
	for ( const [ selector, canvas ] of Object.entries( { ...first.startup.canvas, ...first.pointer.trace.canvas } ) ) {
		unsupported.push( { selector, reason: `canvas drawing algorithm is not translated (observed ${ Object.keys( canvas.methods ).join( ', ' ) })` } );
	}
	const stepsEnd = steps.reduce( ( end, step ) => Math.max( end, revealEnd( first.startup.text[ step.selector ], learnTextReveals( first.startup ).find( ( row ) => row.selector === step.selector )!, settled[ step.selector ] ?? '' ) ), 0 );
	const unique = new Map( unsupported.map( ( row ) => [ `${ row.selector }\u0000${ row.reason }`, row ] ) );
	return {
		schema: LEARNED_MOTION_SCHEMA, steps, clock,
		settleMs: Math.min( 25000, Math.round( Math.max( stepsEnd, clockEnd ) * 1.25 + 1000 ) ),
		unsupported: [ ...unique.values() ],
	};
}

function revealStart( observed: SourceBehavior, step: MotionStep ): number {
	return learnTextReveals( observed.startup ).find( ( row ) => row.selector === step.selector )?.startMs ?? NaN;
}
