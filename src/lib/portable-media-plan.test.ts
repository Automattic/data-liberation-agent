import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	containsMediaReference,
	indexPortableMediaReferences,
	mediaReferenceMatched,
	planPortableMediaFamilies,
	type PortableMediaCandidate,
} from './portable-media-plan.js';

const dirs: string[] = [];
afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

function tempDir( name: string ): string {
	mkdirSync( '.tmp-test', { recursive: true } );
	const dir = mkdtempSync( join( '.tmp-test', name ) );
	dirs.push( dir );
	return dir;
}

function candidate(
	dir: string,
	name: string,
	url: string,
	bytes: number,
	dimension: number,
	fill = name.charCodeAt( 0 ),
): PortableMediaCandidate {
	const localPath = join( dir, name );
	writeFileSync( localPath, Buffer.alloc( bytes, fill ) );
	return {
		sourceUrl: url,
		localPath,
		references: [ url ],
		exactReferences: [ url ],
		bytes,
		dimension,
	};
}

describe( 'containsMediaReference', () => {
	it( 'matches quoted punctuation, comma, HTML-entity, and percent spellings on raw HTML', () => {
		const quoted = "https://static.wixstatic.com/media/Happy%20Women's%20Day.jpg";
		const comma = 'https://cdn.example/media/asset~mv2.png/v1/fill/w_58,h_57,al_c/file.png';
		const entity = 'https://cdn.example/q.png?w=1&h=2';
		const percent = 'https://cdn.example/crop/rs=h:100%25,cg:true';
		const html =
			`<img srcset="${ quoted } 1x, ${ comma } 2x">` +
			`<img src="${ entity.replace( /&/g, '&amp;' ) }">` +
			`<div data-src="${ percent }"></div>` +
			`<div data-config="{&quot;assetUrl&quot;:&quot;${ entity.replace( /&/g, '&amp;' ) }&quot;}"></div>`;

		expect( containsMediaReference( html, quoted ) ).toBe( true );
		expect( containsMediaReference( html, comma ) ).toBe( true );
		expect( containsMediaReference( html, entity ) ).toBe( true );
		expect( containsMediaReference( html, percent ) ).toBe( true );
		expect( containsMediaReference( html, percent.replace( '%25', '%' ) ) ).toBe( false );
	} );

	it( 'keeps the query and amp-entity boundary instead of a raw prefix match', () => {
		expect(
			containsMediaReference( 'https://cdn.example/hero.png?w=128', 'https://cdn.example/hero.png' )
		).toBe( false );
		expect(
			containsMediaReference( 'https://cdn.example/avatar.png&amp;quot;', 'https://cdn.example/avatar.png' )
		).toBe( false );
		expect(
			containsMediaReference( 'https://example.com/hero.png?w=1280', 'https://example.com/hero.png?w=128' )
		).toBe( true );
	} );
} );

