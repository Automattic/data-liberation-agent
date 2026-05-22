# Section mapping — interaction models → WP block templates

This file has one block markup template per interaction model. The pattern generator (step 10 of `/liberate`) picks the template matching the spec file's `Interaction model` field, fills the `{{placeholders}}` from the spec's `Generation instructions` section, and writes the result to `theme/patterns/section-<n>.php`.

**Every template assumes the `theme/patterns/` directory exists and the theme's `style.css` is present.** Image paths use `<?php echo esc_url( get_theme_file_uri('assets/img-XX.ext') ); ?>` so the deployed theme serves them from `wp-content/themes/<slug>/assets/`. Do NOT curl CDN URLs — reuse media already uploaded to the WP library (uploaded WP URLs) or theme-shipped assets from the pipeline's `output/<site>/assets/` directory.

## The brightness rule (applies to every template)

Before picking a template, check `analysis.tokens.body.bg` brightness:

```
brightness = (0.299 * R + 0.587 * G + 0.114 * B)
```

- If brightness **≥ 200** (light/near-white base): **do not use `core/cover` as the top-level container.** The cover block forces inner text to white on an overlay, which produces invisible headings on light backgrounds. Use `core/group` with explicit `textColor="contrast"` instead. All templates below marked "⚠ cover-variant" have a paired "light-variant" — pick the right one.
- If brightness **< 200** (dark base): `core/cover` is fine and the cover's default white text reads correctly.

## The gradient rule

**Skip entirely when the spec marks the gradient source as `pageBackground` or `inherited`.** In that case the `<body>` (or a preceding section) already paints the gradient and re-emitting it per-pattern produces visible stripes. Leave the outer `core/group` with no `backgroundColor` and no `style.background`.

If the spec's **Background gradient** field is set AND `effectiveBg.source` is `wrapper` / `ancestor` / `sibling` (i.e. a locally-scoped gradient, not a page-level one), emit the outer `core/group` with `style.background.gradient` set to the captured string verbatim and **omit** `backgroundColor` / the `backgroundColor` slug. Gradients win over flat colors.

Compute brightness against the *dominant stop* (largest-area color) to pick the text color, not against `{{BG_COLOR}}`. For a simple two-stop gradient, pick the stop closer to where headlines sit in the layout — first stop for top-heavy sections, last stop for bottom-heavy.

Example `core/group` opening tag with a gradient:

```html
<!-- wp:group {"align":"full","style":{"background":{"gradient":"{{BG_GRADIENT}}"},"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|80"}}},"textColor":"contrast","layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull has-contrast-color has-text-color" style="background:{{BG_GRADIENT}}">
  <!-- ...inner blocks... -->
</div>
<!-- /wp:group -->
```

When `{{BG_GRADIENT}}` is `n/a`, fall back to `backgroundColor:{{BG_COLOR_SLUG}}` as every template currently does.

## The divider rule

If the spec's **Divider above** field is set, emit this block **before** the pattern's `core/group` opens. If **Divider below** is set, emit it **after** the group closes. Do NOT emit a divider for a section without a captured divider — false-positive rules between sections look worse than missing ones.

```html
<!-- wp:separator {"align":"full","style":{"color":{"background":"{{DIVIDER_COLOR}}"},"spacing":{"margin":{"top":"0","bottom":"0"}}},"className":"is-style-wide"} -->
<hr class="wp-block-separator alignfull has-text-color has-background is-style-wide" style="background-color:{{DIVIDER_COLOR}};color:{{DIVIDER_COLOR}};margin-top:0;margin-bottom:0" />
<!-- /wp:separator -->
```

`{{DIVIDER_COLOR}}` is the `color` field from `sections[i].dividerAbove` / `dividerBelow` (e.g. `rgba(255,255,255,0.15)`). Keep the margin zero so the rule sits flush against the section it brackets.

## The styling rule — block attributes win over theme CSS

**When a pattern needs a layout, padding, background color, gap, or button color that differs from the theme default, emit it as a block attribute — not as a `className` + CSS rule in `theme/style.css`.**

WP's block-library CSS (`.wp-block-group.is-layout-flex`, `.wp-element-button`, `.wp-block-buttons`, …) is loaded on the front end after the theme's stylesheet and carries at least equal specificity to `.your-custom-class`. A rule like `.service-row { display: flex; padding: 1.5rem 2rem; }` in `style.css` will silently lose to `.wp-block-group.is-layout-flow { ... }` and the pattern renders wrong.

Prefer (inline attributes):

```html
<!-- wp:group {"className":"service-row","backgroundColor":"primary","style":{"spacing":{"padding":{"top":"1.5rem","right":"2rem","bottom":"1.5rem","left":"2rem"}}},"layout":{"type":"flex","flexWrap":"wrap","justifyContent":"space-between","verticalAlignment":"center"}} -->
<div class="wp-block-group service-row has-primary-background-color has-background" style="padding:1.5rem 2rem">…</div>
<!-- /wp:group -->
```

