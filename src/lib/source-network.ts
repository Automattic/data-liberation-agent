import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

// Node's 250 ms per-address default can abandon a reachable origin before its
// TCP handshake finishes, especially when IPv6 is unavailable. Apply a floor
// for Node-side source requests (including discovery and media). This is a
// process-wide net default, not a replacement for callers' AbortSignal/route
// deadlines. Preserve a longer timeout configured by the embedding application
// or --network-family-autoselection-attempt-timeout.
const SOURCE_ADDRESS_ATTEMPT_TIMEOUT_MS = 2000;
if ( getDefaultAutoSelectFamilyAttemptTimeout() < SOURCE_ADDRESS_ATTEMPT_TIMEOUT_MS ) {
	setDefaultAutoSelectFamilyAttemptTimeout( SOURCE_ADDRESS_ATTEMPT_TIMEOUT_MS );
}