describe( 'indexPortableMediaReferences', () => {
	it( 'matches the raw boundary check one page at a time', () => {
		const dir = tempDir( 'dla-media-index-' );
		const quoted = "https://static.wixstatic.com/media/Happy%20Women's%20Day.jpg";
		const comma = 'https://cdn.example/media/asset~mv2.png/v1/fill/w_58,h_57,al_c/file.png';
		const entity = 'https://cdn.example/q.png?w=1&h=2';
		const percent = 'https://cdn.example/crop/rs=h:100%25,cg:true';
		const prefix = 'https://cdn.example/hero.png';
		const pages = [
			join( dir, 'home.html' ),
			join( dir, 'other.html' ),
		];
		writeFileSync(
			pages[ 0 ],
			`<img srcset="${ quoted } 1x, ${ comma } 2x"><img src="${ entity.replace( /&/g, '&amp;' ) }">`
		);
		writeFileSync( pages[ 1 ], `<div data-src="${ percent }"></div><div data-src="${ prefix }?w=128"></div>` );
		const references = [ quoted, comma, entity, percent, prefix ];
		const index = indexPortableMediaReferences( pages, references );

		expect( index.indexed ).toEqual( new Set( references ) );
		expect( [ ...index.matched ] ).toEqual( [ quoted, comma, entity, percent ] );
		for ( const reference of references ) {
			const direct = pages.some( ( page ) =>
				containsMediaReference( readFileSync( page, 'utf8' ), reference )
			);
			expect( mediaReferenceMatched( index, reference ) ).toBe( direct );
		}
		expect( () => mediaReferenceMatched( index, 'https://cdn.example/missing.png' ) ).toThrow(
			/was not indexed/
		);
	} );

	it( 'drops each page before reading the next under a constrained heap', () => {
		const dir = tempDir( 'dla-media-index-heap-' );
		const pageBytes = 8 * 1024 * 1024;
		const pageCount = 4;
		const home = 'https://cdn.example/home.png';
		const needle = 'https://cdn.example/needle.png';
		const pages = Array.from( { length: pageCount }, ( _, index ) => join( dir, `page-${ index }.html` ) );
		for ( const [ index, page ] of pages.entries() ) {
			const marker = index === 0 ? home : index === pageCount - 1 ? needle : '';
			writeFileSync( page, `${ 'x'.repeat( pageBytes ) }\n${ marker }\n` );
		}
		const runnerPath = join( dir, 'index-under-limit.ts' );
		writeFileSync(
			runnerPath,
			`import { indexPortableMediaReferences } from ${ JSON.stringify(
				new URL( './portable-media-plan.ts', import.meta.url ).href
			) };
const pages = ${ JSON.stringify( pages ) };
global.gc();
const before = process.memoryUsage().heapUsed;
const index = indexPortableMediaReferences( pages, [ ${ JSON.stringify( home ) }, ${ JSON.stringify( needle ) } ] );
if ( ! index.matched.has( ${ JSON.stringify( home ) } ) ) throw new Error( 'missed first-page reference' );
if ( ! index.matched.has( ${ JSON.stringify( needle ) } ) ) throw new Error( 'missed last-page reference' );
global.gc();
const retained = process.memoryUsage().heapUsed - before;
if ( retained > 6 * 1024 * 1024 ) throw new Error( 'reference index retained ' + retained + ' bytes' );
`
		);
		const result = spawnSync(
			process.execPath,
			[ '--expose-gc', '--max-old-space-size=128', '--import', 'tsx', runnerPath ],
			{ cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 }
		);
		expect( result.error ).toBeUndefined();
		expect( result.status, result.stderr ).toBe( 0 );
	}, 70_000 );
} );

