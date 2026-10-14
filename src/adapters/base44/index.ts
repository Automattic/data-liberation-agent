import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { detection } from './detection.js';
import { resolveClientRedirect } from './redirect.js';

/**
 * Base44 publishes stateful application sites on a fixed asset bundle whose
 * runtime answers every route with HTTP 200 and owns routing after load.
 * Everything else about the copy stays generic: the default discovery walks
 * rendered links, and no extraction or cleanup rule is platform-owned. The
 * one hook is the client-side auth rewrite below — a members-only route the
 * runtime rewrites with `pushState` moments after boot, which the navigation
 * guard cannot observe.
 */
export const base44Adapter: PlatformAdapter = {
	id: 'base44',
	detection,
	discover: discoverDefault,
	liberation: {
		resolveClientRedirect,
	},
};
