import { GOOGLE_MAP_RUNTIME_ROOT } from './rendered-google-maps.js';

/**
 * Runtime roots whose descendants are replaced by a portable widget surface.
 * Widget porters declare ownership here so probes do not lift their private
 * controls or dialogs into independent site interactions. Use with closest()
 * in browser-side discovery, including surfaces created after a trigger click.
 */
export const PORTABLE_WIDGET_RUNTIME_ROOTS = [ GOOGLE_MAP_RUNTIME_ROOT ].join( ',' );
