import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	httpSignals: [
		{ header: 'x-powered-by', value: 'Next.js', signal: 'X-Powered-By: Next.js header' },
	],
	sourceSignals: [
		{
			pattern: /<script\b[^>]*\ssrc\s*=\s*["'][^"']*\/_next\/static\/[^"']+\.js(?:\?[^"']*)?["']/i,
			signal: 'Next.js static bootstrap script in page source',
		},
		{
			pattern: /<script\b[^>]*\sid\s*=\s*["']__NEXT_DATA__["']/i,
			signal: 'Next.js __NEXT_DATA__ bootstrap script in page source',
		},
		{
			pattern: /<script\b[^>]*>[^<]*\bself\.__next_f\s*(?:=|\.push\s*\()/,
			signal: 'Next.js flight bootstrap script in page source',
		},
	],
};
