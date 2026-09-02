# data-liberation-agent

Liberate any website into a complete, portable HTML site.

## The problem

Closed platforms make it hard to leave. Wix has no HTML export and caps RSS at 20 posts. JavaScript-rendered content and limited APIs leave your site locked inside.

## The solution

Point it at a URL and get your site back as plain files:

```bash
data-liberation https://example.com/
```

Every retained route is liberated into a directory of HTML, CSS, media, and fonts, with references rewritten so navigation works locally. It runs on its own, and the command serves it so you can click through it immediately.

**HTML is the contract.** The liberated site is the deliverable — not an intermediate format on the way to somewhere else, and not tied to any destination.

**WordPress is one option, not the assumption.** If you want the site rebuilt in WordPress, the agent skills reconstruct it as editable blocks + WooCommerce or as a high-fidelity theme replica. That step is optional and runs after liberation, from the same local copy, without touching the network again.

**Where to host WordPress**: If your current provider also offers WordPress, you can move to WordPress and stay with them. WordPress.com is another option: the $4/mo Personal plan now supports plugins and themes, and the [WordPress.com MCP integration](https://wordpress.com/blog/2026/03/20/ai-agent-manage-content/) gives AI agents direct write access.

## Supported platforms

| Platform | Status | Prompt |
|---|---|---|
| **GoDaddy Websites & Marketing** (pages/blog) | Ready | [`prompts/godaddy-wm.md`](./prompts/godaddy-wm.md) |
| **Hostinger Website Builder** (blog/pages/products) | Ready | — |
| **HubSpot** | Ready | — |
| **Shopify** (blog/pages/products) | Ready | [`prompts/shopify.md`](./prompts/shopify.md) |
| **Squarespace** | Ready | [`prompts/squarespace.md`](./prompts/squarespace.md) |
| **Webflow** | Ready | [`prompts/webflow.md`](./prompts/webflow.md) |
| **Weebly** (blog/pages/products) | Ready | — |
| **Wix** | Ready | [`prompts/wix.md`](./prompts/wix.md) |
| **Any other website** (generic fallback) | Best-effort | — |

All eight platforms have MCP adapters with full extraction support including products (exported as WooCommerce-compatible CSV). Sites matching none of them fall back to a generic `default` adapter that renders each page in a headless browser and extracts the main content, media, and any JSON-LD products — best-effort, since it can't key off platform-specific markup. GoDaddy Websites & Marketing is pages + blog only in v1; GoDaddy Online Store (OLS) product support is planned for v1.1.

### Custom platforms

The platform layer is a public, registration-based API — platform ids are open strings, and a consumer-defined platform registers, auto-detects, discovers routes, and flows through capture orchestration without editing core. The generic fallback uses the same contract. See [Platform API](/docs/platform-api.md) for the contract, a runnable example (`docs/examples/custom-platform.mjs`), and the Claude Code `DATA_LIBERATION_PLATFORMS` boot hook.

## Getting started — agent-first

data-liberation-agent is also built to be driven by an AI agent. The front door is the `liberate` skill: detect the platform, inventory every page/post/product, liberate the whole site into portable HTML, and serve the result. If you then ask for WordPress, it reconstructs the site as an editable block theme or a high-fidelity replica and imports it into a local WordPress preview.

> **Studio is only needed for the optional WordPress preview/import.** Liberating a site needs no WordPress at all. Install [Automattic Studio](https://developer.wordpress.com/studio/) before asking for a WordPress reconstruct.

### Claude Code

Install from the marketplace:

```bash
claude plugin marketplace add Automattic/data-liberation-agent
claude plugin install data-liberation@data-liberation
```

Or from a local checkout (for development on the plugin itself):

```bash
cd data-liberation-agent
claude plugin marketplace add .
claude plugin install data-liberation@data-liberation
```

Then, in Claude Code:

```
/liberate https://your-site.com
```

What you'll see: the agent detects the platform, inventories all pages/posts/products, pauses to confirm scope and estimated time, then extracts content and media. It then drives the design phase — clustering page layouts, building a responsive block theme that mirrors your source site's structure and visual style, and importing everything into Automattic Studio. When it finishes you get a local preview URL and a `run-report.json` summarizing what was built, what's faithful, and any gaps.

The result is a responsive, editable WordPress block theme — not a static copy.

Note: the engine CLI / `siteToTheme` consumes static source directories; liberating an external dynamic site still starts with DLA's Playwright capture, which feeds captured SectionSpecs into the engine.

### Codex

```bash
cd data-liberation-agent
codex
```

The `.codex-plugin/plugin.json` and `.mcp.codex.json` register the MCP server and skills automatically (Codex does not expand `${CLAUDE_PLUGIN_ROOT}`, so it uses a plugin-root-relative config instead of `.mcp.json`). The `liberate` flow runs sequentially on Codex (the builder fan-out step degrades to a sequential loop).

Then in Codex:

```
$liberate https://your-site.com
```

### Gemini CLI

```bash
cd data-liberation-agent
gemini extension link .
```

### Any MCP client

Run the MCP server over stdio:

```bash
npx tsx src/mcp-server.ts

# or

npm run mcp
```

> **First-time browser setup.** Extraction/capture uses Playwright's Chromium. It is no longer installed automatically on `npm install` — run it once explicitly:
>
> ```bash
> npm run setup:browser
> ```

It exposes MCP tools for deterministic capture and extract → QA → import workflows. The ones you'll call directly:

`liberate_capture`, `liberate_detect`, `liberate_discover`, `liberate_inspect`, `liberate_extract`, `liberate_screenshot`, `liberate_status`, `liberate_qa`, `liberate_verify`, `liberate_setup`, and `liberate_import` — plus `liberate_paths` (resolve the output directory) and `liberate_probe` / `liberate_map_apis` (browser-based diagnostics). `liberate_capture` writes a canonical `artifact.json`, replayable `website/` tree, capture receipt, and diagnostics. The remaining tools drive the design/reconstruction phase and are orchestrated by the skills rather than called by hand. Full reference with parameters: [docs/mcp.md](./docs/mcp.md).

## Output

A successful run produces, in `~/data-liberation/<host>/` (the default for the `liberate` flow; set the `DLA_OUTPUT_DIR` environment variable to change it, or pass `outputDir` when calling the MCP tools — `liberate_paths` reports the resolved path):

- `~/data-liberation/<host>/`
   - `output.wxr` — WordPress eXtended RSS file, ready to import via WordPress Admin > Tools > Import
   - `media/` — downloaded images and attachments with local paths rewritten in the WXR
   - `redirect-map.json` — old platform paths mapped to new WordPress slugs
   - `extraction-log.jsonl` — per-URL extraction log (atomic dedupe for resume)
   - `session.json` — pipeline stage, captured opts, per-entity progress counters, and adapter pagination cursors
   - `media-stubs.json` — per-asset download status so permanently-broken URLs stop retrying across resume runs
   - `products.csv` — WooCommerce-compatible product CSV (if the site has e-commerce)
   - `products.jsonl` — raw product data streamed during extraction

## Screenshots & design tokens

The `liberate` flow captures, for every URL, full-page + scrolled-state screenshots (desktop 1440×900 and mobile 390×844), the rendered HTML, and site-wide design tokens — used by the reconstruction phase and handy for feeding AI design-system tools. Via raw MCP this is the `liberate_screenshot` tool (or `screenshots: true` on `liberate_extract`).

Artifacts land under the output directory:

- `screenshots/{desktop,mobile}/<slug>.png` (plus `.scrolled.png` post-scroll variants)
- `html/<slug>.html` — rendered HTML per URL
- `screenshots/manifest.json` — the URL → files join table
- `palette.json`, `typography.json`, `breakpoints.json` — aggregated per-site design tokens

The join back to `output.wxr` and `products.jsonl` happens on the filesystem via `manifest.json`, keyed by URL — nothing is written into WordPress postmeta.

## Additional documentation

* [How it works](/docs/how-it-works.md)
* [Platform API — custom platforms](/docs/platform-api.md)
* [AI agent commands](/docs/commands.md)
* [AI skills](/docs/skills.md)
* [MCP server tools](/docs/mcp.md)
* [Wix authenticated content endpoints](/docs/wix-content-endpoints.md) — reference of the ten load-bearing content endpoints behind Wix's editor / dashboard auth

## Related

- [WordPress Data Liberation project](https://wordpress.org/data-liberation/) — the official effort
- [WordPress.com MCP](https://wordpress.com/blog/2026/03/20/ai-agent-manage-content/) — AI agent write access to WordPress.com

## Troubleshooting the preview

Preview and import require [Automattic Studio](https://developer.wordpress.com/studio/) — install the app first (the `studio` CLI ships with it). Studio sites are persistent and named after the output directory's domain slug (`example-com`, `example-com-2` on collision).

**"Studio not found"** — the `studio` CLI is not on PATH. Install Studio from https://developer.wordpress.com/studio/ and relaunch the terminal so the PATH update takes effect.

**"Studio create-site fails"** — out of disk, port conflict, or Studio config corruption. The error message includes the underlying CLI output. If it's a port conflict, retry. If the Studio config is corrupt, reinstalling Studio fixes it.

**Preview is not a secure environment.** Studio sites auto-log in as `admin`/`password` and bind to `localhost`. Do not paste secrets into them.
