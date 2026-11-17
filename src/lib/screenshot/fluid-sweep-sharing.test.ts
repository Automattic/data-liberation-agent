import { describe, expect, it } from 'vitest';

import { type FluidSeriesMemo, reserveSweep, reuseSweptSeries } from './fluid-capture.js';
import type { GeometrySample } from './fluid-model.js';

const ladder = ( value: ( width: number ) => number, container: number ): GeometrySample[] =>
	[ 390, 600, 768, 1024, 1440, 1920 ].map( viewport => ( { viewport, value: value( viewport ), container } ) );
const probes = ( series: GeometrySample[], container: number ) =>
	series.filter( sample => [ 390, 768, 1920 ].includes( sample.viewport ) ).map( sample => ( { ...sample, container } ) );

describe( 'fluid sweep sharing', () => {
	it( 'reuses through the structural signature and ignores containers only for constant ladders', () => {
		const constant = ladder( () => 40, 300 );
		const varying = ladder( width => width * 0.3, 300 );
		const memo: FluidSeriesMemo = new Map( [
			[ 'desktop|s|rule', new Map( [ [ 'height', constant ] ] ) ],
			[ 'desktop|s|item', new Map( [ [ 'height', varying ] ] ) ],
		] );
		// Route-specific ids miss the anchored form; text-sized parents change every container.
		const keys: Record< string, string[] > = {
			'0': [ 'desktop|a|DIV.rule', 'desktop|s|rule' ],
			'1': [ 'desktop|a|DIV#pgi84e2', 'desktop|s|item' ],
		};
		const observed = new Map( [ [ '0:height', probes( constant, 900 ) ], [ '1:height', probes( varying, 900 ) ] ] );
		const reused = reuseSweptSeries( observed, id => keys[ id ] ?? [], memo );
		expect( [ ...reused.keys() ] ).toEqual( [ '0:height' ] );
		expect( reused.get( '0:height' ) ).toEqual( constant );
		// The varying ladder is reused when its containers answer the same.
		expect( [ ...reuseSweptSeries( new Map( [ [ '1:height', probes( varying, 300 ) ] ] ), id => keys[ id ] ?? [], memo ).keys() ] ).toEqual( [ '1:height' ] );
	} );

	it( 'sweeps independently once another route has held the reservation past the bound', async () => {
		const memo: FluidSeriesMemo = new Map();
		const holder = await reserveSweep( memo, [ 'a', 'b' ] );
		expect( holder.waitedMs ).toBe( 0 );
		const waiter = await reserveSweep( memo, [ 'b' ], 20 );
		expect( waiter.waitedMs ).toBeGreaterThanOrEqual( 15 );
		// The stalled holder's keys stay its own; a released holder frees them.
		holder.release();
		expect( ( await reserveSweep( memo, [ 'a', 'b' ], 20 ) ).waitedMs ).toBeLessThan( 15 );
	} );
} );
