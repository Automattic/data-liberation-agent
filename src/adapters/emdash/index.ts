import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { detection } from './detection.js';

// EmDash emits a standard per-collection sitemap index and ordinary Astro
// markup, and ships no source-attribution chrome, so the generic discovery
// covers it; the adapter's job is recognizing the platform.
export const emdashAdapter: PlatformAdapter = {
	id: 'emdash',
	detection,
	discover: discoverDefault,
};
