import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	sourceSignals: [
		{ pattern: /cdn\d+\.bigcommerce\.com\/s-[\w-]+\/stencil\//i, signal: 'BigCommerce Stencil assets' },
		{ pattern: /\bBCData\b[\s\S]*?window\.stencil\b|window\.stencil\b[\s\S]*?\bBCData\b/, signal: 'BigCommerce Stencil bootstrap' },
		{ pattern: /<body\b[^>]*\bclass=["'][^"']*\b(?:default|category|product|page|blog|blog_post|brand|search)\b[^"']*["'][\s\S]*?\bdata-content-region\s*=/i, signal: 'Stencil template and content regions' },
	],
};
