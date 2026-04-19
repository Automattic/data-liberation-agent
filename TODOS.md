# TODOS

Deferred work items with enough context for someone picking this up later.

---

## T1 — Console + network log capture per URL (screenshot feature)

**Priority:** P2 · **Effort:** S · **Depends on:** none

**What:** Extend the screenshotter to write `output/<site>/debug/<slug>.log.json` on every capture. Content: browser `console` output (messages + levels) and HTTP request summary (method, url, status, duration) for the capture's load.

**Why:** When a captured page renders wrong — blocked third-party resources, CSP errors, silent JavaScript failures — the screenshot and rendered HTML provide no diagnosis. Browser devtools output does. Writing it during capture makes failures debuggable weeks later without re-running.

**Context:**
- Playwright exposes both directly: `page.on('console', ...)` and `page.on('response', ...)` / `page.on('requestfailed', ...)`.
- Current `failures.json` captures one error per failed URL; this would capture the full browser-side timeline for every URL.
- Estimated size: 10–50 KB per URL.
- Decision trail: proposed during deep plan review (2026-04-18), deferred to here as decision 2B.
- **Where to start:** add a `captureDebugLog: boolean` option to `ScreenshotOpts`, wire listeners inside the per-URL capture, flush JSON after context close.

---

## T2 — Extract MCP handlers out of mcp-server.ts

**Priority:** P3 · **Effort:** M · **Depends on:** none

**What:** Move each tool handler out of the inline switch in `src/mcp-server.ts` into its own file under `src/mcp-server/handlers/<tool>.ts`. Leave `mcp-server.ts` as a thin router that imports and dispatches.

**Why:** `mcp-server.ts` is already 600+ lines of inline handlers for 11 tools. After `liberate_screenshot` lands it will be 12. Each new tool grows a file that's already hard to navigate. Extraction aligns the codebase with existing taste references (`ImportSession`, `AdaptiveTuner`, `runExtractionLoop`) — small focused modules.

**Context:**
- Pure mechanical refactor. Handlers are self-contained.
- Test gap: current handlers have little direct test coverage. Refactor is a good moment to add it.
- **Where to start:** pick one handler (the smallest — `liberate_detect` or `liberate_setup`) as a template. Define a handler contract (`(args: Record<string, unknown>, ctx: HandlerContext) => Promise<ToolResult>`). Migrate one tool at a time to minimize merge conflicts.
- Decision trail: deep plan review 2026-04-18, deferred as decision 4A.

---

## T3 — WxrReader gains a native in-place write path

**Priority:** P3 · **Effort:** M · **Depends on:** screenshot feature (uses round-trip rebuild initially)

**What:** Extend `WxrReader` (or add a `WxrEditor` peer) with targeted mutation APIs — e.g. `addPostmeta(sourceUrl, key, value)` and `write()` — so callers can modify an existing WXR without re-serializing every item through `WxrBuilder`.

**Why:** The Tier 2 stamping pass currently reads WXR → rebuilds via `WxrBuilder` → serializes. Correct, but full rewrite per stamp. For typical WXRs (≤100 MB) this is fine. For larger WXRs (thousands of items, many attachments), a targeted stream rewrite is meaningfully faster and lower memory.

**Context:**
- Current path introduced by deep plan review decision 6A (2026-04-18).
- Not urgent — current implementation is correct.
- Revisit when stamping latency becomes user-visible.
- **Where to start:** benchmark current stamp-rebuild path on a 50 MB WXR; if noticeably slow, design an XML-aware mutation API using the existing `fast-xml-parser` infrastructure.

---

## T4 — Responsive breakpoint discovery for screenshots

**Priority:** P3 · **Effort:** M · **Depends on:** site-analysis foundation (shipped with screenshot feature v1)

**What:** Parse rendered stylesheets to detect CSS `@media (min-width: …)` breakpoints. For each discovered breakpoint, capture an additional screenshot at that viewport width. Emit a `breakpoints.json` per site.

**Why:** Desktop + mobile capture catches ~80% of design-system needs but misses custom breakpoints (tablets, narrow desktops, extra-large displays) where layouts genuinely shift. A theme-generation tool fed more breakpoints can derive more accurate responsive rules.

**Context:**
- Browser exposes `document.styleSheets` + `CSSRule` enumeration; extraction is doable in a single `page.evaluate()`.
- Output should be deduplicated and sorted.
- Decision trail: deep plan review 2026-04-18 (cherry-pick candidate surfaced but deferred).
- **Where to start:** implement breakpoint extraction inside `site-analysis.ts`'s existing evaluate call; emit `breakpoints: number[]` in the returned analysis payload; add a separate output file.
- **Status update 2026-04-18 (eng review of design-replication plan):** T7 accepted — bundle this INTO the SP1 spec (palette/typography aggregation fix), since SP1 already touches `site-analysis.ts`. SP1 becomes: Gap A + T4.

