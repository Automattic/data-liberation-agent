import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	sourceSignals: [
		{ pattern: /['"]base44_access_token['"]/, signal: "Base44 boot script token key ('base44_access_token') in page source" },
		{ pattern: /b\.base44\.(?:app|com|sh)/i, signal: 'Base44 host reference in page source' },
	],
};
