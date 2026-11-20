import { isGoogleMapHost, isGoogleMapRuntimeOwned } from './rendered-google-maps.js';

/** Browser-side predicate shared by all interaction discovery paths. */
export const PORTABLE_WIDGET_OWNERSHIP_SOURCE = `(element) => Boolean(element.closest('[data-blocks-engine-capture-runtime-owner],[data-blocks-engine-capture-runtime-owner-script]')) || (${isGoogleMapRuntimeOwned.toString()})(element, (${isGoogleMapHost.toString()}))`;
