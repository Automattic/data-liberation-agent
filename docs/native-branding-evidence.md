# Portable branding evidence

Explicit site identity stays ordinary portable data: Organization/WebSite
JSON-LD logo and slogan declarations, icon links, and a web app manifest.

Resource capture follows declared logos (string or ImageObject URL/contentUrl,
including bounded graphs and typed arrays), the linked manifest, and its icon
resources even when no visible image uses them. Relative icon URIs resolve
against the manifest URL. The existing public-source fetch safeguards,
resource-count/byte budgets, and content-hash deduplication remain in force.

Export copies these resources into `website/`, rewrites retained logo/manifest
references and nested icon URIs to local asset paths, and preserves literal
slogans. Manifest JSON supports both application/json and
application/manifest+json. This is evidence for a destination's native branding
settings; it does not infer a logo from an arbitrary hero image or a tagline
from a meta description.

The regression in `src/lib/screenshot/resource-capture.test.ts` exercises the
capture-to-export contract with no visible images: every retained metadata URI
resolves to the expected bytes and equal logo/icon content shares a portable
asset. Native WordPress application belongs to SSI, not to this producer.
