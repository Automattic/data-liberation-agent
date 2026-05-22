---
name: generating-images
description: Image generation markup patterns — load this when generating content that includes images
disable-model-invocation: true
---

## When to use me

Use this skill when generating any content that includes images (themes, blocks, patterns, landing pages).

## Image Generation Rules

When you are generating a project that requires an image you should ALWAYS follow these rules:

Use ONLY the native `src` and `alt` attributes on img elements. Do NOT use any custom data attributes.

- **src**: The image path using `theme:./assets/` prefix followed by the filename. The filename must only contain lowercase letters (a-z), numbers (0-9), and hyphens (-). No spaces or special characters. Always use `.png` extension. Example: `theme:./assets/hero-beach-sunset.png`

- **alt**: A structured string containing all image generation parameters in this exact format:
  ```
  AI_IMAGE: description | style | aspect-ratio
  ```

- **Updating existing images**: If you are updating any aspect of an existing image, add a version number to the filename, e.g. `theme:./assets/hero-beach-sunset-v2.png`

## Alt Attribute Format

The alt attribute must follow this exact format:

```
AI_IMAGE: description | style | aspect-ratio
```

**Format breakdown:**
- `AI_IMAGE:` — Required prefix marker (exactly as written)
- `|` — Pipe character used as separator between values
- `description` — The image generation prompt (1-3 sentences, be specific about composition, colors, mood, and elements)
- `style` — One of the style options below
- `aspect-ratio` — One of: `square`, `landscape`, `portrait`

**Aspect ratio options:**
- `square`: 1:1 ratio (1024x1024)
- `landscape`: 16:9 ratio (1792x1024) — use for hero images, banners
- `portrait`: 9:16 ratio (1024x1792) — use for tall images

**Grid and row consistency:**
When creating multiple images that will be displayed together in a row or grid (e.g., team members, product cards, blog post thumbnails, gallery items), ALL images in that group MUST use the same aspect ratio and orientation. This ensures visual alignment and a cohesive layout. For example, if you have three cards in a row, all three images should be `landscape`, `portrait`, or `square` — never a mix.

**Style options:**
- `photorealistic` — Photographic, realistic images
- `digital-art` — Modern digital artwork
- `illustration` — Hand-drawn style illustrations
- `minimalist` — Clean, simple, minimal design
- `flat-design` — Flat, modern UI design style
- `3d-render` — 3D rendered appearance
- `abstract` — Abstract artistic style
- `watercolor` — Watercolor painting style

## Example Image Block

```html
<!-- wp:image {"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="theme:./assets/feature-product.png" alt="AI_IMAGE: A professional product shot with clean studio lighting and minimal background | photorealistic | square"/></figure>
<!-- /wp:image -->
```

## Example: Complete Hero Section

```html
<!-- wp:cover {"url":"theme:./assets/hero-beach-sunset.png","dimRatio":50} -->
<div class="wp-block-cover">
    <img class="wp-block-cover__image-background" alt="AI_IMAGE: A photorealistic image of a tropical beach at sunset with calm turquoise ocean, golden hour lighting, and a serene atmosphere | photorealistic | landscape" src="theme:./assets/hero-beach-sunset.png"/>
    <div class="wp-block-cover__inner-container">
        <!-- Hero content here -->
    </div>
</div>
<!-- /wp:cover -->
```