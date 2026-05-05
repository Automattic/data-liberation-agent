# Install Targets

The replica theme can be installed into one of three places. The MCP tool `liberate_replicate_install` picks one when `target: { kind: "auto" }` is passed. This reference covers what each target means and when to override `auto`.

## Detection precedence

1. **Studio** — preferred when available. Persistent, named site, built-in admin and DB.
2. **Playground** — used when Studio is not installed, or `_noStudio` is forced (test runs).
3. **Zip** — fallback for environments without either, or for CI/automation.

## Studio

**Detection:** `studio --version` exits 0.

**Site selection:**

- Read `~/Library/Application Support/Studio/appdata-v1.json` for the site list.
- If a site named `<siteSlug>-replica` already exists, install into it.
- Otherwise create a new site at `~/Studio/<siteSlug>-replica/` and add it to `appdata-v1.json` via the Studio CLI (`studio create-site` or equivalent).
- The MCP tool handles all of this — pass `target: { kind: "studio", siteId: "auto" }` and let it decide.

**Theme path:** `<sitePath>/wordpress/wp-content/themes/<siteSlug>-replica/`

**VFS gotcha:** Studio mounts the host site directory as `/wordpress` inside its VFS. When invoking `studio wp eval-file <script>` or any wp-cli command, paths must use the VFS prefix. The MCP tool already wraps this — see `src/lib/preview/studio.ts:toVfsPath`.

**Activation:** After writing files, the MCP tool runs `studio wp <site> theme activate <siteSlug>-replica` to switch to the replica theme.

**WooCommerce:** if `products.jsonl` exists in `outputDir`, the MCP tool ensures WooCommerce is installed and activated before activating the theme. This is non-negotiable for product sites — the Woo block templates `single-product.html` and `archive-product.html` require Woo to render.

**HTTPS:** Studio sites support HTTPS via mkcert. If the source site uses HTTPS-only resources (mixed content blocks them), enable HTTPS in the Studio site config. The MCP tool toggles this automatically based on whether the source's `screenshots/manifest.json` URLs are all HTTPS.

## Playground

**Detection:** Studio missing, but `@wp-playground/cli` available (or a Playground server is already running per `output/<site>/playground/blueprint.studio.json`).

**Theme path:** Theme files are uploaded via Playground's blueprint mechanism — they go into the in-memory VFS at `/wordpress/wp-content/themes/<siteSlug>-replica/`.

**Blueprint integration:** The MCP tool extends the existing `output/<site>/playground/blueprint.studio.json` with additional steps:

```jsonc
{
  "step": "writeFile",
  "path": "/wordpress/wp-content/themes/<siteSlug>-replica/style.css",
  "data": "..."
}
// repeated per file
{ "step": "activateTheme", "themeFolderName": "<siteSlug>-replica" }
```

For block plugins, similarly add `installPlugin` or `writeFile` steps and a corresponding `activatePlugin` step.

**Persistence:** Playground state is in-memory by default. The replica goes away when the Playground process exits. For longer-lived dev, prefer Studio.

**WooCommerce:** Already added to the existing blueprint when `products.jsonl` is present (see the example blueprint with `slug: "woocommerce"`).

## Zip

**Detection:** Neither Studio nor Playground available. Or the user explicitly requested a zip (e.g., to upload manually to a hosted WP site).

**Output path:** `output/<site>/<siteSlug>-replica.zip`. Zip contents:

```
<siteSlug>-replica/
  style.css
  theme.json
  functions.php
  templates/
  parts/
  patterns/
  ...
```

If block plugins were generated, they go in a separate zip: `<siteSlug>-replica-blocks.zip`.

**No verification:** The verification loop requires a running WordPress instance. With zip target, `liberate_replicate_verify` returns `{ ok: false, reason: "no_runtime" }`. This is fine — log it and skip the verification loop.

## Choosing a target manually

Pass an explicit target when:

- The user has multiple Studio sites and wants a specific one — pass `siteId`.
- You're testing the skill in CI without Studio — pass `kind: "playground"` or `kind: "zip"`.
- You want a clean install — pass `kind: "studio", siteId: "new"` to force a new Studio site.

## Failure modes

**Target install fails mid-way:** The MCP tool writes files atomically (per file, not transactionally across the theme). If a write fails, partially-written files may remain. The MCP tool returns `errors[]` listing which files failed; treat as a hard failure and stop. Do not run verification on a partially-installed theme.

**Theme activates but WP shows error:** This usually means a syntax error in `style.css` header, `functions.php`, or `theme.json`. Run the `testing-php` and `testing-wp-runtime` skills before installing — they catch most of these.

**Theme installs and activates but pages are blank:** Most likely cause is a template referencing a pattern that wasn't registered. Check `functions.php` for the pattern registration calls. The `creating-themes` skill enforces this; double-check it ran cleanly.

**Studio create-site fails:** Out of disk, port conflict, or Studio config corruption. The MCP tool surfaces the underlying CLI error. If it's a port conflict, retry with a different port (`5678`, `8881-8899` are common). If config is corrupt, the user has to fix Studio manually — surface an `openQuestion`.
