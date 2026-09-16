# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the version in `package.json` is the single source of truth: every
plugin manifest (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
`gemini-extension.json`) is kept in sync with it via `npm run version:sync`,
and `npm run check:versions` (run in CI) fails when any manifest disagrees.

Cutting a release is a manual, ordered sequence today, not a single command:

1. Add an `## [Unreleased]` entry here describing what changed.
2. Bump `package.json`'s `version`.
3. Run `npm run version:sync` to propagate it to every manifest.
4. Run `npm run build:mcp-bundle` and commit the regenerated `dist/` bundles.
5. Rename `[Unreleased]` to the new version and date, commit, tag, and push.

## [Unreleased]

## [0.2.2] - 2026-06-19

### Fixed

- Local-site conversion preserved nested styling, classless spans, list-item
  classes, and loose body-level siblings of `<main>` that were previously
  dropped during the block conversion.

## [0.2.1] - 2026-06-19

### Added

- Local-site conversion carries HTML `<img>`/SVG assets into the theme and
  hardens carried inline `<script>`/`<style>` handling.
