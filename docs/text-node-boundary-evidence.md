# Adjacent text-node serialization evidence

## Browser contract

Runtime applications can append several adjacent `Text` nodes to one inline
formatting context. `outerHTML` concatenates their contents. Parsing that HTML
creates one text node, losing the original shaping runs. Chromium can then paint
different glyph pixels and return different fractional word advances despite
identical text, computed typography, and containing element rectangles.

Capture temporarily inserts empty comments between adjacent text nodes while
serializing. The HTML parser retains those boundaries. Comments add neither a
text character nor a styled element. The source nodes remain intact and the
temporary comments are removed in the serialization transaction's `finally`.
Raw-text and RCDATA elements are excluded: a comment would become literal
content in, for example, a textarea or script.

Frozen sanitization retains only exact empty comments (`<!---->`), stripping all
comment payloads. Skill-facing sanitization continues to strip all comments by
default.

## Neutral regression

The browser regression constructs three adjacent text nodes without an
application framework, captures them, and independently compares the live and
reparsed screenshots at 390, 768, and 1440px. It also verifies text-node contents,
source restoration, raw-text handling, and frozen sanitization. The predecessor
fails the screenshot assertion.

```sh
npx vitest run src/lib/screenshot/screenshotter-serialization.test.ts \
  src/lib/screenshot/screenshotter.test.ts src/lib/screenshot/freeze.test.ts \
  src/lib/streaming/html-sanitize.test.ts src/lib/screenshot/dom-capture.test.ts
npm run build
npm run test:package
```

## Actual source verification

Public source: https://ward-behavior-path.base44.app/faq

The desktop copyright paragraph has three adjacent text nodes, with no comments:
`"© "`, `"2026"`, and `" Ward Behavioral Consulting Group. All rights reserved."`.
Calling `normalize()` on this live paragraph reproduces exactly 103 changed
pixels. Re-parsing the three runs separated by empty comments changes zero
pixels. This is a browser-observed cause, not an inference from framework markup.

A fresh FAQ/homepage producer capture was compared with the independently loaded
live source and the retained predecessor capture using full-page screenshots,
device scale 1, and exact channel equality:

| Width | Predecessor changed pixels | Fresh capture changed pixels |
| --- | ---: | ---: |
| 390 | 0 | 0 |
| 768 | 0 | 0 |
| 1440 | 103 | 0 |

The new FAQ frozen baseline also passes all three required observations with
`status: proven`, measured 3/required 3, and no pending evidence. The original
full capture was preserved. The new evidence capture deliberately covers only
FAQ and homepage; this result makes no whole-site completeness claim.
