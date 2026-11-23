import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	hosts: [ 'amebaownd.com' ],
	// Custom domains keep the platform's own markers. Both are specific to
	// Ameba Ownd, so they win over the generic Next.js markers it also serves.
	sourceSignals: [
		{
			pattern: /<meta\b[^>]*\bcontent\s*=\s*["']amebaownd:\/\/public\/sites\/\d+/i,
			signal: 'Ameba Ownd app deep link meta tag',
		},
		{
			pattern: /<link\b[^>]*\bhref\s*=\s*["']https:\/\/static\.amebaowndme\.com\/madrid-frontend\/css\//i,
			signal: 'Ameba Ownd frontend stylesheet',
		},
	],
};
