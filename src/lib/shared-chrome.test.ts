import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { extractSharedChrome } from './shared-chrome.js';

it( 'counts each source path once when admitting exact shared regions', () => {
	const root = mkdtempSync( join( tmpdir(), 'dla-chrome-source-paths-' ) );
	try {
		// Two copies cannot pay for this part and two include directives. A
		// duplicate caller path must not invent a third occurrence or replacement.
		const header = `<header><nav>${ 'Source '.repeat( 25 ) }</nav></header>`;
		const html = `<!doctype html><html><body>${ header }<main>Content</main></body></html>`;
		for ( const path of [ 'index.html', 'about.html' ] ) writeFileSync( join( root, path ), html );
		extractSharedChrome( root, [ 'index.html', 'index.html', 'about.html' ] );
		expect( existsSync( join( root, 'parts' ) ) ).toBe( false );
		for ( const path of [ 'index.html', 'about.html' ] ) expect( readFileSync( join( root, path ), 'utf8' ) ).toBe( html );
	} finally { rmSync( root, { recursive: true, force: true } ); }
} );
