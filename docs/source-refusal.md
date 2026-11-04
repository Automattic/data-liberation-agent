# Source refusal during capture

After earlier HTTP responses, three consecutive connection resets/refusals spanning at least two document route paths pause new requests to that origin. Asset URLs cannot manufacture distinct-route evidence. Any intervening HTTP response clears the streak.

Confirmation uses HEAD requests without redirects, at escalating offsets of approximately 2, 8, 20 and 60 seconds. Probe timeouts are reserved inside the governor's 60-second maximum retry window. Any HTTP response resumes capture immediately; timeouts and unrelated errors do not prove a client block. Already-in-flight responses also invalidate confirmation. Isolated resets retain navigation backoff and retry; healthy browser fan-out remains uncapped.

If every confirmation probe resets/refuses, new origin requests stop. Partial output and its receipt are finalized before the API rejects with code `source_blocked_client`. CLI/API operators see: **The source blocked this network; retry later or from another network.** This is transport evidence, not proof of the source's firewall configuration.

Receipt diagnostics include the origin, `requestsBeforeFirstRefusal` and ISO `firstRefusalAt`. Counts cover capture-owned governed HTTP acquisition and observed native browser outcomes, not earlier discovery. Parallel native requests are counted when their outcomes arrive; confirmation requests are included in governor totals. Section-media downloads, template derivation and engagement acquisition are skipped after confirmation.
