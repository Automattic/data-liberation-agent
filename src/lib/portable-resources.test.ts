import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { materializePortableResources } from './portable-resources.js';
import { portableResourcePath, TRANSPARENT_IMAGE_DATA_URL } from './portable-assets.js';

it( 'names captured resources by served content type when the requested extension does not describe it', () => {
	// A font served by a script path (…/google-fonts.php?url=…woff2) is portable
	// only under its content-type extension: importers refuse script files.
	expect( portableResourcePath( 'resources/onewebstatic/google-fonts.php', 'font/woff2' ) ).toBe( 'onewebstatic/google-fonts.woff2' );
	expect( portableResourcePath( 'resources/a/font.aspx', 'font/woff' ) ).toBe( 'a/font.woff' );
	expect( portableResourcePath( 'resources/a/img.php', 'image/png' ) ).toBe( 'a/img.png' );
	// An extension that already describes the content keeps the requested name.
	expect( portableResourcePath( 'resources/a/x.woff2', 'font/woff2' ) ).toBe( 'a/x.woff2' );
	expect( portableResourcePath( 'resources/a/photo.jpeg', 'image/jpeg' ) ).toBe( 'a/photo.jpeg' );
	expect( portableResourcePath( 'resources/a/app.mjs', 'text/javascript' ) ).toBe( 'a/app.mjs' );
	// Extensionless paths take the content-type extension as before.
	expect( portableResourcePath( 'resources/a/fonts', 'font/woff2' ) ).toBe( 'a/fonts.woff2' );
	// Without a known portable extension the requested name is kept as-is.
	expect( portableResourcePath( 'resources/a/file.php', 'application/octet-stream' ) ).toBe( 'a/file.php' );
	expect( portableResourcePath( 'resources/a/blob', 'application/octet-stream' ) ).toBe( undefined );
} );

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

it( 'copies AVIF binary bytes unchanged when the response is mislabeled as text/plain', () => {
	mkdirSync( join( process.cwd(), '.tmp-test' ), { recursive: true } );
	const root = mkdtempSync( join( process.cwd(), '.tmp-test', 'portable-avif-' ) );
	try {
		mkdirSync( join( root, 'resources' ), { recursive: true } );
		const websiteDir = join( root, 'website' );
		const htmlPath = join( root, 'page.html' );
		const bytes = Buffer.concat( [ Buffer.from( [ 0, 0, 0, 24 ] ), Buffer.from( 'ftypavif' ), Buffer.from( [ 0x80, 0xff, 0xfe ] ) ] );
		writeFileSync( join( root, 'resources', 'image.avif' ), bytes );
		writeFileSync( htmlPath, '<img src="/image.avif">' );
		const result = materializePortableResources( {
			sourceRoot: root, websiteDir, entries: [ { url: 'https://example.test/', htmlPath } ],
			resourceManifest: { version: 1, failures: [], resources: {
				'https://example.test/image.avif': { path: 'resources/image.avif', contentType: 'text/plain' },
			} },
			mediaReplacements: new Map(), assetPathsByHash: new Map(), assetHashesByPath: new Map(), portablePathsBySource: new Map(),
			embeddedSources: new Set(), projectEmbeddedHtml: ( html ) => html,
		} );
		const outputPath = join( websiteDir, 'image.avif' );
		expect( readFileSync( outputPath ) ).toEqual( bytes );
		expect( createHash( 'sha256' ).update( readFileSync( outputPath ) ).digest( 'hex' ) ).toBe( createHash( 'sha256' ).update( bytes ).digest( 'hex' ) );
		expect( result.assets ).toHaveLength( 1 );
	} finally { rmSync( root, { recursive: true, force: true } ); }
} );

