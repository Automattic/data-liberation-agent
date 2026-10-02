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

Blocked confirmation is not a finite bootstrap. A collection that issues a
query-independent data response before filtering locally uses the versioned
contract below. Replaying previously observed response bodies is
`intercepted-observed-responses`, never `all-requests-blocked`. Completeness is
not inferred from response length. Query-dependent, paginated, undeclared,
ambiguous, and unrestored drives stay unsupported.

Candidate inputs are association-bounded. A text field inside a form that does
not contain the collection does not consume the field cap, even when it precedes
the collection in document order.

## Contract

`collectionFilter` carries:

- `field`: stable selector and original value.
- `target`: collection selector and restored source HTML.
- `items`: stable keys, normalized full text, source HTML and observed category
  indices. Each item has one canonical authoring identity.
- `itemDepth`: how many single-element wrappers sit between `target` and the
  repeated item children. `0` means the target's own element children are the
  items. Consumers descend that many only-child wrappers before matching items.
  Missing `itemDepth` means `0`.
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

Ward records keep `mode: category-and-query`, `network.dataRequests: blocked`,
and `network.verification: all-requests-blocked`. Every item belongs to
`initialCategory` is not required by the producer for the alternate mode below;
the existing consumer verifier must keep requiring it unless `finiteBootstrap`
is present and passes every check in that contract.

## Finite bootstrap contract

Schema: `data-liberation/finite-bootstrap/v1`.

Portable only when the source itself issued a query-independent response, that
response declared `hasNext: false` with `count` equal to a sibling array of
records, later probes were verified by replaying those exact observed bodies,
and an unmatched Fetch/XHR was blocked. Category controls hide during a nonempty
query. An empty query restores the selected category and its controls. This is
not category-and-query intersection.

Exact fixture fields:

```json
{
  "schema": "data-liberation/finite-bootstrap/v1",
  "mode": "category-or-global-search",
  "queryIndependent": true,
  "completeness": "declared-finite",
  "declaredCount": 4,
  "observedItemCount": 4,
  "coverage": "complete",
  "verification": "intercepted-observed-responses",
  "replayedResponses": 1,
  "blockedFollowUps": 1,
  "sourceFollowUpsBlocked": 0,
  "unmatchedProbeBlocked": true,
  "categoryControlsDuringSearch": "hidden",
  "emptyQueryRestoresCategory": true,
  "answers": "observed",
  "answerOnly": "verified",
  "probes": {
    "global": [{ "query": "apricot", "keys": ["0"] }],
    "categories": [{ "category": 0, "keys": ["0", "1"] }]
  }
}
```

The parent `collectionFilter` must also carry `replay: verified`,
`restoration: verified`, `predicate: normalized-text-includes`,
`mode: category-or-global-search`, `network.dataRequests: observed-response-replay`,
and `network.verification: intercepted-observed-responses`. `items` is the full
observed universe, including entries outside `initialCategory`. Legacy `probes`
are empty-query category membership only. Global search probes live in
`finiteBootstrap.probes.global` and are a set match against normalized item text,
in source-observed order, not category-union order.

Native collection projection (blocks-engine #2417) must keep rejecting a record
whose `network.dataRequests` is `blocked` unless the existing Ward verifier
passes. It may project this mode only when `finiteBootstrap.schema` is
`data-liberation/finite-bootstrap/v1` and every field above matches, including
`declaredCount === items.length`. Global search filters every item and hides
category controls. Empty query shows `initialCategory` membership. Do not
recompute `finiteBootstrap.probes.global` as a category intersection. Reject
`query-dependent`, `incomplete`, paginated responses, undeclared completeness,
ambiguous identities, and unverified restoration.

`answers: pending-disclosure-integration` means `hydrateDisclosureContent` did
not leave answer text inside an expanded control. Portable search then covers
observed item text only. Populated disclosure panels and ancestor concealment
stay with the existing local disclosure runtime; this producer does not duplicate
that script. Integration of answer text into the serialized tree is pending
until that companion leaves the text in each item before this snapshot.

The portable exporter appends observed item HTML that was not in the resting
category so one authoring tree holds the universe. It does not keep a remote
runtime. Global-search order in that tree is category-union order.

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
