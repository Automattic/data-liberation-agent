# Slideshow capture (captured-interactions/v2)

A `pages[].components[]` node with `kind: "carousel"` and `function: "slideshow"`
represents an inline slideshow. It is not a dialog and its state HTML must not
be reparented into a popup. Native editable materialization belongs to the
Blocks Engine follow-up; this record is evidence, not a claim of destination
runtime readiness.

```json
{
  "selector": "#gallery",
  "kind": "carousel",
  "function": "slideshow",
  "initial": "slide-0",
  "status": "captured",
  "slideshow": {
    "initial": 0,
    "frames": [
      {"id": "slide-0", "html": "<div>…</div>", "media": [{"asset": "https://example.com/photo.jpg"}]}
    ],
    "navigation": [{"mode": "arrows"}, {"mode": "swipe"}],
    "views": [{"width": 390, "framesPerView": 1}],
    "slots": ["#frame-0"],
    "active": 0,
    "next": "#next",
    "previous": "#previous"
  }
}
```

* `initial` is read before component exploration. Exploring must not replace the
  route's initial document. `active` is an exploration coordinate, not initial state.
* Frames are source slots in DOM order, not unique URLs. Deliberate image repeats
  remain separate frames; explicitly marked infinite-loop clones are excluded.
* `media[].asset` references `asset-evidence.json`'s `assets[].id` (the absolute
  source URL). The record supplies retrieval, inclusion and portable path outcomes.
  Lazy images are admitted only after the source exposes decoded, non-placeholder
  media. Unresolved slots leave the component `partial`.
* `navigation` includes only modes that changed observed selection: `arrows`,
  `dots`, `keyboard`, `swipe`, or `autoplay`. Autoplay requires two passive advances;
  `intervalMs` is their observed interval, sampled at 250ms. Absence means unknown,
  not proof the source lacks that mode. Passive observation is bounded to 3 seconds.
* `views` records the count of majority-visible frames at each captured width.
  It does not infer uncaptured breakpoints. Navigation and views merge across
  viewport captures. `slots`, `next`, and `previous` are source selectors, not
  destination wiring instructions.
* `states` and `transitions` retain the v2 component shape. Actions can be `click`,
  `keyboard`, or `swipe`; non-click actions are observations, not portable replay.

Detection uses slide ARIA or a rendered multi-slot track with paired directional
controls, including unnamed SVG direction metadata. Text-only ARIA carousels keep
the existing generic component exploration. Single-stage/lightbox galleries keep
the existing gallery evidence path. Generic popup probing excludes the slideshow
subtree, so a neighboring real dialog remains independently capturable.

This producer slice supersedes draft #842's translated-gallery approach. Remaining
slices under Static Site Importer #2442 include editable slideshow materialization,
function ownership/handoffs for other widgets and forms, and destination runtime
readiness. Refs Automattic/static-site-importer#2442 and #1034.