Avoid (CSS class + external rule):

```html
<!-- wp:group {"className":"service-row"} -->
<div class="wp-block-group service-row">…</div>
<!-- /wp:group -->
```
```css
/* style.css — silently loses to WP's .wp-block-group.is-layout-flex */
.service-row { display: flex; padding: 1.5rem 2rem; background: #0038ff; }
```

**Pattern cites design.md, not raw captures.** Every template fills `{{...}}` placeholders from two sources: the per-section spec file (content, local image paths, gradient/divider flags) **and** `design.md` (palette slugs, radius scale, shadow stack, typography sizes, button styling). If a spec says `Background gradient: n/a` but `design.md`'s Color Palette & Roles table shows the section sits on a page-wide body gradient, respect the design brief — don't re-paint the gradient per pattern. When the two sources disagree, pause and reconcile before emitting; visual QA will catch it otherwise.

**What `theme/style.css` is still good for:**
- `@font-face` and `@import` font rules
- Element-level tweaks on the unlayered host (`body`, `a:hover` color, smooth scroll)
- Utility classes that are purely visual (not structural) and that tolerate being overridden — e.g. opacity bylines.
- Theme-scoped motion classes (`.clone-reveal`, `.clone-marquee`, hover overlays), always with `prefers-reduced-motion` fallbacks.

**What it is NOT good for:**
- Flex/grid layouts on blocks — use `"layout":{"type":"flex"/"grid"}` in block attributes.
- Padding, margin, gap — use `"style":{"spacing":...}`.
- Background color/gradient — use `"backgroundColor":"<slug>"` or `"style":{"background":...}`.
- Button colors — use `"backgroundColor"` / `"textColor"` on the `core/button`, not CSS descendant selectors.
- Block-specific typography — use `"fontSize":"<slug>"` and `"style":{"typography":...}` on the heading/paragraph block.

If a future Site Editor user changes a block's styling, inline attributes persist through serialization; CSS-class rules get orphaned.

## Header and footer

**Do not re-derive nav or footer blocks from scratch.** Our pipeline ships a dynamic block-header (nav links → local pages, logo, CTA button, overlay-vs-solid treatment derived from the source). Reuse it by referencing our existing `parts/header.html` template part.

- **`nav`** — part of `parts/header.html`. Our existing header emits one `core/navigation-link` per local page from the extracted sitemap. Do not hardcode nav items inside patterns.
- **`footer`** — always a template part (`parts/footer.html`), not a pattern. The footer spec drives the template-part contents (site title, copyright, contact info, social links).

## Template catalog

Each template below takes placeholder variables and emits valid WP block markup. After filling placeholders, wrap the result in the pattern file header:

```php
<?php
/**
 * Title: <human-readable title>
 * Slug: <theme-slug>/section-<n>
 * Categories: featured
 */
?>
<!-- block markup here -->
```

---

### `cover-with-headline` ⚠ cover-variant

A hero with a background image, centered headline, optional subheading, optional CTA button.

**Placeholders:** `{{BG_IMAGE}}` (theme-relative asset path or omit for flat color), `{{BG_COLOR}}`, `{{HEADING}}`, `{{SUBHEADING}}`, `{{BUTTON_LABEL}}`, `{{BUTTON_HREF}}`, `{{MIN_HEIGHT_VH}}`.

**Dark-base variant (brightness < 200):**

```html
<!-- wp:cover {"url":"<?php echo esc_url( get_theme_file_uri('{{BG_IMAGE}}') ); ?>","dimRatio":30,"minHeight":{{MIN_HEIGHT_VH}},"minHeightUnit":"vh","align":"full","overlayColor":"contrast"} -->
<div class="wp-block-cover alignfull" style="min-height:{{MIN_HEIGHT_VH}}vh">
  <span aria-hidden="true" class="wp-block-cover__background has-contrast-background-color has-background-dim"></span>
  <img class="wp-block-cover__image-background" src="<?php echo esc_url( get_theme_file_uri('{{BG_IMAGE}}') ); ?>" alt="" />
  <div class="wp-block-cover__inner-container">
    <!-- wp:heading {"level":1,"textAlign":"center","fontSize":"xx-large"} -->
    <h1 class="wp-block-heading has-text-align-center has-xx-large-font-size">{{HEADING}}</h1>
    <!-- /wp:heading -->
    <!-- wp:paragraph {"align":"center","fontSize":"large"} -->
    <p class="has-text-align-center has-large-font-size">{{SUBHEADING}}</p>
    <!-- /wp:paragraph -->
    <!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
    <div class="wp-block-buttons">
      <!-- wp:button -->
      <div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="{{BUTTON_HREF}}">{{BUTTON_LABEL}}</a></div>
      <!-- /wp:button -->
    </div>
    <!-- /wp:buttons -->
  </div>
</div>
<!-- /wp:cover -->
```

**Light-base variant (brightness ≥ 200):** do not use `core/cover`. Use `core/group` with an inline background image via `style.background`:

