import { describe, expect, it } from 'vitest';
import { detectFromResponse } from '../../lib/detect-platform/detect-platform.js';
import { resolvePlatform } from '../../index.js';
import { discoverDefault } from '../default/discover.js';

describe('Base44 platform detection', () => {
	it.each([
		[
			`<script>var TOKEN_KEY='base44_access_token';</script>`,
		],
		[
			`fetch('https://b.base44.com/api').catch(function(){});`,
		],
	])('detects the boot script marker with medium confidence: %s', (html) => {
		expect(detectFromResponse(new Headers(), html)).toMatchObject({ platform: 'base44', confidence: 'medium' });
	});

	it.each([
		'<p>Local vendors read about base44 compliance rules.</p>',
		'<a href="/base44/access-token-guide">Auth guide</a>',
	])('does not infer the platform from editorial references: %s', (html) => {
		expect(detectFromResponse(new Headers(), html).platform).toBe('unknown');
	});

	it('resolves the registered adapter with generic discovery and the redirect seam', () => {
		const adapter = resolvePlatform('base44');
		if (!adapter) throw new Error('Missing registered Base44 adapter');
		expect(adapter.id).toBe('base44');
		expect(adapter.discover).toBe(discoverDefault);
		expect(adapter.liberation?.resolveClientRedirect).toBeTypeOf('function');
		expect(adapter.liberation?.removeSelectors).toBeUndefined();
	});
});
