import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	sourceSignals: [
		{
			pattern: /<meta\b(?=[^>]*\bname\s*=\s*["']generator["'])(?=[^>]*\bcontent\s*=\s*["']Odoo["'])[^>]*>/i,
			signal: 'Odoo generator meta',
		},
		{
			pattern: /<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["'](?:https?:\/\/[^/"']+)?\/web\/assets\//i,
			signal: 'Odoo /web/assets runtime',
		},
	],
};
