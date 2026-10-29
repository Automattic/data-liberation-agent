# Capture-owned asset records

Refs #1035 (slices 1–3). `src/lib/image-assets.ts` owns the shared resource
contract, not a destination attachment API. There is no separate font/document
inventory.

After browser capture, `image-assets.json` (version 1, historical filename and
`images` array key retained) owns identity. Each `AssetRecord` has:

- `kind`: `image`, `font`, `document` or `video`;
- `destination_owner`: `theme` for fonts, `media-library` for images (including
  posters), documents and video. This declares ownership, not an attachment ID;
- `source_urls`: absolute source references, including srcset candidates, known
  adapter-resolved optimizer URLs, underlying targets, CSS URLs, lightbox links,
  head icons, font sources, downloads, video sources and posters;
- `references`: captured uses with `kind` (`content`, `navigation`, `head`, `CSS`),
  `document_url`, `location` and absolute `source_url`. Font uses additionally
  retain `font_face` descriptors: family, weight, style, unicode range and format.
  Locations identify captured uses, not selectors into the transformed export;
- `resolved_original`: the selected underlying resource URL;
- `original`: null on failure, otherwise `source_url`, byte-sniffed `content_type`
  and SHA-256 of the stored bytes. Images additionally carry decoded
  `width`/`height` and `alpha` (at least one non-opaque decoded pixel);
- `local_path` on success, or `error` on failure.

The public API exports `AssetRecord` and `AssetReference`. The older
`ImageAssetRecord` and `ImageAssetReference` names remain type aliases. Older
records default to image kind, Media Library ownership and empty references.
Older captures without records retain their legacy export behavior.

## Identity and verification

Explicit srcset relationships join image variants; the largest declared
candidate wins. An enclosing image link (image-extension URL or
`data-lightbox`/`data-fancybox` link) takes precedence. Ordinary navigation links
do not establish identity. Matching CSS, poster and icon references join without
demoting an image's original.

`Platform.resolveImageOriginal(url)` optionally unwraps image optimizer/proxy
URLs. Generic capture bounds resolution to HTTP(S) targets and stops cycles; it
knows no optimizer URL shapes. The Next.js adapter resolves
`/_next/image?url=...`. Consumers can register their own resolver.

Non-image aliases join only after their downloaded hashes verify identical
bytes. Query strings are never discarded before verification: two PDF query
URLs serving the same bytes become one record, while query-selected different
resources remain distinct. Font family/weight/style names do not establish byte
identity. Each format and unicode-range subset remains a distinct source
resource. Every CSS URL resolves to that resource's own bytes, never another
format or subset. Declared WOFF/WOFF2/TrueType/OpenType formats must match the
verified signature. The declared font-face descriptors survive in references.

Original acquisition does not negotiate a different format or transcode.
Chromium decodes identified PNG, JPEG, GIF, WebP, AVIF and SVG bytes offline to
verify dimensions and transparency (10 seconds, 40 million pixels maximum).
Non-images use binary signatures rather than response headers or extensions:
WOFF/WOFF2/sfnt fonts, PDF, ZIP and recognizable OOXML members, RTF, gzip, 7z,
MP4, WebM and Theora. Unsupported/ambiguous downloads, including plain text
without a verifiable binary type, remain unresolved rather than being assigned
a guessed content type. This is bounded signature verification, not a full
archive/document/video decoder or malware scan.

Unknown bytes, placeholder responses, font format mismatches, decode failures
and unexportable originals produce error-severity asset loss findings:
`image_resource_unresolved` for images, `asset_resource_unresolved` otherwise.
Failed non-images are never replaced with transparent image bytes or a captured
unverified response. Dependency cleanup removes unresolved references; findings
remain in `website/source-findings.json` for downstream consumers.

The capture receipt's exported `assets` retain `sourceUrl` for existing consumers
and carry `source_url`, `source_urls`, `references`, `original`, `kind` and
`destination_owner`. All aliases resolve to the same exported file.

## Fixtures

The Next.js-shaped public `captureWebsite` fixture exercises transparent WebP
originals, opaque JPEG optimizer responses, srcsets, a full-size lightbox,
navigation, content, CSS backgrounds, head icons and an invalid response.

The non-image public fixture serves a licensed real font family in WOFF2 and
WOFF, each with Latin and Greek unicode-range subsets; a PDF linked twice with
different query strings; and real WebM bytes with a PNG poster. It checks each
emitted byte hash, owner, categorized reference and localized URL, plus an invalid
font's loss finding. Each fixture normally takes about 10–15 seconds and runs
against a local HTTP server in real Chromium, not a live external site.

## Remaining slices

- Replace per-URL media stubs with record-owned acquisition/resume state; avoid
  duplicate acquisition between captured responses and verified records.
- Extend HTTP-only acquisition without introducing a browser dependency, add
  further adapter-declared proxy resolvers, inline SVG identity and broader
  format coverage (including ICO decoding and additional downloads).
- Carry records through compilation/publish/import, assigning attachment IDs,
  meaningful filenames/titles/alt text and editable core blocks.
- Audit content/navigation/parts/head/CSS through the destination mapping and
  prove remaining builder/gallery/icon/background fixtures at import.