describe( 'planPortableMediaFamilies', () => {
	it( 'admits by homepage priority, then eligible first bytes, then source URL, independent of insertion order', () => {
		const dir = tempDir( 'dla-media-plan-order-' );
		const homepage = join( dir, 'home.html' );
		writeFileSync( homepage, '<main><img src="https://cdn.example/z-home.png"></main>' );
		const home = candidate( dir, 'z-home.png', 'https://cdn.example/z-home.png', 1500, 0 );
		const other = candidate( dir, 'a-other.png', 'https://cdn.example/a-other.png', 1000, 0 );
		const large = candidate( dir, 'a-large.png', 'https://cdn.example/a-large.png', 3000, 100 );
		const smallRendition = candidate( dir, 'a-small.png', 'https://cdn.example/a-small.png', 100, 10 );
		const modest = candidate( dir, 'b-modest.png', 'https://cdn.example/b-modest.png', 200, 0 );
		const tiedLater = candidate( dir, 'z-tied.png', 'https://cdn.example/z-tied.png', 1000, 0, 9 );
		const tiedEarlier = candidate( dir, 'a-tied.png', 'https://cdn.example/a-tied.png', 1000, 0, 8 );
		const emptyHomepage = join( dir, 'empty.html' );
		writeFileSync( emptyHomepage, '<main></main>' );

		const admitted = ( families: Array< { family: string; candidates: PortableMediaCandidate[] } >, budget: number ) =>
			planPortableMediaFamilies( families, budget, homepage ).families.map( ( decision ) => ( {
				family: decision.family,
				outcome: decision.outcome,
				admitted: decision.admitted.map( ( item ) => item.sourceUrl ),
			} ) );

		const homepageFirst = admitted(
			[
				{ family: other.sourceUrl, candidates: [ other ] },
				{ family: home.sourceUrl, candidates: [ home ] },
			],
			1500,
		);
		const homepageSecond = admitted(
			[
				{ family: home.sourceUrl, candidates: [ home ] },
				{ family: other.sourceUrl, candidates: [ other ] },
			],
			1500,
		);
		expect( homepageFirst.map( ( decision ) => decision.family ) ).toEqual( [
			other.sourceUrl,
			home.sourceUrl,
		] );
		expect( homepageFirst.find( ( decision ) => decision.family === home.sourceUrl ) ).toMatchObject( {
			outcome: 'selected',
			admitted: [ home.sourceUrl ],
		} );
		expect( homepageFirst.find( ( decision ) => decision.family === other.sourceUrl ) ).toMatchObject( {
			outcome: 'budget-excluded',
			admitted: [],
		} );
		expect( homepageSecond.find( ( decision ) => decision.outcome === 'selected' )?.admitted ).toEqual( [
			home.sourceUrl,
		] );

		const byteOrders = [
			[
				{ family: large.sourceUrl, candidates: [ large, smallRendition ] },
				{ family: modest.sourceUrl, candidates: [ modest ] },
			],
			[
				{ family: modest.sourceUrl, candidates: [ modest ] },
				{ family: large.sourceUrl, candidates: [ smallRendition, large ] },
			],
		];
		for ( const families of byteOrders ) {
			const plan = planPortableMediaFamilies( families, 250, emptyHomepage );
			const decided = plan.families;
			expect( decided.map( ( decision ) => decision.family ) ).toEqual( families.map( ( family ) => family.family ) );
			expect( decided.find( ( decision ) => decision.family === modest.sourceUrl )?.admitted.map( ( item ) => item.sourceUrl ) ).toEqual( [
				modest.sourceUrl,
			] );
			expect( decided.find( ( decision ) => decision.family === large.sourceUrl ) ).toMatchObject( {
				outcome: 'budget-excluded',
				admitted: [],
			} );
			expect( plan.selectedBytes ).toBe( modest.bytes );
		}

		const urlPlan = planPortableMediaFamilies(
			[
				{ family: tiedLater.sourceUrl, candidates: [ tiedLater ] },
				{ family: tiedEarlier.sourceUrl, candidates: [ tiedEarlier ] },
			],
			1000,
			emptyHomepage,
		);
		expect( urlPlan.families.find( ( decision ) => decision.outcome === 'selected' )?.family ).toBe(
			tiedEarlier.sourceUrl
		);
		expect( urlPlan.families.find( ( decision ) => decision.outcome === 'budget-excluded' )?.family ).toBe(
			tiedLater.sourceUrl
		);
	} );

	it( 'reuses one content hash without charging the budget twice', () => {
		const dir = tempDir( 'dla-media-plan-dedupe-' );
		const homepage = join( dir, 'home.html' );
		writeFileSync( homepage, '<main></main>' );
		const first = candidate( dir, 'first.png', 'https://cdn.example/first.png', 400, 0, 7 );
		const second = candidate( dir, 'second.png', 'https://cdn.example/second.png', 400, 0, 7 );
		const plan = planPortableMediaFamilies(
			[
				{ family: second.sourceUrl, candidates: [ second ] },
				{ family: first.sourceUrl, candidates: [ first ] },
			],
			400,
			homepage,
		);
		expect( plan.families.every( ( decision ) => decision.outcome === 'selected' ) ).toBe( true );
		expect( plan.selectedBytes ).toBe( 400 );
	} );
} );