```html
<!-- wp:group {"align":"full","style":{"background":{"backgroundImage":{"url":"<?php echo esc_url( get_theme_file_uri('{{BG_IMAGE}}') ); ?>","source":"file"},"backgroundSize":"cover","backgroundPosition":"center"},"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|80"}},"minHeight":"{{MIN_HEIGHT_VH}}vh"},"textColor":"contrast","layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull has-contrast-color has-text-color" style="min-height:{{MIN_HEIGHT_VH}}vh">
  <!-- wp:heading {"level":1,"textAlign":"center","fontSize":"xx-large","textColor":"contrast"} -->
  <h1 class="wp-block-heading has-text-align-center has-contrast-color has-text-color has-xx-large-font-size">{{HEADING}}</h1>
  <!-- /wp:heading -->
  <!-- wp:paragraph {"align":"center","fontSize":"large","textColor":"contrast"} -->
  <p class="has-text-align-center has-contrast-color has-text-color has-large-font-size">{{SUBHEADING}}</p>
  <!-- /wp:paragraph -->
  <!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
  <div class="wp-block-buttons">
    <!-- wp:button -->
    <div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="{{BUTTON_HREF}}">{{BUTTON_LABEL}}</a></div>
    <!-- /wp:button -->
  </div>
  <!-- /wp:buttons -->
</div>
<!-- /wp:group -->
```

If `{{BG_IMAGE}}` is empty (flat color hero), omit the `backgroundImage` style entirely and set `backgroundColor` to `{{BG_COLOR}}`.

---

### `media-text`

An image beside a headline + paragraph + optional button. Used for "feature" sections that pair one image with copy.

**Placeholders:** `{{IMAGE_PATH}}`, `{{IMAGE_ALT}}`, `{{MEDIA_POSITION}}` (`left` or `right`), `{{HEADING}}`, `{{BODY}}`, `{{BUTTON_LABEL}}`, `{{BUTTON_HREF}}`.

```html
<!-- wp:media-text {"align":"wide","mediaPosition":"{{MEDIA_POSITION}}","mediaLink":"<?php echo esc_url( get_theme_file_uri('{{IMAGE_PATH}}') ); ?>","mediaType":"image"} -->
<div class="wp-block-media-text alignwide is-stacked-on-mobile {{IF_RIGHT}}has-media-on-the-right{{/IF_RIGHT}}">
  <figure class="wp-block-media-text__media"><img src="<?php echo esc_url( get_theme_file_uri('{{IMAGE_PATH}}') ); ?>" alt="{{IMAGE_ALT}}" /></figure>
  <div class="wp-block-media-text__content">
    <!-- wp:heading {"level":2} --><h2 class="wp-block-heading">{{HEADING}}</h2><!-- /wp:heading -->
    <!-- wp:paragraph --><p>{{BODY}}</p><!-- /wp:paragraph -->
    <!-- wp:buttons -->
    <div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="{{BUTTON_HREF}}">{{BUTTON_LABEL}}</a></div><!-- /wp:button --></div>
    <!-- /wp:buttons -->
  </div>
</div>
<!-- /wp:media-text -->
```

Remove the `<!-- wp:buttons -->` block if the spec file says `{{BUTTON_LABEL}} = n/a`. Replace `{{IF_RIGHT}}...{{/IF_RIGHT}}` with the class only when `mediaPosition=right`.

---

### `columns`

A row of N cards, each with a heading and a paragraph (and optionally an icon/image). Used for feature grids.

**Placeholders:** `{{COLUMN_COUNT}}`, `{{HEADING}}` (section headline above the row), `{{COLUMNS}}` (array of `{ heading, body, image_path?, image_alt? }`), `{{BG_COLOR}}`.

Emit one `<!-- wp:column -->` block per entry in `{{COLUMNS}}`. Pattern:

```html
<!-- wp:group {"align":"wide","backgroundColor":"{{BG_COLOR_SLUG}}","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|70"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignwide has-{{BG_COLOR_SLUG}}-background-color has-background">
  <!-- wp:heading {"textAlign":"center","level":2} --><h2 class="wp-block-heading has-text-align-center">{{HEADING}}</h2><!-- /wp:heading -->
  <!-- wp:columns -->
  <div class="wp-block-columns">
    <!-- FOREACH column in {{COLUMNS}}: -->
    <!-- wp:column -->
    <div class="wp-block-column">
      <!-- IF column.image_path: -->
      <!-- wp:image {"sizeSlug":"full"} -->
      <figure class="wp-block-image size-full"><img src="<?php echo esc_url( get_theme_file_uri('{{column.image_path}}') ); ?>" alt="{{column.image_alt}}" /></figure>
      <!-- /wp:image -->
      <!-- END IF -->
      <!-- wp:heading {"level":3} --><h3 class="wp-block-heading">{{column.heading}}</h3><!-- /wp:heading -->
      <!-- wp:paragraph --><p>{{column.body}}</p><!-- /wp:paragraph -->
    </div>
    <!-- /wp:column -->
    <!-- END FOREACH -->
  </div>
  <!-- /wp:columns -->
</div>
<!-- /wp:group -->
```

