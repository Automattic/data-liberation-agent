# Source-owned document selection

An adapter can declare `liberation.documentSelection(documents)` after examining
the raw captured documents. It returns a `DocumentSelection`, or nothing when
the source selection mechanism is not established. The generic exporter never
contains a vendor UA rule.

`kind: 'device'` supplies an ordered, serializable set of user-agent regular
expressions, a default document key, all supported document identities and public
provenance describing the classifier's coverage. Rules use only the request UA;
viewport width, pointer and hover capabilities are not substitutes. This is a
bounded platform translation, not evidence that the source's private server
classifier has been recovered. Adapters must test the translation against public
responses for every identity they claim.

The existing desktop and mobile HTML inputs remain available as `desktop` and
`mobile`. `liberation.additionalProfiles(primaryHtml)` declares additional
`CaptureProfile` recipes from the acquired primary document. Recipes carry a safe
identity key, dimensions, an optional Playwright device name or context overrides,
and optional reference widths. Device names are resolved lazily through the public
Playwright device map; the generic capture path contains no tablet UA or Wix rule.

The same settled-page capture and shared resource store acquire each profile, with
isolated HTML/geometry/image paths and per-profile interaction metadata. Legacy
desktop/mobile section and design sidecars are not overwritten by an additional
profile. The screenshot manifest records actual browser flags, UA, pixel density,
recipe and artifacts in `profiles`. Additional HTML paths are owned by
`profiles[id].html`, for example `profiles.tablet.html: 'html-tablet/page.html'`.
`documents[id]` records only the browser document URL and effective base as
`{ url, baseUrl }`, for baseline and additional profiles alike; the profile's
`documentUrl` retains the same URL/base context. HTML paths are confined
to the capture directory. A declared but absent document is recorded in the
receipt and source profile, makes capture incomplete, and displays an unavailable
identity message instead of rendering another device's tree.

The portable file embeds all available trees and their original viewport metadata.
DLA-owned synchronous classic scripts are inserted after source-script sanitization:

1. The export declares exactly one viewport META and the complete visibility CSS
   for the available identity keys. The beginning-of-head selector overlays
   source-owned root attributes and updates only the existing viewport node's
   selected attributes before body parsing. It constructs/appends no META, STYLE
   or asset nodes. Unavailable identities have no viewport content or visible
   source tree, rather than using the default identity's head.
2. Synchronous parser scripts emit only that identity's active style/link media,
   preserving authored media queries and native render-blocking stylesheet loading.
   Merely activating a `media="not all"` link at the end of head allowed Chromium
   to paint fallback typography; the regression records first-frame linked CSS.
   Inert originals stay available to the existing resource localization pass.
   Inline CSS reuses the zero-specificity scoper;
   root-only rules also apply to the actual roots, because a `display:contents`
   document wrapper cannot carry the body's margin or viewport overflow.
3. The beginning of the body restores that document's body flags before content
   parsing. Attribute-gated visibility keeps the other trees out of layout.

## Hosting and document-scope handoff

Every emitted device-profile wrapper carries the generic presence marker
`data-dla-document-scope` alongside `data-dla-device-document="<identity>"`.
Captured tokens, IDs and motion bindings may repeat across independent profile
documents. A consumer must resolve a binding inside its nearest declared scope,
not through a global first-match lookup. A device contract with one available
document still emits one boundary. An ordinary unwrapped single document remains
one document; consumers can use their normal document-root fallback.

The synchronous root scripts are ownership overlays, not root replacements.
For each of `html` and `body`, the captured roots define the union of source-owned
class tokens and inline style properties. The overlay removes only that union,
then applies the selected source tokens and values, including CSS priorities.
Unrecognized hosting-runtime classes and properties remain intact. CSSOM parsing
preserves custom-property case and shorthand semantics; source-owned `lang`/`dir`
attributes follow the same selected-root ownership. No destination-specific names
or hosting-platform heuristics participate in this contract.

Stylesheet `media="not all"` on an inert serialized node is runtime activation
state, **not an authored source media condition**. `data-dla-source-media` retains
the original source media list (or `all` when absent) on both inert nodes and the
parser-emitted active copies. Destination converters and stylesheet analyzers
must preserve this provenance and use it for authored-media analysis instead of
inferring source facts from the inert `media` attribute. They must separately
carry the document identity/scope and pre-layout selector/viewport semantics.
These are handoff requirements, not proof that any particular destination has
implemented them. Conversion, host-root coexistence and combined scoped motion
acceptance remain independent downstream gates.

