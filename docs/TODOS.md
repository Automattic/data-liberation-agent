# TODOs

Deferred work items from the design review. Ordered by priority.

## P1

### WXR import smoke test using wp-playground
Add a CI test that generates a WXR from fixtures, imports it into a wp-playground instance via `@wp-playground/cli`, and verifies posts/pages/media were created correctly. Unit tests validate XML structure but can't catch format issues that cause `wp import` to fail (wrong namespace URIs, date formats, missing required elements). The test generates WXR via wxr-builder, runs `wp import` in a playground instance, then queries posts/media via WP-CLI to verify.
- **Effort:** M
- **Depends on:** wxr-builder.js implemented, `@wp-playground/cli` as dev dependency

## P2

### Squarespace `?format=json` fallback strategy
When building the Squarespace adapter (v2), implement HTML parsing as a fallback for when `?format=json` stops working. The JSON endpoint is undocumented/unsupported by Squarespace and could be removed without notice. The fallback parses server-rendered HTML (which Squarespace does serve, unlike Wix). Quality will degrade but extraction won't fail entirely.
- **Effort:** M
- **Depends on:** Squarespace adapter (v2)

## P3

### Streaming WXR serialization for very large sites
Add a streaming mode to WxrBuilder that writes XML incrementally during extraction instead of accumulating in memory. Sites with 1000+ pages could use significant memory with in-memory accumulation. Current design validates referential integrity in-memory before writing — streaming would need a two-pass approach (stream to disk, then validate by re-reading).
- **Effort:** M
- **Depends on:** WXR validation must be adapted for file-based validation

### Full auto-resume on Studio relaunch
When Studio detects an incomplete liberation (via lock file), automatically restart the MCP subprocess and resume extraction without user action. Current plan shows a notification and asks the user to confirm. Full auto-resume would be seamless — Studio picks up where it left off. Requires persisting MCP server state and the original extraction options (URL, platform, outputDir).
- **Effort:** M
- **Depends on:** Basic resume notification shipped first (Studio liberation v1)

### OAuth flows for Webflow and Shopify
Add interactive OAuth consent flow as an alternative to manually providing API tokens. Generating API tokens requires navigating platform admin UIs, which is friction for non-technical users. OAuth would let the plugin open a browser and handle auth automatically via a temporary local HTTP server for the callback. Only relevant when Webflow (v3) and Shopify (v4) adapters ship.
- **Effort:** L
- **Depends on:** Webflow and Shopify adapters existing