---

### `gallery`

A multi-image grid. Use for any section whose spec lists 4+ images and minimal text.

**Placeholders:** `{{IMAGES}}` (array of `{ path, alt }`), `{{COLUMNS}}` (computed via gallery heuristic below), `{{HEADING}}` (optional section headline).

**Column count heuristic:**

```
columns = clamp(round(sqrt(imageCount)), 2, 6)
```

If images are clearly portrait-oriented (avg h > avg w), reduce by 1.

```html
<!-- wp:group {"align":"wide","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|70"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignwide">
  <!-- IF {{HEADING}} -->
  <!-- wp:heading {"textAlign":"center","level":2} --><h2 class="wp-block-heading has-text-align-center">{{HEADING}}</h2><!-- /wp:heading -->
  <!-- END IF -->
  <!-- wp:gallery {"columns":{{COLUMNS}},"linkTo":"none","align":"wide"} -->
  <figure class="wp-block-gallery has-nested-images columns-{{COLUMNS}} is-cropped alignwide">
    <!-- FOREACH img in {{IMAGES}}: -->
    <!-- wp:image {"sizeSlug":"large","linkDestination":"none"} -->
    <figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri('{{img.path}}') ); ?>" alt="{{img.alt}}" /></figure>
    <!-- /wp:image -->
    <!-- END FOREACH -->
  </figure>
  <!-- /wp:gallery -->
</div>
<!-- /wp:group -->
```

---

### `animated-cover`

Same content model as `cover-with-headline`, but the spec's Motion profile requires a simple preserved entry reveal. Use this only for CSS-only opacity/transform reveals; complex pinned timelines remain `cover-with-headline` plus a notes entry.

**Placeholders:** same as `cover-with-headline`, plus `{{REVEAL_DURATION_MS}}`, `{{REVEAL_DELAY_MS}}`, and `{{REVEAL_TRANSFORM}}`.

Implementation: emit the normal cover/group variant, add class `clone-reveal` to the inner container, and add theme-scoped CSS:

```css
.clone-reveal { animation: clone-reveal {{REVEAL_DURATION_MS}}ms ease both; animation-delay: {{REVEAL_DELAY_MS}}ms; }
@keyframes clone-reveal { from { opacity: 0; transform: {{REVEAL_TRANSFORM}}; } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .clone-reveal { animation: none; opacity: 1; transform: none; } }
```

---

### `horizontal-showcase`

A wide, horizontally-scanned showcase used by portfolio strips, laptop mockup rows, and dark agency case-study ribbons. Prefer this over `gallery` when the source emphasizes lateral movement or oversized cards.

**Placeholders:** `{{HEADING}}`, `{{ITEMS}}` (array of `{ image_path, image_alt, title, body, href }`), `{{BG_COLOR_SLUG}}`, `{{TEXT_COLOR_SLUG}}`.

```html
<!-- wp:group {"align":"full","backgroundColor":"{{BG_COLOR_SLUG}}","textColor":"{{TEXT_COLOR_SLUG}}","className":"clone-horizontal-showcase","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|80"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull clone-horizontal-showcase has-{{BG_COLOR_SLUG}}-background-color has-{{TEXT_COLOR_SLUG}}-color has-background has-text-color">
  <!-- IF {{HEADING}} -->
  <!-- wp:heading {"level":2} --><h2 class="wp-block-heading">{{HEADING}}</h2><!-- /wp:heading -->
  <!-- END IF -->
  <!-- wp:group {"align":"wide","className":"clone-horizontal-showcase__track","layout":{"type":"flex","flexWrap":"nowrap"}} -->
  <div class="wp-block-group alignwide clone-horizontal-showcase__track">
    <!-- FOREACH item in {{ITEMS}}: -->
    <!-- wp:group {"className":"clone-horizontal-showcase__item","layout":{"type":"constrained"}} -->
    <div class="wp-block-group clone-horizontal-showcase__item">
      <!-- wp:image {"sizeSlug":"large"} -->
      <figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri('{{item.image_path}}') ); ?>" alt="{{item.image_alt}}" /></figure>
      <!-- /wp:image -->
      <!-- wp:heading {"level":3,"fontSize":"medium"} --><h3 class="wp-block-heading has-medium-font-size">{{item.title}}</h3><!-- /wp:heading -->
      <!-- wp:paragraph {"fontSize":"small"} --><p class="has-small-font-size">{{item.body}}</p><!-- /wp:paragraph -->
    </div>
    <!-- /wp:group -->
    <!-- END FOREACH -->
  </div>
  <!-- /wp:group -->
</div>
<!-- /wp:group -->
```

Add CSS for overflow-x scrolling on small screens. Do not hide off-screen cards on mobile.

---

### `project-card-grid`

