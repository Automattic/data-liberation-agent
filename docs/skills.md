# Skills

Skills are guided multi-step workflows available when using data-liberation-agent as an AI plugin. Each skill walks the AI through a complete process with phases, decision points, and quality checks.

Skill definitions live in `skills/<name>/SKILL.md`.

## /liberate

**Extract content from a closed web platform into a WordPress-compatible WXR file.**

Full extraction workflow:
1. Detect the platform
2. Discover all content (sitemap, navigation, platform features like stores/bookings/forms)
3. Extract pages, posts, media, and products
4. Verify the extraction (stale CDN URLs, failures, quality scores)
5. Validate WordPress connection and import

Handles resume for interrupted extractions. Flags platform-specific features that won't transfer automatically (with WordPress plugin recommendations).

## /qa

**Compare extracted WXR content against the original source site and fix discrepancies.**

QA workflow:
1. Parse the WXR and fetch each original source page
2. Compare text, headings, images, and links with weighted scoring
3. Grade each page (pass/warn/fail) and compute a health score (0-100)
4. Fix issues: patch minor gaps in the WXR, flag major gaps for re-extraction
5. Verify fixes improved quality, revert if not
6. Escalate to `/diagnose` if patterns of failure emerge

Tiers: quick (fix critical only), standard (fix critical + warnings), exhaustive (fix all).

## /diagnose

**Debug failed or low-quality extractions by analyzing logs and probing the source site.**

Diagnostic workflow:
1. Triage with `liberate_verify` for a structured overview, then dig into raw logs
2. Classify the problem (high failure rate, individual failures, low quality, crash, product issues)
3. Investigate root causes (rate limiting, bot detection, wrong adapter, content selectors, network issues)
4. Deep browser probe with `liberate_probe` via CDP (window globals, cookies, localStorage, network entries, platform identity) — useful for verifying auth state and finding alternate data sources
5. Fix at the right level (adapter code, configuration, data patches)
6. Verify the fix improved results
7. Document findings in DISCOVERIES.md

## /adapt

**Build a new platform adapter to extract content from an unsupported platform.**

Adapter development workflow:
1. Reconnaissance: platform detection signals, content discovery methods, extraction approach
2. API mapping with `liberate_map_apis` via CDP — automatically discovers all JSON API endpoints, categorizes them, captures sample responses and auth headers
3. Browser probing with `liberate_probe` — inspect window globals, localStorage, cookies, and platform identity for client-side data sources
4. Build the adapter implementing `PlatformAdapter` (detect, discover, extract)
5. Add product support if the platform has e-commerce
6. Register in the MCP server and CLI
7. Write tests with fixture data
8. Manual verification with `--dry-run --verbose`
9. Document in README.md and DISCOVERIES.md
