# Consent banner fact

`website/consent-banner.json` records source consent intent before dismissal. It is
site-level evidence, not page markup or a destination implementation. Consumers
remove it from compile input, like `source-findings.json`.

The fixed contract is `static-site-importer/consent-banner/v1` ([consumer
specification](https://github.com/Automattic/static-site-importer/issues/2522)):

```json
{
  "schema": "static-site-importer/consent-banner/v1",
  "text": "This website uses cookies for analytics.",
  "accept_label": "Accept",
  "policy_link": { "label": "Privacy policy", "href": "https://example.org/privacy" },
  "position": "bottom",
  "colors": {
    "background": "rgb(34, 34, 34)",
    "text": "rgb(255, 255, 255)",
    "button_background": "rgb(153, 153, 153)",
    "button_text": "rgb(255, 255, 255)"
  },
  "source_selector": "div.cc-window.cc-banner"
}
```

Only `text` and `accept_label` are required payload fields. `reject_label` is
optional when a reject control is observed. `text` is rendered notice prose,
without controls, policy-link labels, or hidden text. Policy hrefs are absolute
HTTP(S) URLs; colors are computed CSS colors. Position is `top`, `bottom`, or
`center`, determined from the banner's viewport geometry.

Capture recognizes generic consent signals, including `cc-window` / `cc-banner`,
independently of takeover scoring. The first captured banner with readable text
and an accept control wins; later different facts generate
`consent_banner_differs` in capture diagnostics and the source findings ledger.
Selector-only differences do not constitute a different banner. No observed
usable consent fact means no file; a new export cannot retain a previous fact.
Dismissed consent DOM is still removed from portable pages. Promo takeovers are
not consent facts.