A portfolio/case-study grid where each card has an image, title, service/meta text, and optional CTA. Use this instead of generic `columns` for project listings, especially when the source uses hover overlays or full-card links.

**Placeholders:** `{{HEADING}}`, `{{PROJECTS}}` (array of `{ image_path, image_alt, title, meta, href, cta }`), `{{COLUMNS}}`, `{{MOTION_CLASS}}` (`none` or `clone-hover-overlay`).

```html
<!-- wp:group {"align":"wide","className":"clone-project-grid {{MOTION_CLASS}}","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|70"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignwide clone-project-grid {{MOTION_CLASS}}">
  <!-- IF {{HEADING}} -->
  <!-- wp:heading {"level":2} --><h2 class="wp-block-heading">{{HEADING}}</h2><!-- /wp:heading -->
  <!-- END IF -->
  <!-- wp:columns {"className":"clone-project-grid__columns"} -->
  <div class="wp-block-columns clone-project-grid__columns">
    <!-- FOREACH project in {{PROJECTS}}: -->
    <!-- wp:column {"className":"clone-project-card"} -->
    <div class="wp-block-column clone-project-card">
      <!-- wp:image {"sizeSlug":"large","linkDestination":"custom"} -->
      <figure class="wp-block-image size-large"><a href="{{project.href}}"><img src="<?php echo esc_url( get_theme_file_uri('{{project.image_path}}') ); ?>" alt="{{project.image_alt}}" /></a></figure>
      <!-- /wp:image -->
      <!-- wp:heading {"level":3,"fontSize":"medium"} --><h3 class="wp-block-heading has-medium-font-size"><a href="{{project.href}}">{{project.title}}</a></h3><!-- /wp:heading -->
      <!-- wp:paragraph {"fontSize":"small"} --><p class="has-small-font-size">{{project.meta}}</p><!-- /wp:paragraph -->
      <!-- IF {{project.cta}} -->
      <!-- wp:paragraph {"fontSize":"small"} --><p class="has-small-font-size"><a href="{{project.href}}">{{project.cta}}</a></p><!-- /wp:paragraph -->
      <!-- END IF -->
    </div>
    <!-- /wp:column -->
    <!-- END FOREACH -->
  </div>
  <!-- /wp:columns -->
</div>
<!-- /wp:group -->
```

For hover-overlay sources, add CSS in `style.css` scoped to `.clone-project-grid.clone-hover-overlay`; mobile must show the title/meta without hover.

For Wix/Studio portfolio grids where desktop and mobile expose different states, preserve both states instead of choosing one. A common pattern is:

- Desktop: text-only black cells with visible borders or dividers; images are hidden until hover or scroll interaction.
- Mobile: horizontal project strip where the same projects expose their images as static cards.

Model this as `project-card-grid` with a note in the spec's Responsive notes and Motion profile. The generated CSS should hide or dim images on desktop, show them on hover when appropriate, and make images visible by default inside an overflow-x mobile strip. Do not replace the desktop source with always-visible image cards if the desktop screenshot is text-first.

---

### `marquee-strip`

A horizontal moving text/logo strip. Use only when the spec's Motion profile is `marquee`; otherwise render as a normal `logo-strip` or paragraph row.

**Placeholders:** `{{ITEMS}}`, `{{DURATION_SECONDS}}`, `{{DIRECTION}}`.

```html
<!-- wp:group {"align":"full","className":"clone-marquee","layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull clone-marquee" style="--clone-marquee-duration:{{DURATION_SECONDS}}s">
  <!-- wp:group {"className":"clone-marquee__track","layout":{"type":"flex","flexWrap":"nowrap"}} -->
  <div class="wp-block-group clone-marquee__track">
    <!-- FOREACH item in {{ITEMS}}: -->
    <!-- wp:paragraph --><p>{{item}}</p><!-- /wp:paragraph -->
    <!-- END FOREACH -->
    <!-- Repeat items once so the CSS loop has no visual gap. -->
    <!-- FOREACH item in {{ITEMS}}: -->
    <!-- wp:paragraph {"ariaHidden":true} --><p aria-hidden="true">{{item}}</p><!-- /wp:paragraph -->
    <!-- END FOREACH -->
  </div>
  <!-- /wp:group -->
</div>
<!-- /wp:group -->
```

Required CSS:

```css
.clone-marquee { overflow: hidden; }
.clone-marquee__track { animation: clone-marquee var(--clone-marquee-duration, 24s) linear infinite; min-width: max-content; }
.clone-marquee:hover .clone-marquee__track { animation-play-state: paused; }
@keyframes clone-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
@media (prefers-reduced-motion: reduce) { .clone-marquee__track { animation: none; transform: none; } }
```

---

### `logo-strip`

A horizontal row of small uniform logos. Used for "as seen in" press callouts and partner lists.

**Placeholders:** `{{LABEL}}` (e.g. "AS SEEN IN"), `{{LOGOS}}` (array of `{ path, alt }`).

