# Portable homepage preview

Browser capture writes `website/site-preview.png` after exporting the portable
site. The preview renders the portable entrypoint at 1200 × 900 with local styles,
fonts, and images. It is generated even when optional full-page screenshots are
disabled. It travels with the website directory and its ZIP.

`capture-receipt.json` records `preview.status`, `path`, `width`, `height`, and
`origin: portable_render`. A preview failure records its reason and leaves the
website capture result intact. The preview is presentation metadata, not a
source-fidelity verdict.

Consumers can use this image as a site thumbnail. Static Site Importer maps it
to the generated WordPress theme's `screenshot.png`.
