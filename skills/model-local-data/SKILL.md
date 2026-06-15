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

## What to produce

Write **`<outputDir>/data-model.json`** (fall back to `<source-dir>/data-model.json`) matching `DataModel` in `src/lib/replicate/local-data/types.ts`. Shape:

```jsonc
{
  "schema": 2,
  "cpt":      { "slug": "objet", "singular": "Objet", "plural": "Objets",
                "public": true, "supports": ["title","editor","custom-fields"] },
  "taxonomy": { "slug": "objet_cat", "label": "Categories", "hierarchical": true,
                "terms": [ { "slug": "glass", "label": "Glass" }, … ] },
  "fields":   [ { "key": "price_eur", "type": "integer" },
                { "key": "status", "type": "string" }, … ],
  "items":    [ { "id": "opaline-1965", "title": "…", "content": "…",
                  "terms": ["glass"], "meta": { "price_eur": 120, … },
                  "gallery": [ { "caption": "…", "url": "…?" } ] }, … ],
  "mounts":   [ { "selector": "#newestGrid",
                  "sourceCall": "mountGrid('#newestGrid', newestObjets(4))",
                  "query": { "postType": "objet", "perPage": 4, "orderBy": "date", "order": "DESC" },
                  "wrapperClass": "obj-grid obj-grid--4" }, … ],
  "card":     { "template": "<article class=\"obj-card\" …> … </article>",
                "maps": { "CAT_TONE": { "glass": "ph--t3", … } } },
  "sourceArrays": ["OBJETS"]
}
```

### How to fill each part

1. **Read the data array.** Find the in-file array(s) of records and the per-item id. Each record → one `items[]` entry: copy the id verbatim, the human title, optional long body → `content`, the category → `terms` (slugs), every other field → `meta` (numbers stay numbers), and any image list → `gallery` (caption per tile; `url` only if real files exist). **Never drop or summarize a record or a field** — reproduce them all.

2. **Derive the CPT + taxonomy.** Choose a singular slug for the type (the record noun). The grouping field (category/kind/collection) becomes the taxonomy; enumerate **all** its terms (slug + label). List every per-item field in `fields[]` with a coarse type (`string`/`integer`/`number`/`boolean`).

3. **Map the mounts.** For each empty container filled by JS: record its `selector` (the `#id`), the original `sourceCall` (provenance), and a `query` (postType = the CPT; `perPage` = the count the call requested, or `-1` for "all"; `order`/`orderBy` to match the source ordering — e.g. "newest" = `date`/`DESC`). `wrapperClass` = the container's own classes (the grid CSS hook).

4. **Author the card template.** Take the source's per-item card function (e.g. `objCard(o)`) and rewrite its markup as a static skeleton where every dynamic piece is a `data-dla-*` binding (the directives are applied by the renderer and removed from output):

   - `data-dla-text="<expr>"` — set the element's text.
   - `data-dla-attr="<name>:<expr>,<name2>:<expr2>"` — set attribute(s).
   - `data-dla-class="<expr>"` — append the resolved class token(s).
   - `data-dla-if="<cond>"` — drop the element unless the condition holds (use two variants for either/or, e.g. a normal vs struck price).

   **`<expr>` grammar:** `'literal'` · `id` · `title` · `content` · `cat.slug` · `cat.label` · `meta.<key>` · `gallery.<n>.caption` · `map.<name>.<expr>`
   **`<cond>` grammar:** `<expr>` (non-empty) · `<expr>=='lit'` · `<expr>!='lit'`

   Any value-keyed lookup the source did (e.g. `CAT_TONE[o.category]`) becomes a `maps` table referenced by `map.<name>.<expr>`. Keep the source's class names and structure exactly so the carried CSS keeps binding. (A literal prefix like `€` can be a static text node with a bound child span.)

5. **List `sourceArrays`.** The JS array identifier(s) the detail modal looks items up in (e.g. `["OBJETS"]`). The converter rebinds `ARR.find(x => x.id === id)` → `window.dlaItem(id)` (reads the per-card DOM island); everything else in the modal stays. If there's no modal lookup, use `[]`.

---

## Verify before handing off

- The model parses as JSON and every `items[]` record has an `id` that matches what the modal looks up by.
- `card.template` is a single root element, uses only the grammar above, and preserves the source card's classes/structure.
- Every `map.<name>` referenced in the template exists in `card.maps`; every `meta.<key>` referenced exists in `fields`.
- Counts match the source: items count == array length; taxonomy terms == the source's category list.

Then write `data-model.json` and tell the caller it's ready — `liberate_convert_local_site` auto-activates the data path when the file is present.

---

## Notes

- **Do not over-reach:** only model containers that are genuinely JS-data-rendered. A filter button bar built from a small config array (not content) can stay as JS.
- **Faithfulness:** the card render runs server-side (frontend AND the block-editor query-loop preview), so the binding must reproduce the source card markup exactly — that is what makes the grid non-empty and analyzable in the editor.
- **Honest gaps:** if a field can't be cleanly mapped (e.g. derived-at-runtime values), record what you did and surface the gap rather than inventing data.
