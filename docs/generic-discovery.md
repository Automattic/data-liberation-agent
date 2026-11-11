# Generic adapter discovery

Default, Webflow, Hostinger, HubSpot and Weebly use `discoverGeneric` directly.
GoDaddy W+M supplies `/sitemap.website.xml` and `/sitemap.blog.xml` as supplemental
sitemaps. Both are read even when standard discovery succeeds. Sitemap origin
checks, limits and diagnostics apply to these paths too.

The returned contract contains `urls[].url`, `siteMeta.title` and `diagnostics`.
Capture reads these fields and produces the receipt and CLI/MCP results from its
own run model. Inspect does not consume adapter inventories: it performs its own
bounded discovery. None of those consumers reads inventory navigation, counts,
language, tagline, URL classifications, siteUrl or discoveredAt.

Classification rules formerly used only for those counts/types are removed,
not carried into generic discovery as unused policy. Raw homepage links already
cover Weebly menu anchors, so its navigation-specific parser is not needed by
discovery. `seeds(html)` is available for additional platform-specific links;
its results pass through the same page-link filter and normalization.

The legacy rich `DefaultInventory` type remains for Blogger and tenant-site
adapters. Blogger reconstructs its existing rich fields from the homepage it
already fetches; feed selection, enumeration and counting remain specialized.
Wix, Shopify and Squarespace discovery are unchanged.

## Verification evidence

Live discovery against the checkout baseline and this implementation:

| Corpus URL | Baseline routes | Generic routes | Missing baseline routes |
| --- | ---: | ---: | ---: |
| https://www.zmission.org | 111 | 112 | 0 |
| https://abcsteelbldg.com | 23 | 24 | 0 |

Slash-equivalent route spellings were treated as the same route in that check.
The fixture parity tests retain the old sitemap leaves and verify additional
chrome links. A single Webflow browser fixture verifies both Shift_JIS metadata
decoding and rendered SPA links (roughly one second locally).

A live one-route Weebly capture also completed. Its compare passed offline
self-consistency, but frozen fidelity failed on a desktop text position at 768px
and a mobile image geometry difference at 390px; desktop 1440px passed. This is
not evidence of full-site fidelity parity, and those export/layout differences
are not addressed by this discovery refactor.
