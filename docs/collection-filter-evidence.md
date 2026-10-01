# Source-backed collection filters

`typed-search` interaction states describe a bounded, observed local collection
filter. Search-shaped fields are candidates only; their placeholders do not define
the predicate or identify the target.

The current recognizer uses a complete `selectable-set` whose snapshots identify
one shared collection. Each direct child is identified by its complete normalized
text, including hydrated disclosure content. Duplicate headings with different
answers remain distinct. Ambiguous identical full texts are unsupported.

## Confirmation

For each category, the source is driven with an empty query, three discriminating
text tokens, an uppercase token, and a no-match query. Ordered source results must
agree with case-insensitive inclusion over normalized item text AND the observed
category membership. Matching the heading alone is insufficient when the observed
answer-only token matches the source. Fetch/XHR requests are blocked during the
drive to prove that results do not depend on newly fetched data. The blocked
request count is recorded; background telemetry is not mistaken for a dependency.
Route changes leave local replay unsupported. This is bounded evidence, not an exhaustive proof over
every possible string.

The source is restored through its real input and category controls. Restoration
is checked against complete item identities, not question labels. Source-mounted
empty-state markup is retained whether it appears inside the collection or as a
new sibling after it. Active and inactive control markup is observed per category;
paint is never inferred from vendor class names.

Limits: two fields, 100 items, 120 seconds per field, 512 KiB serialized evidence.
Empty collections, nonempty initial queries, incomplete category snapshots, and
unproven relationships produce explicit unsupported records. Standalone search
fields without a confirmed selectable collection remain unsupported by this
recognizer.

## Contract

`collectionFilter` carries:

- `field`: stable selector and original value.
- `target`: collection selector and restored source HTML.
- `items`: stable keys, normalized full text, source HTML and observed category
  indices. Each item has one canonical authoring identity.
- `categories`: selector, label, index and separately observed `activeHtml` and
  `inactiveHtml` for that control.
- `initialCategory` and the verified `normalized-text-includes` predicate.
- `emptyHtml` and `emptyPlacement` (`inside` or `after`).
- `probes`: query, category index and ordered item keys for every tested drive.
- `replay`, `restoration`, and an unsupported `reason` where applicable.
- `network`: the data-request isolation policy and number of blocked requests.

Only `status: captured`, `replay: verified`, `restoration: verified` records are
eligible for portable replay or destination projection. Consumers should retain
these checks and build on native editable content rather than snapshot copies.

## Portable output

The exporter annotates the already localized baseline collection. It does not
replace items with raw source HTML or duplicate them for categories. Delegated
input/click handlers filter the canonical items in place; text is read from the
current authoring tree so an edited answer remains searchable. The source's
observed active/inactive presentation and empty-state markup are replayed locally.
Disclosure handlers remain delegated and work after category/query changes.

Neutral browser regressions cover duplicate headings, answer-only search,
case-insensitive queries, category/query composition, edited answers, source
restoration, external empty-state mounting and rejection of data-fetching drives.
