# #968: duplicate page islands

## Evidence and cause

The immutable provider `source` HTML for
`website/en/seguridad-en-aplicaciones-web-i/index.html` contains two page-bearing
islands. Parsing their attributes (rather than matching tags with a regex, since
`props` includes quoted HTML) shows **identical attributes**:

- `uid="24WllM"`, `prefix="s1"`, `client="load"`, `await-children=""`;
- no `ssr` attribute on either island;
- identical component URL, export, renderer URL and `opts`;
- identical decoded `props` (SHA-256
  `e19fb8a5f4339d63b6beff69ef554147dea8df279abaa6cb8215516f5fad7d46`).

The difference that explains their visibility is **outside** the islands. Their
ancestors are `data-blocks-engine-capture-desktop-document` and
`data-blocks-engine-capture-mobile-document`, respectively. The saved stylesheet
hides the mobile wrapper by default and switches to it at `max-width:1224px`.
Thus the second copy is not an Astro-created, never-displayed hydration clone:
it is DLA's viewport alternative, deliberately hidden at desktop width. The
normal `vulseek-pricing` evidence has one page and no such dual wrapper pair.

The desktop and mobile subtrees differ in framework comments, two hidden tracking
images and three URL spellings:

| Desktop | Mobile |
| --- | --- |
| `https://ctf.securetia.com/` | `https://ctf.securetia.com` |
| `http://asp.net/` | `http://ASP.net` |
| `http://www.owasp.org/` | `http://www.owasp.org` |

These differences resemble a resolved anchor `.href` being written back during
hydration. The provider contains final output, not the original capture-session
DOMs, so it cannot establish which source script wrote an attribute. It does
establish which DLA step created the copy: only responsive assembly emits these
wrappers. `resolveResponsivePair` compares `responsiveBodySignature`, which
already ignores comments and images but retained `href` bytes literally. These
URL spellings caused false structural inequality; `assembleResponsiveHtml` then
wrapped and shipped both full documents. Portable route rewriting happens later
and cannot undo that decision.

Reconstructing two documents from the evidence wrappers reproduced
`dual-structural` with the old comparison. Changing only those three URL
spellings made the old comparison report equality. With the fix, the unmodified
extracted pair reports `collapsed-equivalent`, one variant. Live server HTML
fetched during investigation had one `.page`, including the mobile-column URL
spellings above. Fresh automatic captures of both the route and the site root
also emitted one page; those runs selected reflow-only for this route, so did not
exercise the historical dual-pair failure.

## Fix and regression

Canonicalize fully qualified HTTP(S) `href` and `action` values **only in the
private structural signature**, using URL serialization. Do not rewrite source
markup, discard hidden nodes, or add island/platform selectors. Relative and
scheme-relative references remain literal because comparison has no document
base; path case, non-root trailing slashes, queries and fragments remain distinct.
Real structural differences and binding phone body-class gates still retain
both documents.

The minimal Vitest fixture reproduces the observed mechanism: two independently
captured documents with one island each, identical state, and equivalent link
spellings. Before the fix it produces two full pages with a hidden mobile
wrapper; after it produces one. An export regression checks the final page and
receipt as well. Closed menus, dialogs and hidden tabs survive. A client script
appending a hidden clone would reproduce a different mechanism than this
evidence, and removing that clone by visibility would not fix the actual bug.
The focused tests are pure assembly/export tests (no additional browser pass).
