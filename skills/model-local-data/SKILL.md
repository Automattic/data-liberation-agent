---
name: model-local-data
description: Analyze an OWNED local static site's JavaScript to find JS-rendered data grids (an empty <div id="…"> filled at runtime by a mount call over an in-file data array) and emit a data-model.json that turns that data into a real WordPress CPT + taxonomy + native query loops while keeping the styling/animation/modal JS. Produces the model that liberate-local's convert step consumes. Use before liberate_convert_local_site when the source renders its content from JS data (catalogs, listings, galleries) rather than static HTML.
---

# Model local data → WordPress-driven data

Some hand-authored sites render their main content from **JavaScript data**: an empty container like `<div id="newestGrid"></div>` is filled at runtime by a mount call (`mountGrid('#newestGrid', newestObjets(4))`) that maps over an in-file array (`const OBJETS = [ … ]`). On a straight carry these grids are **empty in the block editor** — the data lives in JS, not WordPress.

This skill reads that JS and produces a **`data-model.json`** describing how to make the data WordPress-driven: a custom post type + taxonomy + per-item meta, native `core/query` loops in place of the mounts, and a faithful card render — while the source's styling, animation, filtering, and detail-modal JS keep running (reading WordPress data from per-card DOM islands).

The deterministic converter (`liberate_convert_local_site`) consumes the file; this skill only **authors the model by reading the source**.

---

## When it applies

Run this BEFORE `liberate_convert_local_site` when the source has any of:

- empty mount containers (`<div id="…">` / `<ul id="…">` with no children) filled by JS,
- an in-file data array of records (each with a stable id),
- a list/grid/catalog/gallery rendered by mapping that array to card markup,
- optionally a detail modal that looks an item up by id (`ARR.find(x => x.id === id)`).

If the source content is static HTML (no JS data array), this skill does not apply — skip straight to convert.

---

## How to produce it (scaffold-first)

1. **Run the deterministic scaffold.** Call `liberate_data_model_scaffold({ dir: "<source-dir>", outputDir: "<output-dir>" })`. It writes `<output-dir>/data-model.draft.json` (a partial `DataModel`) and returns `{ model, skillTodos, discovered, validation }`. The scaffold has already extracted every record verbatim (`items[]`), enumerated `taxonomy.terms` and `fields[]`, linked the `mounts[]`, and set `sourceArrays`. The `discovered` summary lists which arrays were found/rejected — if your data array is missing there, see the manual fallback.

2. **Resolve ONLY the `skillTodos`.** Each has a `path`, `instruction`, and source `evidence`. Do not re-author filled slots. Typical todos:
   - **`card.template`** (always present) — rewrite the per-item card function (in `evidence`) into a single-root skeleton with `data-dla-*` bindings preserving the source classes. Grammar: `data-dla-text/attr/class/if`; `<expr>` = `'lit'` | `id` | `title` | `content` | `cat.slug` | `cat.label` | `meta.<key>` | `gallery.<n>.caption` | `map.<name>.<expr>`; `<cond>` = `<expr>` | `<expr>=='lit'` | `<expr>!='lit'`. Add value-keyed lookups (e.g. `CAT_TONE`) to `card.maps`.
   - **`mounts[i].query.order`** — confirm/adjust ordering + `perPage` (scaffold defaults to date/DESC).
   - **`items[].id` / `items[].title` / `taxonomy`** — low-confidence role guesses; confirm or correct. If a value belongs in `meta`, move it (never drop it).
   - **`mounts[i]`** — an orphan container; confirm it is content-driven or remove it.
   - **`items`** (only when no static array was found) — author the model by hand from the source.

3. **Validate and write.** Re-check that every `map.<name>`/`meta.<key>` the template references exists, item count == array length, terms == the source's category set. Write the resolved model to `<output-dir>/data-model.json`. `liberate_convert_local_site` auto-activates the data path when that file is present.

## Manual fallback (if the scaffold tool is unavailable)

If `liberate_data_model_scaffold` is not registered (e.g. the MCP server hasn't restarted to pick it up) or errors, author `data-model.json` by hand: read the source JS, copy every record into `items[]` (id/title/content → as appropriate, category → `terms`, other fields → `meta`, image lists → `gallery`), enumerate `taxonomy.terms`, list `fields[]`, map each empty mount container to a `query`, author `card.template` with the `data-dla-*` grammar above, and set `sourceArrays`. Never drop or summarize a record or field.

## Faithfulness rules

- Never drop or summarize a record or field. The card render runs server-side (frontend AND the editor query-loop preview), so the binding must reproduce the source card markup exactly. Surface honest gaps rather than inventing data.
