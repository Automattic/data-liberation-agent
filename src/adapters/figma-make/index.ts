import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { FIGMA_MAKE_PREVIEW_HOST, figmaMakeEntry } from './entry.js';

// Figma Make serves a project from its preview origin; the editor link only
// resolves to it. The preview is a plain client-rendered app with real links,
// so generic discovery and capture apply once its session is established.
export const figmaMakeAdapter: PlatformAdapter = {
	id: 'figma-make',
	detection: { urlPatterns: [ FIGMA_MAKE_PREVIEW_HOST ] },
	entry: figmaMakeEntry,
	discover: discoverDefault,
};