All stylesheet URLs are present on declared serialized LINK nodes and normal
CSS URL/import declarations. The parser-time stylesheet emitter reads the selected
declared node, preserves its already-localized href/content and authored media,
and emits that same node at its source head position. It computes no URL, creates
no script asset, imports no module and chooses no asset from a runtime URL string.
Changing a declared LINK href during relocation therefore changes the emitted
active LINK as well. Consumers must preserve this head ordering and static-node
provenance; an inert LINK is not an unknown runtime-created asset.

The META is also a declared head target required by the selector. A compiler's
runtime DOM-parity check must account for document-head targets carried by its
head metadata/materialization contract rather than only generated body blocks.
This requirement does not exempt DLA scripts from asset or DOM proof. A missing
head target remains a conversion blocker until the owning head contract preserves
and proves it.

No routing server, provider runtime, deferred hydration, or viewport resize is
required. Selection remains constant on resize. With JavaScript disabled this
device-selected representation is unavailable; it does not claim server-rendered
no-JavaScript parity.

`kind: 'width'` carries an observed same-profile transition's `switchWidth` and
evidence. It uses the existing responsive CSS assembly. A separate canvas floor
or unrelated stylesheet boundary cannot override this declaration. Undeclared
legacy captures retain their existing assembly and do not gain a claim of measured
device selection.

## Classic Wix coverage

The Wix hook activates only for a captured `wixDesktopViewport` and a classic
`wixMobileViewport` / `device-mobile-optimized` pair, not responsive Wix Studio.
The public responses establish Desktop, Smartphone and Tablet identities. The
adapter's UA translation is bounded to conventional desktop, iPhone/iPod,
Android phone/tablet, iPad and the declared legacy phone families. It is not
Wix image-kit's `max-width:767px` image-fitting helper.

Ordinary sources retain meaningful desktop and iPhone defaults. The Wix adapter
declares a real iPad capture for classic sites and requests 390/768/1440 reference
widths under each identity. The tablet HTML is captured from that browser context,
not made from the desktop tree with a substituted viewport.

## Identity-aware frozen evidence

Required cells are declared before navigation. `scope.cells` names each source
URL, profile, viewport and state independently; a failed navigation remains a
required pending cell. Every profile/width freezes a fresh source navigation in
the original browser context, before fluid rewriting. Document, observation and
screenshot filenames include the profile identity so same-width evidence cannot
overwrite another device's artifacts.

Frozen comparison defaults to all declared cells and replays each cell's browser
identity. The public replay whitelist includes UA, density, mobile/touch flags,
locale, timezone, color scheme, reduced motion and optional `screen` dimensions.
Capture passes the resolved construction identity (including device-preset values),
not just unresolved recipe overrides. Stored recipes, identity metadata and replay
options never contain storage state, cookies, headers, HTTP credentials or other
transport/authentication fields.

An explicit preset screen is independent of the requested viewport.
`Page.setViewportSize()` resets screen dimensions even inside a preset-screen
context. Reference collection therefore constructs a fresh context at the target
viewport when screen is explicit, retaining the resolved screen. Source session
state may be reused in memory for those source navigations but is not serialized
as replay identity. Profiles without a fixed screen retain meaningful
viewport-derived screen defaults. Programmatic callers may select `profiles` and `widths`; CLI callers may
use `compare <directory> --profiles tablet` (or comma-separated identities). MCP
accepts the same `profiles` array. Profile selection is frozen-only: it is not an
unobserved live-source emulation heuristic. Reports and evidence paths include the
profile, and coverage counts required/measured/pending cells per profile.
Device-selected routes also compare the source-selected viewport directives,
without relaxing geometry, typography, image or animation gates. A fixed-width
tree must not conceal a substituted viewport head.

Existing width-only reference fixtures keep their width-only lookup when they
have no declared cells. New ordinary-source references preserve the prior default
desktop cells at 768/1440 and mobile cell at 390. Explicit out-of-scope widths,
unknown profiles, unsupported states and ambiguous evidence remain unproven.

Neutral Chromium tests serve the actual exported directory through an ordinary
static server, compare native viewport/typography/geometry against UA-selected
source responses at identical widths, record the first animation frames, resize
without changing device identity, exercise a coarse-pointer desktop UA, and
exercise a same-profile 800px source transition with an unrelated 980px floor.

The capture-to-comparison fixture additionally acquires all three real source
responses, verifies six independent same-width cells through static hosting,
filters tablet capture/materialization acceptance, and proves that a failed
tablet acquisition leaves required coverage intact. Identity and cell coverage
are evidence of acquisition/routing, not a claim of complete site fidelity.
