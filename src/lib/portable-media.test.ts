import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { planPortableMediaFamilies, type PortableMediaCandidate } from './portable-media-plan.js';
import { materializePortableMedia } from './portable-media.js';
import { materializePortableResources } from './portable-resources.js';
import { TRANSPARENT_IMAGE_DATA_URL } from './portable-assets.js';

it( 'hands collision/deduplication identities and failed-media replacements to resource fallback without mutating its seeds', () => {
	const tempRoot = join( process.cwd(), '.tmp-test' );
	mkdirSync( tempRoot, { recursive: true } );
	const root = mkdtempSync( join( tempRoot, 'portable-media-stage-' ) );
	try {
		const websiteDir = join( root, 'website' );
		mkdirSync( websiteDir );
		const candidate = ( family: string, content: string, dimension = 100 ): PortableMediaCandidate => {
			const dir = join( root, family ); mkdirSync( dir );
			const localPath = join( dir, 'same.bin' ); writeFileSync( localPath, content );
			return { sourceUrl: `https://example.test/${ family }.png`, localPath, references: [ `/${ family }.png` ], exactReferences: [ `/${ family }.png` ], bytes: Buffer.byteLength( content ), dimension };
		};
		const candidates = [ candidate( 'a', 'AAA' ), candidate( 'b', 'BBBB' ), candidate( 'dedup', 'AAA' ), candidate( 'oversize', 'x', 4000 ), candidate( 'budget', 'not-admitted' ) ];
		const htmlPath = join( root, 'page.html' );
		writeFileSync( htmlPath, '<img src="/a.png"><img src="/b.png"><img src="/dedup.png"><img src="/fallback.png">' );
		const plan = planPortableMediaFamilies( candidates.map( value => ( { family: value.sourceUrl, candidates: [ value ] } ) ), 7, htmlPath );
		const planBefore = JSON.stringify( plan );
		const retainedReferences = new Map( candidates.map( value => [ value.sourceUrl, value.references ] ) );
		const media = materializePortableMedia( {
			websiteDir, plan, maxBytes: 7, retainedReferences,
			failedMedia: [
				{ family: candidates[ 0 ].sourceUrl, sourceUrl: 'https://example.test/a.png?w=800', error: 'failed sibling', references: [ '/a.png?w=800' ] },
				{ family: 'https://example.test/fallback.png', sourceUrl: 'https://example.test/fallback.png', error: 'download failed', references: [ '/fallback.png' ] },
			],
		} );
		expect( JSON.stringify( plan ) ).toBe( planBefore );
		expect( media.assets.map( value => value.path ) ).toEqual( [ 'website/media/same.png', 'website/media/same-4a8d8134f29b.png' ] );
		expect( readFileSync( join( websiteDir, 'media/same.png' ), 'utf8' ) ).toBe( 'AAA' );
		expect( readFileSync( join( websiteDir, 'media/same-4a8d8134f29b.png' ), 'utf8' ) ).toBe( 'BBBB' );
		expect( media.portablePathsBySource.get( candidates[ 2 ].sourceUrl ) ).toBe( 'website/media/same.png' );
		expect( media.portableMedia ).toEqual( { selected_count: 2, selected_bytes: 7, retained_external_count: 2, max_bytes: 7, reserved_bytes: 0 } );
		expect( media.unresolvedMedia.map( value => value.url ) ).toEqual( [ candidates[ 3 ].sourceUrl, candidates[ 4 ].sourceUrl, 'https://example.test/fallback.png' ] );
		expect( media.mediaReplacements.get( '/fallback.png' ) ).toBe( TRANSPARENT_IMAGE_DATA_URL );
		const resources = materializePortableResources( {
			sourceRoot: root, websiteDir, entries: [ { url: 'https://example.test/', htmlPath } ],
			resourceManifest: { version: 1, resources: { 'https://example.test/fallback.png': { path: 'a/same.bin', contentType: 'image/png' } }, failures: [] },
			...media, embeddedSources: new Set(), projectEmbeddedHtml: html => html,
		} );
		expect( resources.mediaReplacements.get( '/fallback.png' ) ).toBe( '/media/same.png' );
		expect( resources.portablePathsBySource.get( 'https://example.test/fallback.png' ) ).toBe( 'website/media/same.png' );
		expect( resources.assets ).toEqual( [] );
		expect( media.mediaReplacements.get( '/fallback.png' ) ).toBe( TRANSPARENT_IMAGE_DATA_URL );
		expect( media.portablePathsBySource.has( 'https://example.test/fallback.png' ) ).toBe( false );
	} finally { rmSync( root, { recursive: true, force: true } ); }
} );
