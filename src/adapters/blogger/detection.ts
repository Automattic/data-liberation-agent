import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	urlPatterns: [
		/^(?:[a-z0-9-]+\.)*blogspot\.[a-z]{2,3}(?:\.[a-z]{2})?$/i,
	],
	sourceSignals: [
		{
			pattern: /<meta\b(?=[^>]*\bname\s*=\s*['"]generator['"])(?=[^>]*\bcontent\s*=\s*['"]\s*blogger\s*['"])[^>]*>/i,
			signal: 'Blogger generator meta tag',
		},
		{
			// Blogger renders its layout runtime, bound to the blog's id, only for the
			// blog itself; custom templates often omit the generator meta.
			pattern: /_WidgetManager\._Init\(\s*['"](?:https?:)?\/\/www\.blogger\.com\/rearrange\?blogID(?:=|\\x3d)\d+/,
			signal: 'Blogger layout runtime',
		},
	],
};
