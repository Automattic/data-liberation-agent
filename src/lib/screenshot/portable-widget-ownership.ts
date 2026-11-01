import { isGoogleMapHost, isGoogleMapRuntimeOwned } from './rendered-google-maps.js';

/** Browser-side predicate shared by all interaction discovery paths. */
export const PORTABLE_WIDGET_OWNERSHIP_SOURCE = `(element) => (${isGoogleMapRuntimeOwned.toString()})(element, (${isGoogleMapHost.toString()}))`;
