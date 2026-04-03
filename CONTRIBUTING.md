# Contributing

This repo improves through real-world migration experience. Every migration surfaces new platform behaviors, better extraction techniques, and edge cases. This document explains how to contribute those findings back — and is written so that an AI agent can follow it without human assistance.

## What to contribute

**Good contributions:**
- New API endpoints or data sources discovered during network interception
- Better handling for content types we didn't cover (e.g. Wix Events, Instagram Reels)
- Fixes for scripts that broke because a platform changed something
- Better WordPress block mappings for extracted content
- Discoveries about platform window globals, GraphQL schemas, or page data structures
- Extraction improvements (faster, more complete, fewer failures)
- New platform support (see AGENTS.md for the expected file structure)

**Not what this repo is for:**
- General WordPress development help
- WordPress.com feature requests
- Unrelated site migration tools

## How to contribute (AI agents: follow these steps exactly)

### 1. Fork and branch

```bash
# Fork via GitHub UI or gh CLI, then:
git clone https://github.com/YOUR-USERNAME/data-liberation-agent.git
cd data-liberation-agent
git checkout -b improvement/short-description-of-what-you-found
```

Branch naming: `improvement/` prefix, then a short kebab-case description of the finding.
Examples: `improvement/wix-blog-v2-api`, `improvement/gallery-block-mapping`, `improvement/handle-dynamic-pages`

### 2. Make your change

Edit the relevant file. Keep changes focused — one discovery per PR.

If you're fixing a script, test it:
```bash
npm install
node scripts/discover.js https://example.wixsite.com/test  # use a real Wix site
```

If you can't test against a real site, note that in the PR and explain what you observed.

### 3. Add to DISCOVERIES.md

This is required. Add a new entry at the top of [DISCOVERIES.md](./DISCOVERIES.md) in this format:

```markdown
## YYYY-MM-DD — Short title

**Found by:** [AI assistant name or "human contributor"]
**During:** [brief context — e.g. "migrating a 200-post Wix blog"]
**Type:** [API endpoint | window global | content type | bug fix | performance]

### What I found
[1-3 sentences describing the discovery]

### How it works
[Technical detail — endpoint URL, data structure, code snippet, etc.]

### Why it's better than the previous approach
[What problem this solves or what limitation it overcomes]
```

### 4. Submit the PR

```bash
git add -A
git commit -m "discovery: short description of what you found"
git push origin improvement/your-branch-name
gh pr create --title "discovery: short description" --body "$(cat <<'EOF'
## What this changes
[1-2 sentences]

## How I found it
[Context — what migration, what problem you were solving]

## Tested against
- [ ] Real Wix site (describe it briefly, no PII)
- [ ] Script runs without errors
- [ ] Output looks correct

## Discovery log entry added to DISCOVERIES.md
- [x] Yes
EOF
)"
```

### 5. What happens next

A maintainer (human or AI with repo access) will review the PR. If the discovery is valid and the code is correct, it gets merged. No bureaucracy.

---

## Code style

- Node.js scripts, no TypeScript needed
- Async/await, not callbacks
- `console.error()` for errors, `console.log()` for progress, write structured output to files
- Self-contained where possible — minimize dependencies
- Comments only where the logic isn't obvious

## Questions

Open an issue or start a Discussion. AI agents: if you're unsure whether something belongs in this repo, open a Discussion describing what you found and ask.