Logo strips are different from galleries — logos are small, uniform, and should have equal column widths. Use `core/columns` with fixed small widths, not `core/gallery`:

```html
<!-- wp:group {"align":"wide","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignwide">
  <!-- wp:heading {"textAlign":"center","level":3,"fontSize":"medium"} --><h3 class="wp-block-heading has-text-align-center has-medium-font-size" style="letter-spacing:0.15em;text-transform:uppercase">{{LABEL}}</h3><!-- /wp:heading -->
  <!-- wp:columns {"verticalAlignment":"center"} -->
  <div class="wp-block-columns are-vertically-aligned-center">
    <!-- FOREACH logo in {{LOGOS}}: -->
    <!-- wp:column {"verticalAlignment":"center"} -->
    <div class="wp-block-column is-vertically-aligned-center">
      <!-- wp:image {"sizeSlug":"medium","align":"center"} -->
      <figure class="wp-block-image aligncenter size-medium"><img src="<?php echo esc_url( get_theme_file_uri('{{logo.path}}') ); ?>" alt="{{logo.alt}}" /></figure>
      <!-- /wp:image -->
    </div>
    <!-- /wp:column -->
    <!-- END FOREACH -->
  </div>
  <!-- /wp:columns -->
</div>
<!-- /wp:group -->
```

---

### `testimonial`

A pull quote with attribution.

**Placeholders:** `{{QUOTE}}`, `{{ATTRIBUTION}}`, `{{BG_COLOR_SLUG}}`.

```html
<!-- wp:group {"align":"full","backgroundColor":"{{BG_COLOR_SLUG}}","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|80"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull has-{{BG_COLOR_SLUG}}-background-color has-background">
  <!-- wp:quote {"align":"center","fontSize":"x-large"} -->
  <blockquote class="wp-block-quote has-text-align-center has-x-large-font-size">
    <p>{{QUOTE}}</p>
    <cite>{{ATTRIBUTION}}</cite>
  </blockquote>
  <!-- /wp:quote -->
</div>
<!-- /wp:group -->
```

---

### `cta`

A single centered call-to-action block — headline + button, no images.

**Placeholders:** `{{HEADING}}`, `{{BODY}}`, `{{BUTTON_LABEL}}`, `{{BUTTON_HREF}}`, `{{BG_COLOR_SLUG}}`.

```html
<!-- wp:group {"align":"full","backgroundColor":"{{BG_COLOR_SLUG}}","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|80"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull has-{{BG_COLOR_SLUG}}-background-color has-background">
  <!-- wp:heading {"textAlign":"center","level":2,"fontSize":"xx-large"} --><h2 class="wp-block-heading has-text-align-center has-xx-large-font-size">{{HEADING}}</h2><!-- /wp:heading -->
  <!-- wp:paragraph {"align":"center"} --><p class="has-text-align-center">{{BODY}}</p><!-- /wp:paragraph -->
  <!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
  <div class="wp-block-buttons">
    <!-- wp:button -->
    <div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="{{BUTTON_HREF}}">{{BUTTON_LABEL}}</a></div>
    <!-- /wp:button -->
  </div>
  <!-- /wp:buttons -->
</div>
<!-- /wp:group -->
```

---

### `blog-card-grid`

A row of N post cards, each with a featured image, a byline/date, and a linked title. Use this instead of generic `columns` whenever the spec's interaction model is a blog/insights/news listing — the byline order and the linked-title wrapping differ from a plain columns template.

**Classification heuristic (step 3):** 3 or more adjacent columns, each containing one `<img>`, one small-font paragraph (< 14 px, often containing "By" or a date), and one larger-font heading/link.

**Placeholders:** `{{HEADING}}` (section headline), `{{CARDS}}` (array of `{ image_path, image_alt, byline, title, href }`).

**Byline ordering:** always *below* the image and *above* the title. Even if the source captured the byline at an unusual position, normalize to this order — it's what every WP theme does for post cards and it reads correctly.

```html
<!-- wp:group {"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|80","left":"var:preset|spacing|70","right":"var:preset|spacing|70"},"blockGap":"var:preset|spacing|70"}},"textColor":"contrast","layout":{"type":"constrained","wideSize":"1280px"}} -->
<div class="wp-block-group alignfull has-contrast-color has-text-color" style="padding-top:var(--wp--preset--spacing--80);padding-right:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--80);padding-left:var(--wp--preset--spacing--70)">
<!-- wp:heading {"level":2,"fontSize":"xx-large"} -->
<h2 class="wp-block-heading has-xx-large-font-size">{{HEADING}}</h2>
<!-- /wp:heading -->
<!-- wp:columns {"align":"wide"} -->
<div class="wp-block-columns alignwide">
<!-- FOREACH card in {{CARDS}}: -->
<!-- wp:column {"className":"insight-card"} -->
<div class="wp-block-column insight-card">
<!-- wp:image {"sizeSlug":"large","linkDestination":"none","style":{"border":{"radius":"4px"}}} -->
<figure class="wp-block-image size-large has-custom-border"><img src="<?php echo esc_url( get_theme_file_uri('{{card.image_path}}') ); ?>" alt="{{card.image_alt}}" style="border-radius:4px" /></figure>
<!-- /wp:image -->
<!-- wp:paragraph {"fontSize":"small","style":{"typography":{"fontStyle":"normal","fontWeight":"400"}},"className":"byline"} -->
<p class="byline has-small-font-size" style="opacity:0.75">{{card.byline}}</p>
<!-- /wp:paragraph -->
<!-- wp:heading {"level":3,"fontSize":"large"} -->
<h3 class="wp-block-heading has-large-font-size"><a href="{{card.href}}">{{card.title}}</a></h3>
<!-- /wp:heading -->
</div>
<!-- /wp:column -->
<!-- END FOREACH -->
</div>
<!-- /wp:columns -->
</div>
<!-- /wp:group -->
```

