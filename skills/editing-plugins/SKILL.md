---
name: editing-plugins
description: Guidelines for modifying existing WordPress plugins — load this before editing plugin files
disable-model-invocation: true
---

## When to use me

Use this skill when modifying an existing plugin (files already exist in the workspace).
Do not use this skill when creating a new plugin from scratch.

## Editing Guidelines

- Read the main plugin file and any relevant includes before making changes — understand the current architecture, hooks, and data flow
- Make minimal, targeted changes — only modify what the user requested
- Only touch files that need to change — do not rewrite unrelated files
- Use the `edit` tool for targeted changes; only use `write` when replacing more than 50% of a file
- Maintain the plugin's existing naming conventions and function prefixes
- When adding hooks or filters, register them at the correct priority
- When modifying database operations, preserve existing sanitization and escaping
- After changes, verify the plugin still activates without errors and existing functionality is intact
