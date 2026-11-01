import { describe, expect, it } from 'vitest';
import { ASSET_EVIDENCE_SCHEMA, MAX_ASSET_EVIDENCE_FILE_BYTES, serializeAssetEvidence } from './capture-export-evidence.js';

type Report = Parameters< typeof serializeAssetEvidence >[ 0 ];

function reportWith( assets: Report[ 'assets' ] ): Report {
	return {
		schema: ASSET_EVIDENCE_SCHEMA,
		assetCount: assets.length,
		assetCountExact: true,
		totalReferenceCount: assets.reduce( ( count, asset ) => count + asset.referenceCount, 0 ),
		assetsTruncated: false,
		referenceLimit: 100,
		coverage: { retainedRouteCount: 1000, documentCount: 1000 },
		assets,
	};
}

function asset( index: number ): Report[ 'assets' ][ number ] {
	const url = `https://cdn.example/${ index }/图片.png`;
	return {
		id: url, sourceUrl: url,
		outcome: 'successful', retrieval: 'retrieved', portable: 'included',
		path: `website/media/${ index }.png`, portableAssetId: `website/media/${ index }.png`,
		referenceCount: 1000, referencesTruncated: true,
		references: Array.from( { length: 100 }, ( _, route ) => ( {
			route: `https://example.com/${ route }/${ '长路径'.repeat( 30 ) }`,
			path: `website/${ route }/index.html`, document: 'desktop', reference: url,
		} ) ),
	};
}

describe( 'asset evidence byte budget', () => {
	it( 'bounds many-route evidence by trimming references, preserving all asset outcomes', () => {
		const report = reportWith( Array.from( { length: 1000 }, ( _, index ) => ( {
			...asset( index ), referenceCount: 100, referencesTruncated: false,
		} ) ) );
		// This fixture exceeds the budget even with compact JSON and the existing item caps.
		expect( Buffer.byteLength( JSON.stringify( report ) ) ).toBeGreaterThan( MAX_ASSET_EVIDENCE_FILE_BYTES );
		const serialized = serializeAssetEvidence( report );
		expect( Buffer.byteLength( serialized ) ).toBeLessThanOrEqual( MAX_ASSET_EVIDENCE_FILE_BYTES );
		expect( serializeAssetEvidence( report ) ).toBe( serialized );
		const bounded = JSON.parse( serialized );
		expect( bounded ).toMatchObject( {
			byteBudget: MAX_ASSET_EVIDENCE_FILE_BYTES, byteBudgetTruncated: true,
			referencesTruncated: true, assetsTruncated: false, assetCount: 1000, totalReferenceCount: 100_000,
		} );
		expect( bounded.assets ).toHaveLength( report.assets.length );
		for ( const [ index, retained ] of bounded.assets.entries() ) {
			const original = report.assets[ index ];
			expect( retained ).toEqual( { ...original, referencesTruncated: true, references: original.references.slice( 0, retained.references.length ) } );
			expect( retained.references.length ).toBeLessThan( original.references.length );
		}
	} );

	it( 'drops later assets only after emptying reference lists when outcome fields alone exceed the budget', () => {
		const report = reportWith( Array.from( { length: 500 }, ( _, index ) => ( {
			...asset( index ), outcome: 'failed' as const, error: 'failure 信息\n'.repeat( 3000 ),
		} ) ) );
		const serialized = serializeAssetEvidence( report );
		expect( Buffer.byteLength( serialized ) ).toBeLessThanOrEqual( MAX_ASSET_EVIDENCE_FILE_BYTES );
		const bounded = JSON.parse( serialized );
		expect( bounded ).toMatchObject( { byteBudgetTruncated: true, assetsTruncated: true, referencesTruncated: true, assetCount: 500 } );
		expect( bounded.assets.length ).toBeGreaterThan( 0 );
		expect( bounded.assets.length ).toBeLessThan( report.assets.length );
		expect( bounded.assets ).toEqual( report.assets.slice( 0, bounded.assets.length ).map( original => ( {
			...original, references: [], referencesTruncated: true,
		} ) ) );
	} );

	it( 'declares no byte truncation for small evidence and leaves the input untouched', () => {
		const report = reportWith( [ { ...asset( 0 ), referenceCount: 1, referencesTruncated: false, references: asset( 0 ).references.slice( 0, 1 ) } ] );
		const before = JSON.stringify( report );
		expect( JSON.parse( serializeAssetEvidence( report ) ) ).toMatchObject( {
			...report, byteBudget: MAX_ASSET_EVIDENCE_FILE_BYTES, byteBudgetTruncated: false, referencesTruncated: false,
		} );
		expect( JSON.stringify( report ) ).toBe( before );
	} );
} );