---

## T5 — `liberate_compare`: visual fidelity score between two screenshot directories

**Priority:** P1 (blocks design-replication SP3 final sign-off) · **Effort:** M · **Depends on:** screenshot feature (present); Gap A (SP1)

**What:** A new command/tool that takes two screenshot directories (origin + replica) and emits a per-URL similarity score. Pixelmatch, odiff, or resemble.js under the hood. Output: `comparison.json` with `{ url, desktop: {score, diff_path?}, mobile: {score, diff_path?} }[]`.

**Why:** The design-replication plan's SP3 ("maus.com replica demo") has no measurable success criterion without a fidelity score. The current plan leaves "looks the same" to eyeball evaluation — CRITICAL GAP per the eng review (RESCUED=N, TEST=N, USER SEES=Silent). This tool closes the gap and is independently useful as a visual-regression primitive.

**Context:**
- Natural consumer of the existing screenshot manifest format — join by URL across two manifests.
- Could emit a side-by-side HTML report as well as raw JSON scores.
- Library candidates: `pixelmatch` (well-maintained, by Mapbox, ~50k weekly); `odiff` (faster C bindings).
- Decision trail: eng review of `docs/superpowers/specs/2026-04-18-design-replication-plan.md` on 2026-04-18 flagged this as the blocking gap for SP3.
- **Where to start:** new `src/lib/screenshot/compare.ts` with `compareScreenshotDirs(originDir, replicaDir): ComparisonResult[]`. Add CLI subcommand `data-liberation compare <origin> <replica>` and MCP tool `liberate_compare`.

---

## T6 — Parameterize the "Created with Telex" footer credit in creating-themes skill

**Priority:** P2 · **Effort:** S · **Depends on:** SP2 (site-skills bootstrap)

**What:** `telex/agent/config/skills/creating-themes/SKILL.md` currently hardcodes a footer credit referencing Telex and its URL. When this skill moves to `../site-skills/`, the credit string needs to become configurable so each consumer (telex, data-liberation, Studio Code) can inject its own brand.

**Why:** Site-skills is the canonical shared source; baking in one consumer's brand breaks genericity. Parameterizing keeps the skill reusable.

**Context:**
- Current hardcoded line (~line 20 of SKILL.md): `Created with <a href="https://telex.automattic.ai">Telex</a>, powered by <a href="https://wordpress.org">WordPress</a>`.
- Options: (a) a config variable the skill reads at invocation time (e.g. `$SITE_SKILLS_CREDIT`), (b) a runtime parameter the skill expects in the invoking agent's context, (c) a template token like `{{theme_credit}}` that the skill leaves to be filled in.
- Decision trail: eng review 2026-04-18 — T6 accepted.
- **Where to start:** decide mechanism during SP2 spec; apply to the migrated SKILL.md and document in site-skills README.

---

## T8 — Per-element bounding-box rects in SP1's analyzePage (SP1.1)

**Priority:** P3 · **Effort:** S · **Depends on:** SP1 shipped, SP1.5 in real-world use

**What:** Extend SP1's `analyzePage` (`src/lib/screenshot/site-analysis.ts`) to emit per-element bounding-box rects for cited selectors — e.g. the computed `button` element's viewport rect, the `h1`'s rect. Write into a new `rects.json` per site or inline into the existing typography/analysis output.

**Why:** SP1.5's `design-foundation.md` currently embeds full screenshots for evidence (a reviewer has to eyeball-hunt for the cited element). With per-element rects, the MD renderer can crop the screenshot around the evidence element — much higher-signal review. Deferred from SP1.5 Open Question 3 to avoid coupling SP1.5 shipping to a SP1 extension.

**Context:**
- SP1.5 spec reviewed 2026-04-19 resolved open question 3 as "full screenshots in v1; rects as SP1.1 follow-up if reviewers find full-screenshot hunting painful."
- Browser exposes `Element.getBoundingClientRect()` inside the existing `page.evaluate()` in `analyzePage`. Extension is a small additive field.
- Downstream: SP1.5's `md-renderer.ts` would gain a cropping step using the rects (sharp? native canvas?). Introduces a small image dep.
- **Where to start:** extend `analyzePage` return shape with `rects: { [selector]: {x,y,width,height} }`. Update `md-renderer.ts` (SP1.5) to crop when rect is present, fall back to full screenshot when not.
- Only pursue this when real reviewers of `design-foundation.md` complain that full-page screenshots force too much visual hunting.
