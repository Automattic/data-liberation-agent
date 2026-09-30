# Generic source behavior discovery

Plain URL capture learns diagnosed dynamic behavior from the source itself,
with no site recipe. For each page `source-interactivity.json` marks
`unreproduced`, capture:

1. **Observes** the live source twice under controlled `Date` values and
   timezones. Instrumentation installed before source scripts records
   timestamped text of leaf and mixed-content elements, visibility changes with
   their mechanism (`visibility` or `display`), click/pointer listener
   registrations, and 2D canvas drawing calls. Startup ends when text has been
   quiet (bounded); each discovered click is probed from a settled page.
2. **Learns** an editable program in the Blocks Engine motion vocabulary
   (`learned-motion.ts`):
   - sequential text reveals: per-character cadence, delay after the previous
     step, and click replay trigger and delay;
   - a static pending message with the common cycling-dot suffix;
   - elements hidden until a reveal starts (`revealSelectors`);
   - a live clock: which elements carry hour, minute, AM/PM, GMT offset and
     locale date (proved by the two controlled times), plus its startup and
     replay frames and date reveal.
   Values are measured, never embedded editorial copy: the runtime replays the
   current DOM text, so an edited page replays its edited value.
3. **Reports** everything the vocabulary cannot express in `unsupported`
   (unrecognized text or visibility changes, unmatched time-derived text,
   concurrent reveals, and canvas drawing). Nothing is substituted.
4. **Reuses source canvas code** (`canvas-sandbox.ts`). A canvas drawing
   algorithm is not re-derived: the page's own captured, hash-verified scripts
   that draw on a canvas run behind a DOM membrane. Canvas elements, drawing
   contexts and event listeners are live; reads return real values; every write
   to non-canvas content is discarded, so the source can never overwrite the
   editable page. If the sandboxed copy does not reproduce the source pointer
   response, promotion falls back to learned motion with canvas as a residual.
5. **Promotes** (`learned-motion-promotion.ts`) only after a staged portable
   copy reproduces the learned behavior against the live source at
   390/768/1440px with a contract derived from the evidence. The markers and
   the portable interpreter (`motion-runtime.ts`) are then written to
   `website/`, with a `portable-motion.json` receipt (`origin: "learned"`)
   carrying the derived contract and the unsupported residuals.

Plain `compare` re-verifies the receipt on every run and fails visibly for each
residual: `source behavior not translated (<selector>): <reason>`.

## WordPress

The page carries inert `data-blocks-engine-motion-steps` and
`data-blocks-engine-live-clock` markers. Blocks Engine lowers them to editable
motion-sequence and live-clock blocks with their own view scripts. The portable
interpreter is tagged `data-blocks-engine-marker-runtime`, so the importer
replaces it with those view scripts rather than loading both.

## Current limits

- Canvas: source canvas code runs only if it still works when its content
  writes are discarded; code whose drawing depends on content it would have
  created itself stays an explicit residual. In WordPress the sandbox is a
  preserved runtime island (`runtime_js`); page content remains native blocks.
- Measured timings carry timer jitter from the observing machine; the fidelity
  gate compares observable phases and settled state, not exact milliseconds.
- The vocabulary expresses sequential reveals, pending dots, reveal visibility
  and one live clock per page; other patterns are reported, not approximated.

Tracker: https://github.com/Automattic/data-liberation-agent/issues/425
