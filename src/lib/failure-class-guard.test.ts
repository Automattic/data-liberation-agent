/**
 * Classification guard for the capture → export runtime (#761 contract item 4,
 * #762 "Guard").
 *
 * Every `throw`, `Promise.reject(…)` and `reject(…)` call inside a `new Promise`
 * executor in a production file on that path must declare how it fails:
 *
 * - it throws `IntegrityError` (or a subclass), or another error class mapped
 *   in `ERROR_CLASS_FAILURE_CLASS` below; or
 * - it carries `// failure-class: <class>` on the same line or the line above,
 *   where `<class>` is `integrity`, `operational`, `programmer` or
 *   `representability:<unit>`.
 *
 * Sites that were unclassified when the guard landed are listed in
 * `failure-class-baseline.json`, keyed by file and normalized site text (not
 * line numbers). That baseline can only shrink: a new unclassified site fails,
 * and so does an entry whose site no longer exists.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type FailureClass = 'integrity' | 'operational' | 'programmer' | 'representability';

/** Units a representability loss can be confined to; the `RouteDiagnostic.unit` vocabulary plus #761's. */
const REPRESENTABILITY_UNITS = new Set( [ 'item', 'block', 'page', 'route', 'asset', 'stylesheet', 'profile' ] );

/**
 * Error classes whose every throw is classified by the class itself. Subclasses
 * inherit their base's mapping. Built-in programmer errors match
 * `isIntegrityError`, which fails them closed.
 */
const ERROR_CLASS_FAILURE_CLASS: Record<string, FailureClass> = {
	IntegrityError: 'integrity',
	TypeError: 'programmer',
	RangeError: 'programmer',
	ReferenceError: 'programmer',
	SyntaxError: 'programmer',
	EvalError: 'programmer',
	TimeoutError: 'operational',
	BodyTooLargeError: 'operational',
};

const ROOT = fileURLToPath( new URL( '../..', import.meta.url ) );
const BASELINE_PATH = fileURLToPath( new URL( './failure-class-baseline.json', import.meta.url ) );

/**
 * The capture → export runtime: discovery, adapters, browser capture, replicate,
 * assembly and export. The other verbs (`compare`, `publish`, `inspect`) and
 * the `--serve` preview are out of scope.
 */
const SCOPE_ROOTS = [ 'src/lib', 'src/adapters' ];
const OUT_OF_SCOPE = [
	/^src\/lib\/fidelity\//,
	/^src\/lib\/publish\//,
	/^src\/lib\/inspect[^/]*\.ts$/,
	/^src\/lib\/site-preview\.ts$/,
	/^src\/lib\/serve-capture\.ts$/,
	/\/fixtures\//,
];

interface Site {
	file: string;
	line: number;
	key: string;
	failureClass?: string;
	via?: 'class' | 'annotation';
}

interface Collected {
	sites: Site[];
	malformed: string[];
}

function scopeFiles(): string[] {
	const files: string[] = [];
	const walk = ( dir: string ) => {
		for ( const entry of readdirSync( join( ROOT, dir ), { withFileTypes: true } ) ) {
			const path = `${ dir }/${ entry.name }`;
			if ( entry.isDirectory() ) walk( path );
			else if ( /\.tsx?$/.test( entry.name ) && ! /\.test\.tsx?$/.test( entry.name ) && ! entry.name.endsWith( '.d.ts' ) && ! OUT_OF_SCOPE.some( pattern => pattern.test( path ) ) ) files.push( path );
		}
	};
	for ( const dir of SCOPE_ROOTS ) walk( dir );
	return files.sort();
}

function sourceFile( file: string, text: string ): ts.SourceFile {
	return ts.createSourceFile( file, text, ts.ScriptTarget.Latest, true, file.endsWith( '.tsx' ) ? ts.ScriptKind.TSX : ts.ScriptKind.TS );
}

/** `class A extends B` across every production file, so subclasses inherit a mapped base. */
function errorHeritage( sources: ts.SourceFile[] ): Map<string, string> {
	const heritage = new Map<string, string>();
	for ( const source of sources ) {
		const visit = ( node: ts.Node ) => {
			if ( ts.isClassLike( node ) && node.name ) {
				const base = node.heritageClauses?.find( clause => clause.token === ts.SyntaxKind.ExtendsKeyword )?.types[ 0 ]?.expression;
				if ( base && ts.isIdentifier( base ) ) heritage.set( node.name.text, base.text );
			}
			ts.forEachChild( node, visit );
		};
		visit( source );
	}
	return heritage;
}

