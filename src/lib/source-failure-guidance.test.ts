import { describe, expect, it } from 'vitest';
import { allocateCaptureRoutes } from './capture-export-routes.js';
import { safeFetch } from './media-fetch/safe-fetch.js';

const source = 'https://example.com/';

describe('source failure guidance', () => {
	it.each([
		{ reason: 'desktop/goto: HTTP 401; mobile/goto: HTTP 401', guidance: 'The page needs a login; send the published public URL or an export of the site.' },
		{ reason: 'desktop/goto: HTTP 403; mobile/goto: HTTP 403', guidance: 'The site refused the request; send a publicly accessible URL or an export.' },
		{ reason: 'desktop/goto: Not an HTML document (application/json); mobile/goto: Not an HTML document (application/json)', guidance: "The URL returns application/json, not a web page; send the address of the site's HTML homepage." },
		{ reason: 'Not an HTML document (text/plain)', guidance: "The URL returns text/plain, not a web page; send the address of the site's HTML homepage." },
		{ reason: 'HTTP 404', guidance: '' },
		{ reason: 'certificate has expired', code: 'CERT_HAS_EXPIRED', guidance: "The site's HTTPS certificate is invalid (expired or self-signed); fix the certificate or send an export." },
		{ reason: 'self-signed certificate', code: 'DEPTH_ZERO_SELF_SIGNED_CERT', guidance: "The site's HTTPS certificate is invalid (expired or self-signed); fix the certificate or send an export." },
		{ reason: 'read ECONNRESET', code: 'ECONNRESET', guidance: '' },
	])('preserves the reason and supplies actionable guidance: $reason', async ({ reason, code, guidance }) => {
		let error: unknown;
		let original: string;
		if (code) {
			const cause = Object.assign(new Error(reason), { code });
			const fetchImpl = (async () => { throw new TypeError('fetch failed', { cause }); }) as typeof fetch;
			error = await safeFetch(source, { fetchImpl }).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(TypeError);
			expect((error as Error).cause).toBe(cause);
			original = `fetch failed: ${reason}${reason.includes(code) ? '' : ` (${code})`}`;
		} else {
			try {
				allocateCaptureRoutes([], source, [], [{ url: source, code: 'route_capture_failed', reason }]);
			} catch (caught) {
				error = caught;
			}
			original = `Source homepage ${source} was not captured: ${reason}`;
		}
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toBe(original + (guidance ? `. ${guidance}` : ''));
		expect(message.length).toBeLessThanOrEqual(360);
	});
});
