# Capture-owned image assets

Refs #1035. This is the browser-capture image slice, not a destination attachment API.

After browser capture, `image-assets.json` (version 1) owns image identity. Each
`ImageAssetRecord` has:

- `source_urls`: absolute source references, including srcset candidates, known
  adapter-resolved optimizer URLs, underlying targets, CSS image references,
  enclosing lightbox/full-size image links and head icons;
- `references`: captured uses with `kind` (`content`, `navigation`, `head`, `CSS`),
  `document_url`, `location` and absolute `source_url`. The source URL resolves
  through the record to the exported file; locations identify captured uses, not
  selectors into the transformed export;
- `resolved_original`: the URL selected before acquisition;
- `original`: null on failure, otherwise `source_url`, byte-sniffed `content_type`,
  decoded `width`/`height`, `alpha` (at least one non-opaque decoded pixel), and
  SHA-256 of the stored bytes;
- `local_path` on success, or `error` on failure.

Explicit srcset relationships join variants; the largest declared candidate wins,
regardless of candidate order. An enclosing image link (image-extension URL or
`data-lightbox`/`data-fancybox` link) takes precedence over srcset candidates.
Ordinary navigation links do not establish identity. Matching CSS and icon
references join the same record, without demoting its original.

`Platform.resolveImageOriginal(url)` optionally unwraps optimizer/proxy URLs.
Generic capture bounds resolution to HTTP(S) targets and stops cycles; it knows
no optimizer URL shapes. The Next.js adapter resolves `/_next/image?url=...`.
Consumers can declare their own resolver through platform registration.
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
`references` and `original`; all aliases resolve to the same exported file. The existing
`source-findings.json` inside `website/` carries losses to downstream consumers.
Older captures without image records retain their legacy export behavior.

## Remaining slices

- Extend the record to HTTP-only acquisition without introducing a browser
  dependency, and add adapter-declared proxy resolvers beyond Next.js.
- Inline SVG identity and broader format coverage (including ICO decoding).
- Replace the per-URL media stub inventory with record-owned acquisition state.
- Font/proxy byte verification and loss findings for declared font formats.
- Carry records across compilation/publish/import, assigning destination ownership,
  attachment IDs, meaningful filenames/titles/alt text, and editable core blocks.
- Audit all content/navigation/parts/head/CSS references through that destination
  mapping and prove the remaining builder/gallery/icon/background fixtures.

The Next.js-shaped fixture exercises the public `captureWebsite` interface using
real Chromium, transparent WebP originals, opaque JPEG optimizer responses,
out-of-order srcset widths, a distinct linked full-size original, navigation and
content uses, a CSS background, favicon and apple-touch-icon, and an invalid
image response. It
normally takes about 10–15 seconds. No live external site was used for this slice.
