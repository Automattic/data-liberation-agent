import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	urlPatterns: [
		/^https?:\/\/(?:[a-z0-9-]+\.)*blogspot\.[a-z]{2,3}(?:\.[a-z]{2})?(?::\d+)?(?:[/?#]|$)/i,
	],
	sourceSignals: [
		{
			pattern: /<meta\b(?=[^>]*\bname\s*=\s*['"]generator['"])(?=[^>]*\bcontent\s*=\s*['"]\s*blogger\s*['"])[^>]*>/i,
			signal: 'Blogger generator meta tag',
		},
	],
};