it( 'keeps text that starts with a font tag name as text', () => {
	const root = mkdtempSync( join( tmpdir(), 'portable-font-tag-text-' ) );
	try {
		mkdirSync( join( root, 'resources' ), { recursive: true } );
		const websiteDir = join( root, 'website' );
		const htmlPath = join( root, 'page.html' );
		// `true` is also the sfnt tag of Apple TrueType fonts; a real font has a small table count next.
		writeFileSync( join( root, 'resources', 'theme' ), 'true .note{background:url("/dot.png")}' );
		writeFileSync( join( root, 'resources', 'dot.png' ), Buffer.from( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ] ) );
		writeFileSync( htmlPath, '<link rel="stylesheet" href="/theme?v=1">' );
		materializePortableResources( {
			sourceRoot: root, websiteDir, entries: [ { url: 'https://example.test/', htmlPath } ],
			resourceManifest: { version: 1, failures: [], resources: {
				'https://example.test/theme?v=1': { path: 'resources/theme', contentType: 'text/css' },
				'https://example.test/dot.png': { path: 'resources/dot.png', contentType: 'image/png' },
			} },
			mediaReplacements: new Map(), assetPathsByHash: new Map(), assetHashesByPath: new Map(), portablePathsBySource: new Map(),
			embeddedSources: new Set(), projectEmbeddedHtml: ( html ) => html,
		} );
		expect( readFileSync( join( websiteDir, 'theme.css' ), 'utf8' ) ).toBe( 'true .note{background:url("/dot.png")}' );
		expect( existsSync( join( websiteDir, 'theme.ttf' ) ) ).toBe( false );
		expect( existsSync( join( websiteDir, 'dot.png' ) ) ).toBe( true );
	} finally { rmSync( root, { recursive: true, force: true } ); }
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

it( 'rewrites @font-face to the content-type name of a script-served font', () => {
	const root = mkdtempSync( join( tmpdir(), 'portable-script-font-' ) );
	try {
		mkdirSync( join( root, 'resources', 'onewebstatic' ), { recursive: true } );
		const websiteDir = join( root, 'website' );
		const htmlPath = join( root, 'staged-page.html' );
		writeFileSync( join( root, 'resources', 'onewebstatic', 'google-fonts.php' ), Buffer.concat( [ Buffer.from( 'wOF2' ), Buffer.from( [ 0, 1, 2, 3 ] ) ] ) );
		writeFileSync( join( root, 'resources', 'fonts.css' ), "@font-face{font-family:Probe;src:url('/onewebstatic/google-fonts.php?file=probe.woff2') format('woff2')}" );
		writeFileSync( htmlPath, '<link rel="stylesheet" href="/fonts.css">' );
		const result = materializePortableResources( {
			sourceRoot: root, websiteDir, entries: [ { url: 'https://example.test/', htmlPath } ],
			resourceManifest: { version: 1, failures: [], resources: {
				'https://example.test/fonts.css': { path: 'resources/fonts.css', contentType: 'text/css' },
				'https://example.test/onewebstatic/google-fonts.php?file=probe.woff2': { path: 'resources/onewebstatic/google-fonts.php', contentType: 'font/woff2' },
			} },
			mediaReplacements: new Map(), assetPathsByHash: new Map(), assetHashesByPath: new Map(), portablePathsBySource: new Map(),
			embeddedSources: new Set(), projectEmbeddedHtml: ( html ) => html,
		} );
		expect( existsSync( join( websiteDir, 'onewebstatic', 'google-fonts.woff2' ) ) ).toBe( true );
		expect( existsSync( join( websiteDir, 'onewebstatic', 'google-fonts.php' ) ) ).toBe( false );
		expect( result.assets.map( ( asset ) => asset.path ) ).toContain( 'website/onewebstatic/google-fonts.woff2' );
		expect( result.resourceReplacements.get( '/onewebstatic/google-fonts.php?file=probe.woff2' ) ).toBe( '/onewebstatic/google-fonts.woff2' );
		const css = readFileSync( join( websiteDir, 'fonts.css' ), 'utf8' );
		expect( css ).toContain( "url('/onewebstatic/google-fonts.woff2')" );
		expect( css ).not.toContain( '.php' );
	} finally { rmSync( root, { recursive: true, force: true } ); }
} );
