import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { materializePortableResources } from './portable-resources.js';
import { TRANSPARENT_IMAGE_DATA_URL } from './portable-assets.js';

it( 'owns recursive materialization and fallback promotion without changing media seed indexes', () => {
	const root = mkdtempSync( join( tmpdir(), 'portable-resources-' ) );
	try {
		const websiteDir = join( root, 'stage', 'website' );
		mkdirSync( join( websiteDir, 'media' ), { recursive: true } );
		mkdirSync( join( root, 'resources' ), { recursive: true } );
		const image = Buffer.from( [ 1, 2, 3, 4 ] );
		const hash = createHash( 'sha256' ).update( image ).digest( 'hex' );
		writeFileSync( join( websiteDir, 'media', 'selected.png' ), image );
		writeFileSync( join( root, 'resources', 'alias.png' ), image );
		writeFileSync( join( root, 'resources', 'a.css' ), "@import url('/b.css'); .hero{background:url('/alias.png')}" );
		writeFileSync( join( root, 'resources', 'b.css' ), "@import url('/a.css'); .lost{background:url('/missing.png')}" );
		writeFileSync( join( root, 'resources', 'app.json' ), JSON.stringify( { icons: [ { src: '/alias.png' } ] } ) );
		const htmlPath = join( root, 'staged-page.html' );
		writeFileSync( htmlPath, '<link rel="stylesheet" href="/a.css"><link rel="manifest" href="/app.json"><img src="/alias.png"><img src="/uncaptured.png">' );
		const mediaReplacements = new Map( [ [ '/alias.png', TRANSPARENT_IMAGE_DATA_URL ] ] );
		const assetPathsByHash = new Map( [ [ hash, 'media/selected.png' ] ] );
		const assetHashesByPath = new Map( [ [ 'media/selected.png', hash ] ] );
		const portablePathsBySource = new Map( [ [ 'https://example.test/selected.png', 'website/media/selected.png' ] ] );
		const result = materializePortableResources( {
			sourceRoot: root, websiteDir, entries: [ { url: 'https://example.test/', htmlPath } ],
			resourceManifest: { version: 1, failures: [], resources: {
				'https://example.test/a.css': { path: 'resources/a.css', contentType: 'text/css' },
				'https://example.test/b.css': { path: 'resources/b.css', contentType: 'text/css' },
				'https://example.test/alias.png': { path: 'resources/alias.png', contentType: 'image/png' },
				'https://example.test/app.json': { path: 'resources/app.json', contentType: 'application/manifest+json' },
			} },
			mediaReplacements, assetPathsByHash, assetHashesByPath, portablePathsBySource,
			embeddedSources: new Set(), projectEmbeddedHtml: ( html ) => html,
		} );
		// The media plan remains an independent input; only the resource result
		// contains fallback identities learned from captured responses.
		expect( [ ...mediaReplacements ] ).toEqual( [ [ '/alias.png', TRANSPARENT_IMAGE_DATA_URL ] ] );
		expect( [ ...portablePathsBySource ] ).toEqual( [ [ 'https://example.test/selected.png', 'website/media/selected.png' ] ] );
		expect( [ ...assetPathsByHash ] ).toEqual( [ [ hash, 'media/selected.png' ] ] );
		expect( [ ...assetHashesByPath ] ).toEqual( [ [ 'media/selected.png', hash ] ] );
		expect( result.mediaReplacements.get( '/alias.png' ) ).toBe( '/media/selected.png' );
		expect( result.portablePathsBySource.get( 'https://example.test/alias.png' ) ).toBe( 'website/media/selected.png' );
		expect( result.assets.map( ( asset ) => asset.path ) ).toEqual( [ 'website/b.css', 'website/a.css', 'website/app.json' ] );
		expect( existsSync( join( websiteDir, 'alias.png' ) ) ).toBe( false );
		expect( readFileSync( join( websiteDir, 'a.css' ), 'utf8' ) ).toContain( '/media/selected.png' );
		expect( readFileSync( join( websiteDir, 'b.css' ), 'utf8' ) ).toContain( 'about:blank' );
		expect( JSON.parse( readFileSync( join( websiteDir, 'app.json' ), 'utf8' ) ).icons[ 0 ].src ).toBe( '/media/selected.png' );
		expect( result.unresolvedDependencies.map( ( dependency ) => dependency.url ) ).toEqual( [ 'https://example.test/uncaptured.png', 'https://example.test/missing.png' ] );
		expect( readFileSync( htmlPath, 'utf8' ) ).toContain( TRANSPARENT_IMAGE_DATA_URL );
		expect( readFileSync( join( root, 'resources', 'alias.png' ) ) ).toEqual( image );
	} finally {
		rmSync( root, { recursive: true, force: true } );
	}
} );

it( 'applies embedded page policy while resolving child dependencies against its original base', () => {
	const root = mkdtempSync( join( tmpdir(), 'portable-embedded-' ) );
	try {
		mkdirSync( join( root, 'resources' ), { recursive: true } );
		const htmlPath = join( root, 'staged-page.html' );
		writeFileSync( htmlPath, '<iframe src="https://embedded.test/inner"></iframe>' );
		const child = '<base href="https://embedded.test/assets/"><img src="tile.svg"><script>runtime()</script>';
		writeFileSync( join( root, 'resources', 'inner.html' ), child );
		writeFileSync( join( root, 'resources', 'tile.svg' ), '<svg></svg>' );
		const policyInputs: string[] = [];
		const result = materializePortableResources( {
			sourceRoot: root, websiteDir: join( root, 'stage', 'website' ),
			entries: [ { url: 'https://example.test/', htmlPath } ],
			resourceManifest: { version: 1, failures: [], resources: {
				'https://embedded.test/inner': { path: 'resources/inner.html', contentType: 'text/html' },
				'https://embedded.test/assets/tile.svg': { path: 'resources/tile.svg', contentType: 'image/svg+xml' },
			} },
			mediaReplacements: new Map(), assetPathsByHash: new Map(), assetHashesByPath: new Map(), portablePathsBySource: new Map(),
			embeddedSources: new Set( [ 'https://embedded.test/inner' ] ),
			projectEmbeddedHtml: ( html ) => { policyInputs.push( html ); return html.replace( /<script>[\s\S]*?<\/script>/, '' ); },
		} );
		expect( policyInputs ).toEqual( [ child ] );
		expect( result.assets.map( ( asset ) => asset.path ) ).toEqual( [ 'website/tile.svg', 'website/inner.html' ] );
		const portable = readFileSync( join( root, 'stage', 'website', 'inner.html' ), 'utf8' );
		expect( portable ).toContain( 'src="/tile.svg"' );
		expect( portable ).not.toContain( '<script>' );
		expect( result.unresolvedDependencies ).toEqual( [] );
		expect( readFileSync( join( root, 'resources', 'inner.html' ), 'utf8' ) ).toBe( child );
	} finally { rmSync( root, { recursive: true, force: true } ); }
} );