function mappedClass( name: string, heritage: Map<string, string> ): FailureClass | undefined {
	for ( let current: string | undefined = name, depth = 0; current && depth < 20; current = heritage.get( current ), depth++ ) {
		if ( ERROR_CLASS_FAILURE_CLASS[ current ] ) return ERROR_CLASS_FAILURE_CLASS[ current ];
	}
	return undefined;
}

const normalize = ( text: string ) => text.replace( /\s+/g, ' ' ).trim();

const ANNOTATION = /\/\/\s*failure-class:\s*(\S*)/;

function parseAnnotation( value: string ): string | undefined {
	if ( value === 'integrity' || value === 'operational' || value === 'programmer' ) return value;
	const [ kind, unit, ...rest ] = value.split( ':' );
	if ( kind === 'representability' && unit && ! rest.length && REPRESENTABILITY_UNITS.has( unit ) ) return value;
	return undefined;
}

/** Collects every throw/reject site in one file with its classification, if any. */
function collectSites( file: string, source: ts.SourceFile, heritage: Map<string, string> ): Collected {
	const lines = source.text.split( '\n' );
	const sites: Site[] = [];
	const malformed: string[] = [];

	const record = ( node: ts.Node, key: string, thrown: ts.Expression | undefined ) => {
		const line = source.getLineAndCharacterOfPosition( node.getStart( source ) ).line;
		const site: Site = { file, line: line + 1, key };
		for ( const annotationLine of [ line, line - 1 ] ) {
			const match = lines[ annotationLine ]?.match( ANNOTATION );
			if ( ! match ) continue;
			const failureClass = parseAnnotation( match[ 1 ] );
			if ( failureClass ) {
				site.failureClass = failureClass;
				site.via = 'annotation';
			} else malformed.push( `${ file }:${ annotationLine + 1 } "failure-class: ${ match[ 1 ] }" (expected integrity, operational, programmer or representability:<${ [ ...REPRESENTABILITY_UNITS ].join( '|' ) }>)` );
			break;
		}
		if ( ! site.failureClass && thrown && ts.isNewExpression( thrown ) && ts.isIdentifier( thrown.expression ) ) {
			const failureClass = mappedClass( thrown.expression.text, heritage );
			if ( failureClass ) {
				site.failureClass = failureClass;
				site.via = 'class';
			}
		}
		sites.push( site );
	};

	const callText = ( callee: string, call: ts.CallExpression ) => `${ callee }(${ normalize( call.arguments.map( argument => argument.getText( source ) ).join( ', ' ) ) })`;

	const visit = ( node: ts.Node, rejectNames: ReadonlySet<string> ) => {
		if ( ts.isThrowStatement( node ) ) {
			record( node, `throw ${ normalize( node.expression.getText( source ) ) }`, node.expression );
		} else if ( ts.isCallExpression( node ) ) {
			const callee = node.expression;
			if ( ts.isPropertyAccessExpression( callee ) && ts.isIdentifier( callee.expression ) && callee.expression.text === 'Promise' && callee.name.text === 'reject' ) {
				record( node, callText( 'Promise.reject', node ), node.arguments[ 0 ] );
			} else if ( ts.isIdentifier( callee ) && rejectNames.has( callee.text ) ) {
				record( node, callText( 'reject', node ), node.arguments[ 0 ] );
			}
		}
		if ( ts.isNewExpression( node ) && ts.isIdentifier( node.expression ) && node.expression.text === 'Promise' ) {
			const executor = node.arguments?.[ 0 ];
			const rejectParam = executor && ( ts.isArrowFunction( executor ) || ts.isFunctionExpression( executor ) ) ? executor.parameters[ 1 ]?.name : undefined;
			if ( rejectParam && ts.isIdentifier( rejectParam ) ) {
				const names = new Set( rejectNames ).add( rejectParam.text );
				ts.forEachChild( node, child => visit( child, names ) );
				return;
			}
		}
		ts.forEachChild( node, child => visit( child, rejectNames ) );
	};
	visit( source, new Set() );
	return { sites, malformed };
}

type Baseline = Record<string, Record<string, number>>;

function tally( sites: Site[] ): Baseline {
	const counts: Baseline = {};
	for ( const site of sites ) {
		counts[ site.file ] ??= {};
		counts[ site.file ][ site.key ] = ( counts[ site.file ][ site.key ] ?? 0 ) + 1;
	}
	return counts;
}

