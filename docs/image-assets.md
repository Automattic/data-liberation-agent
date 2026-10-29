# Capture-owned image assets

Refs #1035. This is the browser-capture image slice, not a destination attachment API.

After browser capture, `image-assets.json` (version 1) owns image identity. Each
`ImageAssetRecord` has:

- `source_urls`: absolute source references, including srcset candidates, known
  optimizer URLs, underlying targets and CSS image references;
- `resolved_original`: the URL selected before acquisition;
- `original`: null on failure, otherwise `source_url`, byte-sniffed `content_type`,
  decoded `width`/`height`, `alpha` (at least one non-opaque decoded pixel), and
  SHA-256 of the stored bytes;
- `local_path` on success, or `error` on failure.

Explicit srcset relationships join variants; the largest declared candidate wins,
regardless of candidate order. Next.js `/_next/image?url=...` resolves to its
underlying target before fetching. Matching CSS references join the same record.
Unrelated URLs are not guessed to be the same photograph. Art-directed picture
sources remain independent unless they share an explicit URL relationship.

Original acquisition does not negotiate a different format or upgrade a URL.
Chromium decodes identified PNG, JPEG, GIF, WebP, AVIF and SVG bytes offline to
verify dimensions and transparency. Decode is bounded (10 seconds, 40 million
pixels). Export copies the verified file without transcoding, so alpha cannot be
lost to JPEG conversion. Unknown formats, known placeholder paths, non-images,
decode failures and unexportable originals produce `image_resource_unresolved`
asset loss findings. A failed original is not replaced with a captured optimizer
response. Placeholder display markup is not evidence of a successful resource.

The capture receipt's exported `assets` entries retain `sourceUrl` for existing
consumers and add `source_url`. Image entries also carry `source_urls` and
`original`; all aliases resolve to the same exported file. The existing
`source-findings.json` inside `website/` carries losses to downstream consumers.
Older captures without image records retain their legacy export behavior.

## Remaining slices

- Extend the record to HTTP-only acquisition without introducing a browser
  dependency, and add adapter-declared proxy resolvers beyond Next.js.
- Lightbox originals, head icons, inline SVG identity and broader format coverage.
- Font/proxy byte verification and loss findings for declared font formats.
- Carry records across compilation/publish/import, assigning destination ownership,
  attachment IDs, meaningful filenames/titles/alt text, and editable core blocks.
- Audit all content/navigation/parts/head/CSS references through that destination
  mapping and prove the remaining builder/gallery/icon/background fixtures.

The Next.js-shaped fixture exercises the public `captureWebsite` interface using
real Chromium, transparent WebP originals, opaque JPEG optimizer responses,
out-of-order srcset widths, a CSS background and an invalid image response. It
normally takes about 10–15 seconds. No live external site was used for this slice.