The `opacity:0.75` on the byline reads as a muted color on any gradient or flat background; avoid shipping a hardcoded `rgba` that will clash with a Site Editor palette swap.

---

### `price-list`

A stack of N horizontal rows, each with a title (left), optional price or meta (center), and a CTA button (right). The row has a solid, typically-branded background color, and the whole stack has spacing between rows. Use this instead of `columns` for services / packages / pricing tiers where each row is a single offer.

**Classification heuristic (step 3):** 2+ horizontally-laid-out groups at the same depth, each containing exactly one heading/title + one CTA button. Extra markers: a currency symbol (`$`, `€`, `£`, `¥`) or a short money-shaped string in each group.

**Placeholders:** `{{HEADING}}` (section headline), `{{ROWS}}` (array of `{ title, price, cta_label, cta_href }`), `{{ROW_BG_SLUG}}` (row background color — usually `primary`), `{{ROW_PAD}}` (padding shorthand, default `1.5rem 2rem`), `{{CTA_BG_SLUG}}` (button bg, usually `base`/`contrast`), `{{CTA_FG_SLUG}}` (button text, usually the complement).

**Rendering guarantees:** emit the row-level `core/group` with `"layout":{"type":"flex","flexWrap":"wrap","justifyContent":"space-between","verticalAlignment":"center"}` — this is the specificity-safe way to get a horizontal row on top of WP's block-library CSS. Use inline `style.spacing.padding` for the row's internal padding. Button colors go on the `core/button` as `backgroundColor`/`textColor` attributes, never as descendant CSS.

```html
<!-- wp:group {"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|80","left":"var:preset|spacing|70","right":"var:preset|spacing|70"},"blockGap":"var:preset|spacing|50"}},"textColor":"contrast","layout":{"type":"constrained","wideSize":"1280px"}} -->
<div class="wp-block-group alignfull has-contrast-color has-text-color" style="padding-top:var(--wp--preset--spacing--80);padding-right:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--80);padding-left:var(--wp--preset--spacing--70)">
<!-- wp:heading {"level":2,"fontSize":"xx-large"} -->
<h2 class="wp-block-heading has-xx-large-font-size">{{HEADING}}</h2>
<!-- /wp:heading -->
<!-- FOREACH row in {{ROWS}}: -->
<!-- wp:group {"align":"wide","className":"price-row","backgroundColor":"{{ROW_BG_SLUG}}","style":{"spacing":{"padding":{"top":"1.5rem","right":"2rem","bottom":"1.5rem","left":"2rem"}}},"layout":{"type":"flex","flexWrap":"wrap","justifyContent":"space-between","verticalAlignment":"center"}} -->
<div class="wp-block-group alignwide price-row has-{{ROW_BG_SLUG}}-background-color has-background" style="padding:{{ROW_PAD}}">
<!-- wp:paragraph {"fontSize":"x-large","style":{"typography":{"fontWeight":"500"}}} -->
<p class="has-x-large-font-size" style="font-weight:500">{{row.title}}</p>
<!-- /wp:paragraph -->
<!-- IF {{row.price}}: -->
<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size" style="opacity:0.9">{{row.price}}</p>
<!-- /wp:paragraph -->
<!-- END IF -->
<!-- wp:buttons -->
<div class="wp-block-buttons">
<!-- wp:button {"backgroundColor":"{{CTA_BG_SLUG}}","textColor":"{{CTA_FG_SLUG}}","style":{"border":{"radius":"999px"}}} -->
<div class="wp-block-button"><a class="wp-block-button__link has-{{CTA_FG_SLUG}}-color has-{{CTA_BG_SLUG}}-background-color has-text-color has-background wp-element-button" href="{{row.cta_href}}" style="border-radius:999px">{{row.cta_label}}</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->
</div>
<!-- /wp:group -->
<!-- END FOREACH -->
</div>
<!-- /wp:group -->
```

If the spec lists more than ~5 rows, consider paginating into a `core/columns` (2 per row) instead — a long vertical stack of full-width price rows reads as a list, not a grid.

---

### `color-block-grid`

