import { describe, expect, it } from 'vitest';
import { preparePortableReplacements } from './portable-references.js';

describe( 'preparePortableReplacements', () => {
	it( 'resolves URL attributes to captured identities while preserving fragments', () => {
		const rewrite = preparePortableReplacements( new Map( [
			[ 'https://example.test/icons/sprite.svg?v=1&theme=dark', '/assets/sprite.svg' ],
		] ) );
		const html = '<svg><use href="../icons/sprite.svg?v=1&amp;theme=dark#a"/><use xlink:href="https://example.test/icons/sprite.svg?v=1&amp;theme=dark#b"/><use href="#inline"/><use href="https://other.test/icons/sprite.svg?v=1&amp;theme=dark#a"/><use href="../icons/sprite.svg?v=2#a"/></svg>';
		expect( rewrite( html, 'https://example.test/news/' ) ).toBe(
			'<svg><use href="/assets/sprite.svg#a"/><use xlink:href="/assets/sprite.svg#b"/><use href="#inline"/><use href="https://other.test/icons/sprite.svg?v=1&amp;theme=dark#a"/><use href="../icons/sprite.svg?v=2#a"/></svg>'
		);
	} );
} );
