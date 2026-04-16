# AGENTS.md — Instructions for AI Agents

## Overview

`data-liberation-agent` extracts content from closed web platforms (Wix, Squarespace, Webflow, Shopify, Weebly, Hostinger, HubSpot, GoDaddy Websites & Marketing) and produces WordPress-compatible WXR files. All eight platform adapters are implemented.

Three entry points — MCP server (11 tools), CLI (`src/cli.ts`), and Claude Code plugin (`claude plugin add .`) — all share `src/lib/` and `src/adapters/`. The plugin just wraps the MCP server.

The `scripts/` directory contains legacy standalone extraction scripts (Wix via Playwright, Squarespace via CDP). These predate the adapter system and are kept for reference.

## Adding a New Platform

1. Create `src/adapters/<platform>.ts` implementing `PlatformAdapter`
2. Register it in `src/mcp-server.ts` (see the "Static adapter imports" comment)
3. Add platform-specific barriers and workarounds as inline comments in the adapter
4. Update the supported platforms table in `README.md`

Adapters produce structured content and call into `WxrBuilder`, `ExtractionLog`, and `media` utilities for output.

## Non-obvious Details

- WXR builder targets WXR 1.2 spec compliance
- `classifyUrl` types: `homepage`, `post`, `product`, `gallery`, `event`, `page` (no `category`/`author`/`other`)
- Media filename collision handling uses numeric suffixes (`-2`, `-3`), not hashes
- `detect-platform` uses domain-level URL patterns and HTTP fingerprinting (headers + HTML markers) — no path-based detection
