# Rendered glyph colour: `data-dla-glyph-color`

Capture records the rendered colour of single-colour icon glyphs on the glyph element in the captured document ([#769](https://github.com/Automattic/data-liberation-agent/issues/769), part of [#761](https://github.com/Automattic/data-liberation-agent/issues/761)). A compiler reads the colour from the HTML and does not decode image bytes, so the result is the same on every import host and for every image format the browser can paint (AVIF, WebP, PNG, SVG and others).

## Contract

```html
<a href="https://social.example/brand"><img src="icons/brand.avif" alt="Brand" data-dla-glyph-color="#1877f2"></a>
```

- **Value.** Lowercase `#rrggbb`. Near-white snaps to `#ffffff` and near-black to `#000000`.
- **Element.** The glyph itself: an `<img>` (for `<picture>`, the inner `<img>`), an outermost inline `<svg>`, or an element with no text and no media children whose own `background-image` paints the glyph. The attribute is never placed on the enclosing link or button.
- **Presence means evidence.** The attribute is present only when the rendered glyph is monochrome. Its absence means "no evidence": the glyph was multicolour, outside the bounds below, or sampling did not finish. A consumer then falls back to its own handling.
- **Provenance.** Capture removes any `data-dla-glyph-color` the source authored before sampling, so every value in a captured document was measured by capture.
- **Lifetime.** The attribute is written into the desktop and mobile documents before serialization and kept by export in `website/` HTML. It is inert: no CSS or script reads it.

## What is sampled

Glyph candidates, in document order:

- inside `a[href]`, `button` or `[role="button"]`;
- computed `visibility: visible`, with no ancestor at `opacity: 0`;
- a rendered box from 8 to 64 CSS px on each side.

At most 24 glyphs per document are sampled, within a 4 s wall-clock budget (`GLYPH_COLOR_LIMITS` in `src/lib/screenshot/glyph-color.ts`).

## How the colour is measured

After the page settles and the full-page reference screenshot is taken, capture isolates the candidates and takes one clip screenshot of each, with a transparent background:

- Every other element is `visibility: hidden`, and the page background is transparent. The glyph's descendants keep their own visibility.
- The glyph's own box decoration (background colour, border, shadow, outline) is cleared, and so is `background-image` on `<img>` and `<svg>`, so only the glyph content paints.
- The glyph and its ancestors paint at `opacity: 1`, because opacity is a fade rather than a colour. CSS filters, `fill` and `currentColor` stay, since they decide the colour the reader sees.

None of these properties changes layout, and all of them are removed before serialization.

The clip's pixels go through the same monochrome test as Blocks Engine's `MonochromeGlyphColor`:

1. Opaque pixels are those within GD's opaque band (alpha 0–16 of 127) relative to the clip's most opaque pixel, so anti-aliased edges do not count. Fewer than 8 opaque pixels gives no colour.
2. The mode colour must cover at least 85% of opaque pixels, counting pixels within 18 on every channel.
3. Near-white (all channels ≥ 250) and near-black (all channels ≤ 5) snap.

## Consumer guidance

A compiler should prefer `data-dla-glyph-color` and decode image bytes only when the attribute is absent. With the attribute present, a host that cannot decode the format (for example AVIF without libavif) still produces the authored colour, and no `glyph_color_undecodable` finding is needed for that glyph.
