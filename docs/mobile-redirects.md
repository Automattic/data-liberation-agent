# Mobile redirect evidence

Capture recognizes an inline top-level `if` that compares `screen.width`,
`window.innerWidth`, or `innerWidth` with a numeric literal and assigns a literal
URL to `document.location`, `window.location`, `location`, or their `href`.
The condition must select the captured width but not the desktop width (1440).
The branch must contain only that assignment and have no `else`.

For a same-site target, capture holds only that assignment before execution,
leaving the source document available for mobile HTML and box-tree observation.
Scheme and www/bare aliases are normalized to the source origin. The target
remains an ordinary route; this does not substitute its markup into the source.

Each profile records `source_mobile_redirect` with structured `mobileRedirect`
evidence: source, canonical target, viewport, inline script and condition, and
`held: true`. Export carries the relation into `source-profile.json` under
`mobileRedirects` and the classified diagnostic into `diagnostics.json`. A
consumer can represent “mobile visitors see target” without guessing from the
held source markup. Portable HTML does not execute the original redirect.

Unknown script shapes are not inferred or suppressed. Cross-site assignments
and unconditional navigation retain the existing main-frame navigation policy.
The conservative syntax boundary avoids treating an unrelated script containing
both a width check and an unconditional navigation as a mobile redirect.

The shared navigation path first checks for width and location identifiers before
building a second DOM, and applies the same check before parsing each inline
script. Ordinary documents bypass this analysis; the lexical check never itself
classifies a redirect. This keeps the redirect feature from adding full-document
parsing and application-bundle parsing to every capture and browser probe.
