import type { PlatformDetection } from '../../platform/types.js';

/** medium.com serves every author and publication under its first path segment. */
export const detection: PlatformDetection = {
	urlPatterns: [/^https?:\/\/(?:www\.)?medium\.com(?::\d+)?\/[^/?#]+/i],
};