A grid where each cell has its own distinct background color (common on bright e-commerce sites). Different from `columns` because each column's background is part of the composition.

**Placeholders:** `{{TILES}}` (array of `{ bg_hex, image_path, image_alt, label? }`).

Emit one `core/cover` per tile inside a `core/columns`:

```html
<!-- wp:columns {"align":"full"} -->
<div class="wp-block-columns alignfull" style="gap:0">
  <!-- FOREACH tile in {{TILES}}: -->
  <!-- wp:column -->
  <div class="wp-block-column">
    <!-- wp:cover {"url":"<?php echo esc_url( get_theme_file_uri('{{tile.image_path}}') ); ?>","customOverlayColor":"{{tile.bg_hex}}","dimRatio":0,"minHeight":400,"minHeightUnit":"px"} -->
    <div class="wp-block-cover" style="min-height:400px">
      <span aria-hidden="true" class="wp-block-cover__background has-background-dim-0 has-background-dim" style="background-color:{{tile.bg_hex}}"></span>
      <img class="wp-block-cover__image-background" src="<?php echo esc_url( get_theme_file_uri('{{tile.image_path}}') ); ?>" alt="{{tile.image_alt}}" />
      <div class="wp-block-cover__inner-container">
        <!-- IF {{tile.label}} -->
        <!-- wp:heading {"level":3,"textAlign":"center"} --><h3 class="wp-block-heading has-text-align-center">{{tile.label}}</h3><!-- /wp:heading -->
        <!-- END IF -->
      </div>
    </div>
    <!-- /wp:cover -->
  </div>
  <!-- /wp:column -->
  <!-- END FOREACH -->
</div>
<!-- /wp:columns -->
```

---

## Framework-specific widgets → stub with explicit comment

For each of these, emit an **explicit HTML comment** in the generated pattern rather than silently dropping the feature. A human reading the theme later must know what was removed. Add rows here as new frameworks are encountered; the existing rows cover the frameworks seen so far.

| Source widget | Action | Comment to emit |
| --- | --- | --- |
| Wix Stores (shop, product, cart) | stub + WooCommerce note | `<!-- Wix Stores removed — install WooCommerce and replace this group with product blocks -->` |
| Wix Bookings | stub + link to `#booking` | `<!-- Wix Bookings removed — install a booking plugin and wire up the CTA -->` |
| Wix Forms / contact form | placeholder paragraph | `<!-- Wix Forms removed — install Contact Form 7, WPForms, or Gravity Forms -->` |
| Wix Members area | stub | `<!-- Wix Members area removed — consider BuddyPress or a membership plugin -->` |
| Wix Chat popup | drop | `<!-- Wix Chat removed — add a live-chat plugin if needed -->` |
| Squarespace Commerce product block | stub + WooCommerce note | `<!-- Squarespace product block removed — install WooCommerce and replace with product blocks -->` |
| Squarespace Events / Calendar | stub | `<!-- Squarespace Events removed — install The Events Calendar or a calendar plugin -->` |
| Webflow CMS Collection list | stub | `<!-- Webflow CMS Collection removed — register a WP custom post type and a Query Loop block to replace -->` |
| Webflow Ecommerce block | stub + WooCommerce note | `<!-- Webflow Ecommerce block removed — install WooCommerce and replace with product blocks -->` |
| Cargo gallery widget | keep image list, drop effects | `<!-- Cargo gallery effects dropped — images preserved in core/gallery -->` |
| Shopify embed (buy button, product card) | stub + WooCommerce note | `<!-- Shopify embed removed — install WooCommerce or use the Shopify Buy Button WP plugin -->` |
| Marquee / scrolling text strip | `marquee-strip` when simple; static paragraph otherwise | `<!-- Marquee reduced to static strip — complex source timing not reproduced -->` |
| Parallax background | static bg image; simple fixed attachment only when spec approves | `<!-- Parallax reduced — static bg retained -->` |
| Lottie / complex scroll-triggered animations | static poster or placeholder | `<!-- Animation reduced — source framework timeline not reproduced -->` |
| Video background on cover | `core/cover` with poster image | `<!-- Video background reduced to poster image -->` |

---

## What NOT to do

- **Do not emit a pattern without real content from the spec file.** If `{{HEADING}}` is missing in the spec, stop and re-read the section spec to find what heading text was captured. Do not write "Your headline here" or "Placeholder heading" as a fallback.
- **Do not use `core/cover` on light-background sections.** Use the `core/group` variant. The brightness rule above is not optional.
- **Do not inline CDN URLs or curl remote assets.** Always `get_theme_file_uri('assets/img-XX.ext')` for theme-shipped assets. For media already uploaded to the WP library, use the uploaded WP URL directly. The pipeline handles media upload; patterns must not fetch from CDNs.
- **Do not reuse one template for every section.** The spec file's `Interaction model` dictates the template. A logo strip is not a columns block. A media-text is not a gallery.
- **Do not re-derive the header or footer.** Reference our existing dynamic block-header and footer template parts.
