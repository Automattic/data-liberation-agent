import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
	urlPatterns: [/^https?:\/\/(?:www\.)?soloist\.ai(?::\d+)?(?:\/|$)/i],
};
