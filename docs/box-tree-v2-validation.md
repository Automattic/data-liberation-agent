# Box-tree v2 validation (#1905)

The producer emits `blocks-engine/box-tree/v2`. The existing style vocabulary is
extended with typography, placement and background geometry longhands. Both the
serialization observation and subsequent width observations use the same observer.
No additional settle or resize is introduced.

Observations optionally contain `pseudo.before` and `pseudo.after`, with `content`,
`used_styles` and `border_box`. `none`/`normal` content and `display:none` are omitted.
Pseudo-elements do not expose a DOM bounding rectangle: their box uses computed
width/height plus padding and borders for content-box sizing, and computed left/top
**offsets**, not viewport coordinates. Unresolved `auto` values use zero; original
keywords remain in `used_styles`. This is computed geometry, not a measured glyph
or transformed screen rectangle.

## Checks run

- Focused browser/vocabulary tests: 3 files, 8 tests passed (~21 seconds).
- Failure-class guard: 4 tests passed.
- `npx tsc --noEmit`, `npm run build`, `npm run test:package`: passed.
- Generated distribution bundles restored after validation.

## Wix recapture

Command (output is cwd-local and ignored):

```sh
TMPDIR=/tmp npx tsx src/cli.ts https://sdnunca.wixsite.com/my-site-1/ \
  --output .tmp-probe/issue-1905 --route-limit 10
```

Captured 5/5 discovered routes, producing **10/10 v2 sidecars**. All ten SHA-256
`source_hash` values matched the final bytes at their `source_path`.
Discovery reported a sitemap failure after three attempts, so this does not prove
that all routes on the live site were discovered.

| Sidecar | Bytes (including trailing newline) |
| --- | ---: |
| my-site-1.json | 1778218 |
| my-site-1.mobile.json | 1554915 |
| my-site-1--about.json | 1993621 |
| my-site-1--about.mobile.json | 1556353 |
| my-site-1--accessibility-statement.json | 1900698 |
| my-site-1--accessibility-statement.mobile.json | 1473980 |
| my-site-1--privacy-policy.json | 1391738 |
| my-site-1--privacy-policy.mobile.json | 959763 |
| my-site-1--terms-and-conditions.json | 1402942 |
| my-site-1--terms-and-conditions.mobile.json | 970975 |

`compare .tmp-probe/issue-1905/sdnunca.wixsite.com-my-site-1` was also run.
It **failed**: missing `/about/index.html#case-studies` and `#about` anchors,
and image mismatches in four of six homepage identity/width cells. Both 1440px
cells passed. The default reference sample freezes only the homepage, leaving
four routes without frozen fidelity evidence. These results do not establish
full-site visual fidelity; the sidecar schema/hash acceptance above passed.

## Export sidecars carry every served width (#1943)

`website/box-tree/<route>/index.json` describes `website/<route>/index.html`, the one
document served at every width. When the route has a phone capture
(`box-tree/<slug>.mobile.json`), the sidecar declares both `desktop` and `mobile`, and
every node it keeps has an observation for each declared viewport.

- Phone and desktop captures number nodes independently, in document order, so an
  equal ID is not the same element (on sdnunca's homepage, 392 of the 536 shared IDs
  name different tags or parents). Counterparts are matched structurally: from the
  roots, matched parents align their children by tag and authored `id`.
- A desktop observation of this document at phone width, when the desktop capture has
  one, wins over the phone capture's. The phone capture's own `desktop` observation
  describes the phone document and is never merged.
- Nodes without an observation in every declared viewport are dropped, and `children`
  point to the nearest kept descendants.
- Assembled pages (`mobile:`/`middle:` identities in width-selected wrappers) declare
  `mobile` too, but no node there has a phone observation of that page, so they are
  left unobserved.
- Phone-only fragments grafted into a single served document
  (`data-blocks-engine-capture-mobile-only` outside any width-selected wrapper) carry
  the phone capture's IDs, so they are namespaced `mobile:` too. That keeps every ID
  unique, and the page still merges phone observations onto its desktop nodes.
- Routes without a phone capture keep their declared viewports.