describe( 'failure-class guard', () => {
	it( 'classifies sites by error class and by annotation, and reports malformed annotations', () => {
		const text = [
			'class Contained extends IntegrityError {}',
			'function f( ok: boolean ) {',
			'	if ( ok ) throw new Contained( "boundary" );',
			'	throw new TypeError( "bad argument" );',
			'	// failure-class: representability:route',
			'	throw new Error( "unsupported route" );',
			'	throw new Error( "budget" ); // failure-class: operational',
			'	// failure-class: representability',
			'	throw new Error( "no unit" );',
			'	throw new Error( `new ${ ok }`   + "limit" );',
			'	return new Promise( ( resolve, fail ) => { fail( new Error( "late" ) ); Promise.reject( error ); } );',
			'}',
		].join( '\n' );
		const source = sourceFile( 'fixture.ts', text );
		const { sites, malformed } = collectSites( 'fixture.ts', source, errorHeritage( [ source ] ) );
		expect( sites.map( ( { key, failureClass, via } ) => ( { key, failureClass, via } ) ) ).toEqual( [
			{ key: 'throw new Contained( "boundary" )', failureClass: 'integrity', via: 'class' },
			{ key: 'throw new TypeError( "bad argument" )', failureClass: 'programmer', via: 'class' },
			{ key: 'throw new Error( "unsupported route" )', failureClass: 'representability:route', via: 'annotation' },
			{ key: 'throw new Error( "budget" )', failureClass: 'operational', via: 'annotation' },
			{ key: 'throw new Error( "no unit" )', failureClass: undefined, via: undefined },
			{ key: 'throw new Error( `new ${ ok }` + "limit" )', failureClass: undefined, via: undefined },
			{ key: 'reject(new Error( "late" ))', failureClass: undefined, via: undefined },
			{ key: 'Promise.reject(error)', failureClass: undefined, via: undefined },
		] );
		expect( malformed ).toEqual( [ expect.stringContaining( 'fixture.ts:8 "failure-class: representability"' ) ] );
	} );

	it( 'requires every capture → export throw and reject site to be classified or baselined', () => {
		const files = scopeFiles();
		const sources = files.map( file => sourceFile( file, readFileSync( join( ROOT, file ), 'utf8' ) ) );
		const heritage = errorHeritage( sources );
		const collected = sources.map( ( source, index ) => collectSites( files[ index ], source, heritage ) );
		const sites = collected.flatMap( result => result.sites );
		const malformed = collected.flatMap( result => result.malformed );
		const unclassified = sites.filter( site => ! site.failureClass );

		const baseline = JSON.parse( readFileSync( BASELINE_PATH, 'utf8' ) ).sites as Baseline;
		const actual = tally( unclassified );
		const added: string[] = [];
		const stale: string[] = [];
		for ( const file of new Set( [ ...Object.keys( actual ), ...Object.keys( baseline ) ] ) ) {
			for ( const key of new Set( [ ...Object.keys( actual[ file ] ?? {} ), ...Object.keys( baseline[ file ] ?? {} ) ] ) ) {
				const have = actual[ file ]?.[ key ] ?? 0;
				const allowed = baseline[ file ]?.[ key ] ?? 0;
				if ( have > allowed ) {
					for ( const site of unclassified.filter( entry => entry.file === file && entry.key === key ).slice( allowed ) ) added.push( `${ file }:${ site.line } ${ key }` );
				} else if ( have < allowed ) stale.push( `${ file }: ${ JSON.stringify( key ) } (baseline ${ allowed }, found ${ have })` );
			}
		}

		const summary = ( [ 'integrity', 'operational', 'programmer', 'representability' ] as const ).map( failureClass => {
			const classified = sites.filter( site => site.failureClass?.split( ':' )[ 0 ] === failureClass );
			return `  ${ failureClass }: ${ classified.length } (by error class ${ classified.filter( site => site.via === 'class' ).length }, by annotation ${ classified.filter( site => site.via === 'annotation' ).length })`;
		} );
		console.log( `failure-class guard: ${ sites.length } sites in ${ files.length } files\n${ summary.join( '\n' ) }\n  unclassified (baseline): ${ unclassified.length }` );

		const problems: string[] = [];
		if ( malformed.length ) problems.push( `Malformed failure-class annotations:\n  ${ malformed.join( '\n  ' ) }` );
		if ( added.length ) problems.push( `Unclassified throw/reject sites. Throw an IntegrityError (or a mapped class) or annotate the line with "// failure-class: integrity|operational|programmer|representability:<unit>" (see "Failure classes" in AGENTS.md):\n  ${ added.join( '\n  ' ) }` );
		if ( stale.length ) problems.push( `Stale baseline entries in src/lib/failure-class-baseline.json. These sites are now classified or gone; lower or delete each entry so the baseline only shrinks:\n  ${ stale.join( '\n  ' ) }` );
		expect( problems.join( '\n\n' ) ).toBe( '' );
	} );
} );
