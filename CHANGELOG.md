# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Releases are cut with [Homeboy](https://github.com/Automattic/homeboy),
configured in `homeboy.json`: it is the single source of truth for which
files carry a `version` field (`package.json`, `.claude-plugin/plugin.json`,
`.codex-plugin/plugin.json`, `gemini-extension.json`), bumps all of them
atomically from one release operation, generates this file's entries from
merged PRs, and its `post:release` hook regenerates the committed `dist/`
MCP bundles so a release can never ship manifests and bundles that disagree.

Homeboy does not backfill history: the `0.2.1` and `0.2.2` entries below
predate Homeboy adoption and were written by hand from their tag messages.
Everything from the next release onward is Homeboy-generated.

## [0.33.178] - 2026-11-08

### Changed
- regenerate plugin bundles
- Responsive assembly: keep authored fragment links route-independent; resolve the visible device copy via responsive-fragment

### Fixed
- key srcset fixtures by resolved references, not the route URL

## [0.33.177] - 2026-11-08

### Changed
- regenerate plugin bundles
- Sweep source cleanup in the serializing task and match the minimized Wix assistant

## [0.33.176] - 2026-11-08

### Changed
- regenerate plugin bundles
- Keep the desktop document when only phones are redirected to a separate mobile site
- Explain when a security service blocks the source homepage
- Do not treat Cloudflare's /cdn-cgi/ path as a page
- Google Sites: capture a full-page embed's authored document
- cook candidate

### Fixed
- let author html/body styles win over the dual-assembly reset
- skip pointer-inert fixed layers in overlay dismissal
- name captured dialog markup after its page document
- shape a literal assigned to a window global as data
- read a shadow-hosted consent banner without the entrance wait

## [0.33.175] - 2026-11-08

### Changed
- regenerate plugin bundles
- Wait for a load-delayed iframe reveal before freezing the phone capture
- Omit unmatched runtime-injected stylesheets

## [0.33.174] - 2026-11-08

### Changed
- regenerate plugin bundles

### Fixed
- reuse shared chrome copied under renamed ids

## [0.33.173] - 2026-11-08

### Changed
- regenerate plugin bundles
- Give the phone document its own SVG resource IDs
- Keep SVG fragment references local when a base names another URL
- Keep fitted regimes for a positioned frame's varying dimensions
- resolve phone-menu anchors across menu re-render and close non-dialog menus
- Coalesce identical device stylesheets when the captured DOM proves reordering preserves the cascade

### Fixed
- Do not hold source readiness on src-less images and name pending ones

## [0.33.172] - 2026-11-08

### Changed
- regenerate plugin bundles
- Bound viewport class probing and selectable drives within the route budget

## [0.33.171] - 2026-11-08

### Changed
- regenerate plugin bundles
- probe each responsive image once per capture

## [0.33.170] - 2026-11-08

### Changed
- regenerate plugin bundles
- cook candidate
- Capture Carrd section routes as separate pages (fixes #1512)
- reuse srcset probe context and resolved fixtures across routes
- memoize viewport class toggles across routes
- skip learning content-derived min-height
- Settle script-driven entrance motion before serialization

## [0.33.169] - 2026-11-08

### Changed
- regenerate plugin bundles
- Keep desktop interaction evidence when a dual route's phone pass reuses its ids
- Identify Wix slides by component and bound slideshow control waits
- Template clusters: derive link targets from derived and late-captured pages
- Template clusters: derive members from the phone document too
- Prioritize client-rendered entry navigation under explicit route limits
- cook candidate
- Serialize runtime sheets as loaded at the capture width

## [0.33.168] - 2026-11-07

### Changed
- regenerate plugin bundles
- Drop runtime-fitted type sizes the authored cascade reproduces

## [0.33.167] - 2026-11-07

### Changed
- regenerate plugin bundles

### Fixed
- deduplicate redirect targets by route identity

## [0.33.166] - 2026-11-07

### Changed
- regenerate plugin bundles
- Compare layout geometry: page height, text positions and background boxes

## [0.33.165] - 2026-11-07

### Changed
- regenerate plugin bundles
- Carry phone-probe selectors onto the desktop document's nodes
- Preserve learned fluid geometry across viewport class capture
- Lower scripted same-origin links (role=link without href) to portable anchors

## [0.33.164] - 2026-11-07

### Changed
- regenerate plugin bundles
- Capture consent banner title, resting edge geometry and stretched controls
- Template clusters: fingerprint the whole inventory
- Template clusters: pair head slots within the head
- Read multi-level consent dialogs as their message and accept-all control

### Fixed
- canonicalize percent-encoded discovery route identity

## [0.33.163] - 2026-11-07

### Changed
- regenerate plugin bundles
- Read an SVG's declared size from its real root, not a commented-out tag
- Preserve viewport entrance startup contexts when device documents collapse

### Fixed
- Fix template-cluster derivation for budget-omitted frontier routes

## [0.33.162] - 2026-11-07

### Changed
- regenerate plugin bundles
- Transplant responsive image attributes and verify srcsets in template derivation
- Derive budget-omitted template members: capture state comes from the manifest
- Verify plain-text document assets from bytes
- Keep displayed renditions when linked originals exceed portable limits
- Keep fitted regimes for a scaled frame's varying inline dimensions

## [0.33.161] - 2026-11-07

### Changed
- regenerate plugin bundles

### Fixed
- Fix tablet viewport-entrance startup reference contexts
- Fix tracking-image cleanup of inert data and blob placeholders

## [0.33.160] - 2026-11-07

### Changed
- regenerate plugin bundles
- Localize lazy image attributes and completed product JSON-LD images

## [0.33.159] - 2026-11-07

### Changed
- regenerate plugin bundles
- Account for source requests and reuse fetched documents during capture
- Record consent banner text color from the message, not its container

## [0.33.158] - 2026-11-07

### Changed
- regenerate plugin bundles
- Attribute source runtime errors to their frame through CDP execution contexts
- Capture cleanup: remove invisible few-pixel tracking images
- Derive template members when only volatile classes differ
- Settle each width before classifying a resting panel
- cook candidate

### Fixed
- Fix language-neutral consent control classification

## [0.33.157] - 2026-11-06

### Changed
- regenerate plugin bundles
- treat terminal HTTP errors on source images as settled source state
- Keep each exported document's painted image rendition

## [0.33.156] - 2026-11-06

### Changed
- regenerate plugin bundles

### Fixed
- Fix bottom-clamped Wix fragment-anchor landings

## [0.33.155] - 2026-11-06

### Changed
- regenerate plugin bundles
- restate video poster fit relative to its embed
- Treat iframe overlays as content, not loading covers
- Fit breakpoint scale regimes as segmented rules and sample their widths
- freeze autoplay galleries at their first slide

## [0.33.154] - 2026-11-06

### Changed
- regenerate plugin bundles
- Carry script-toggled class state at the widths the source applied it

## [0.33.153] - 2026-11-06

### Changed
- regenerate plugin bundles
- restate slideshow image fit relative to its slide

## [0.33.152] - 2026-11-06

### Changed
- regenerate plugin bundles
- Localize captured consent-banner policy links

## [0.33.151] - 2026-11-06

### Changed
- regenerate plugin bundles
- Hold scroll-state probe offsets against scroll anchoring

## [0.33.150] - 2026-11-06

### Changed
- regenerate plugin bundles
- restate slideshow caption geometry relative to its slide
- Leave class-derived scroll-state geometry to the toggled class
- Scroll-state capture probes exact positions on smooth-scrolling pages

### Fixed
- Fix cross-origin runtime widget removal for same-site services
- ignore CSS comments when matching shorthand var() repair source rules

## [0.33.149] - 2026-11-06

### Changed
- regenerate plugin bundles
- Measure an image's painted content box in fidelity checks

## [0.33.148] - 2026-11-06

### Changed
- regenerate plugin bundles
- Measure compare image geometry and typography at the resting authored pose

## [0.33.147] - 2026-11-06

### Changed
- regenerate plugin bundles
- Prioritize client-rendered entry navigation under capture time budgets
- settle in-flight source images before freezing the reference
- Bound runtime custom-property regimes that switch between px and non-px values

### Fixed
- Fix blank routes caused by incomplete dual-device captures
- Fix breakpoint-dependent fluid transform scales and stabilize gate tests

## [0.33.146] - 2026-11-06

### Changed
- regenerate plugin bundles
- Learn responsive inline clip-path coordinates

## [0.33.145] - 2026-11-06

### Changed
- regenerate plugin bundles

### Fixed
- Fix hard-crop renditions claiming original image references

## [0.33.144] - 2026-11-06

### Changed
- regenerate plugin bundles
- Handle Wix custom elements without App Market scripts
- Preserve phone layout ancestry during identity-subset assembly

## [0.33.143] - 2026-11-06

### Changed
- regenerate plugin bundles
- Detect viewport-dependent runtime style rules during phone checks
- Classify source runtime errors using independent readiness evidence

## [0.33.142] - 2026-11-06

### Changed
- regenerate plugin bundles
- Keep width-hidden menu toggles and wire captured dialogs to the labelled control
- Preserve image layout boxes marked with popup behavior tokens

### Fixed
- Fix widest-image comparison for CSS background heroes

## [0.33.141] - 2026-11-06

### Changed
- regenerate plugin bundles
- Preserve sampled transform origins with learned scales
- Switch responsive documents at the source's own min-width boundary and report an uncaptured middle layout
- Exclude consent overlays from device structure comparison
- Skip unrendered regions in collection probing
- Wait for source exit beacon in fidelity test
- Read block-flow consent cards with spaced text and stacked layout
- Limit captured font assets to stored capture evidence

### Fixed
- accept captures with their entrypoint

## [0.33.140] - 2026-11-06

### Changed
- regenerate plugin bundles
- Treat a pinned fixed sidebar as a resting inline panel

## [0.33.139] - 2026-11-06

### Changed
- regenerate plugin bundles

### Fixed
- export resting-visible disclosure lists without opened state

## [0.33.138] - 2026-11-05

### Changed
- regenerate plugin bundles
- Learn responsive scales absent at the reference width

## [0.33.137] - 2026-11-05

### Changed
- regenerate plugin bundles
- Climb a controlled panel only through wrappers its activation revealed (fixes #1371)

## [0.33.136] - 2026-11-05

### Changed
- regenerate plugin bundles
- Verify fidelity gate passes for #1347
- Recognize Wix password gates during capture
- Replace Wix App Market custom elements with unported-embed notes
- Port Wix gallery slideshows out of wix-iframe hosts
- Freeze the load-time Wix header class after capture scrolling
- Score lazy-rail image readiness against visible, comparable evidence
- Prove reference cells whose admitted source runtime error leaves a stable document

## [0.33.135] - 2026-11-05

### Changed
- regenerate plugin bundles
- Remove the Google Sites Site actions trigger before interaction probing (fixes #1345)

## [0.33.134] - 2026-11-05

### Changed
- regenerate plugin bundles
- Keep an attested iframe's authored inline style through capture and export
- build expired fixture cert portably
- Collapse builder captures keyed by discovered identity attributes into one document

### Fixed
- bound settled-document reads

## [0.33.133] - 2026-11-05

### Changed
- regenerate plugin bundles

### Fixed
- Fix tablet document selection for UA-switched dual routes

## [0.33.132] - 2026-11-05

### Changed
- regenerate plugin bundles
- Prevent false choice groups in Wix captures

## [0.33.131] - 2026-11-05

### Changed
- regenerate plugin bundles
- Gamma toggles: put the title wrapper's hooks on the summary
- Decide route device mode on body structure, report head differences as a diagnostic
- Keep headers visible at rest when captured as disclosure panels

### Fixed
- Fix compare baseline pose restoration after callbacks

## [0.33.130] - 2026-11-05

### Changed
- regenerate plugin bundles

### Fixed
- Fix fixed-phone responsive fallback and stabilize probe test timeout

## [0.33.129] - 2026-11-05

### Changed
- regenerate plugin bundles
- Preserve Gamma toggle summary presentation

## [0.33.128] - 2026-11-05

### Changed
- regenerate plugin bundles
- Add resumable checkpoint captures for time-budgeted runs
- Keep portable media rewrite patterns page-sized
- Probe where a dual route's phone document starts instead of guessing the widest breakpoint
- Attribute source runtime errors to their frame so subframe errors no longer block readiness
- Add Google Sites detection and viewer-chrome cleanup

## [0.33.127] - 2026-11-05

### Changed
- regenerate plugin bundles

### Fixed
- Fix Wix anchor retry for headers hidden on scroll-down

## [0.33.126] - 2026-11-05

### Changed
- regenerate plugin bundles
- cook candidate

## [0.33.125] - 2026-11-05

### Changed
- regenerate plugin bundles

### Fixed
- compare replayed keyframe bindings independent of property order

## [0.33.124] - 2026-11-05

### Changed
- regenerate plugin bundles
- Remove Wix pinned chat overlays during source cleanup

## [0.33.123] - 2026-11-05

### Changed
- regenerate plugin bundles
- Share counterpart stylesheet rules in responsive assembly
- Restore unhydrated Wix image sources

### Fixed
- Fix Wix top-of-page fragment capture from fixed chrome

## [0.33.122] - 2026-11-04

### Changed
- regenerate plugin bundles
- Keep bounded locator probe waits bounded under probe intrinsics
- Complete Squarespace product JSON-LD as ProductGroup during capture
- Recover reset and throttled subresources before capture
- Refuse routes whose page navigates to another site instead of saving its pre-redirect document

## [0.33.121] - 2026-11-04

### Changed
- regenerate plugin bundles
- Stop capture early when a source persistently refuses this client
- Apply detected host residue during capture cleanup

### Fixed
- Fix visual-iframe evidence for srcdoc frames

## [0.33.120] - 2026-11-04

### Changed
- regenerate plugin bundles

### Fixed
- keep repeated Set-Cookie headers when governing source responses

## [0.33.119] - 2026-11-04

### Changed
- regenerate plugin bundles
- Localize absolute same-origin SVG <use> sprite references to the captured sprite
- turn toggles into native details so they open in the copy

### Fixed
- Fix false collection detection for article actions

## [0.33.118] - 2026-11-04

### Changed
- regenerate plugin bundles
- Preserve displayed image renditions under portable media budget pressure

## [0.33.117] - 2026-11-04

### Changed
- regenerate plugin bundles
- Bind a trigger-opened panel's own close control instead of generating one
- Govern browser source traffic and back off on transport resets

### Fixed
- match shorthand var() repair rules by canonical prelude

## [0.33.116] - 2026-11-04

### Changed
- regenerate plugin bundles
- Capture a builder navbar's plain-element phone menu on every route

## [0.33.115] - 2026-11-04

### Changed
- regenerate plugin bundles
- Capture replayable evidence for mobile search disclosures

## [0.33.114] - 2026-11-04

### Changed
- regenerate plugin bundles

### Fixed
- Fix closed dialog binding markup after correspondence collapse

## [0.33.113] - 2026-11-04

### Changed
- regenerate plugin bundles

### Fixed
- Fix phone menu adoption in correspondence-collapsed exports

## [0.33.112] - 2026-11-04

### Changed
- regenerate plugin bundles
- re-point background videos at a portable rendition instead of keeping a remote src

## [0.33.111] - 2026-11-04

### Changed
- regenerate plugin bundles
- Capture mobile-only component states at rendered viewports

## [0.33.110] - 2026-11-04

### Changed
- regenerate plugin bundles
- Consent banner capture keeps inline link labels and measures the painted panel, not the transparent wrapper

## [0.33.109] - 2026-11-04

### Changed
- regenerate plugin bundles
- Preserve fluid segment geometry when a post-learning resize suspends a segment rule

## [0.33.108] - 2026-11-04

### Changed
- regenerate plugin bundles
- Reveal end-of-page entrance elements before capture serialization

## [0.33.107] - 2026-11-04

### Changed
- regenerate plugin bundles
- Prioritize entry navigation routes under capture budgets

## [0.33.106] - 2026-11-03

### Changed
- regenerate plugin bundles
- Wait for delayed choice-group selection updates

### Fixed
- Fix exact-URL identity for exported image references

## [0.33.105] - 2026-11-03

### Changed
- regenerate plugin bundles
- Preserve learned fitted-title geometry through runtime replacements

## [0.33.104] - 2026-11-03

### Changed
- regenerate plugin bundles

### Fixed
- Fix frozen compare emoji authorization for existing captures

## [0.33.103] - 2026-11-03

### Changed
- regenerate plugin bundles
- Preserve fitted-text identity across resize replacements

## [0.33.102] - 2026-11-03

### Changed
- regenerate plugin bundles
- add an events capability, and let page count and images raise the complexity band

## [0.33.101] - 2026-11-03

### Changed
- regenerate plugin bundles

### Fixed
- Fix WordPress runtime emoji normalization in fidelity comparison

## [0.33.100] - 2026-11-03

### Changed
- regenerate plugin bundles
- Add a Gamma adapter: working section links and video embeds

## [0.33.99] - 2026-11-03

### Changed
- regenerate plugin bundles
- Fit runtime-sized image height fallbacks across every captured width
- Deduplicate trailing-slash routes across sitemap and link discovery
- Protect capture probes from source-overridden JavaScript built-ins

## [0.33.98] - 2026-11-03

### Changed
- regenerate plugin bundles
- Recover incomplete source TLS chains through bounded AIA discovery

## [0.33.97] - 2026-11-03

### Changed
- regenerate plugin bundles

### Fixed
- Fix mixed srcset exports to use truthful, unique candidates

## [0.33.96] - 2026-11-03

### Changed
- regenerate plugin bundles

### Fixed
- Fix selected srcset capture for lazy gallery thumbnails

## [0.33.95] - 2026-11-03

### Changed
- regenerate plugin bundles
- Preserve browser-selected srcset rendition files

## [0.33.94] - 2026-11-03

### Changed
- regenerate plugin bundles
- Wire repeated dialog trigger IDs by label and localize panel snapshot links

## [0.33.93] - 2026-11-03

### Changed
- regenerate plugin bundles

### Fixed
- Fix integer-stepped fluid geometry fitting

## [0.33.92] - 2026-11-03

### Changed
- regenerate plugin bundles
- Round consent banner edge offsets and padding

## [0.33.91] - 2026-11-03

### Changed
- regenerate plugin bundles
- Emit captured-interactions v3 with shared component references

## [0.33.90] - 2026-11-03

### Changed
- regenerate plugin bundles
- Adopt dropdown panels per trigger across responsive documents

## [0.33.89] - 2026-11-03

### Changed
- regenerate plugin bundles
- Capture consent banner content gaps

## [0.33.88] - 2026-11-03

### Changed
- regenerate plugin bundles
- Capture consent button borders and per-layout message margins
- Capture responsive consent banner presentation

## [0.33.87] - 2026-11-03

### Changed
- regenerate plugin bundles
- Capture consent banner presentation styles
- Capture class changes on a dialog trigger's own subtree

## [0.33.86] - 2026-11-03

### Changed
- regenerate plugin bundles
- Record quirks-mode sources on the captured root

## [0.33.85] - 2026-11-02

### Changed
- regenerate plugin bundles
- Preserve captured dialog root-class transitions

## [0.33.84] - 2026-11-02

### Changed
- regenerate plugin bundles
- Reuse proven root-class samples across matching route runtimes

## [0.33.83] - 2026-11-02

### Changed
- regenerate plugin bundles

### Fixed
- Fix slow-frame root-class contract sampling
- Fix responsive projection of negated body classes

## [0.33.82] - 2026-11-02

### Changed
- regenerate plugin bundles
- Treat scheme and www variants of the capture site as same-site links

## [0.33.81] - 2026-11-02

### Changed
- regenerate plugin bundles
- Preserve shared stylesheet links during root-class contract projection
- Decode legacy HTML using BOM, transport and meta charset declarations

### Fixed
- Fix capture bookkeeping leaking into exported interaction HTML
- capture the video player as a portable <video controls poster>

## [0.33.80] - 2026-11-02

### Changed
- regenerate plugin bundles

### Fixed
- Fix gallery root boundaries and clean failed capture markers

## [0.33.79] - 2026-11-02

### Changed
- regenerate plugin bundles

### Fixed
- Fix fallback dialog placement inside phrasing content

## [0.33.78] - 2026-11-02

### Changed
- regenerate plugin bundles
- tiered route device checks, inline-shape inheritance, constant runtime-sheet sampling

## [0.33.77] - 2026-11-02

### Changed
- regenerate plugin bundles
- Preserve measured root-class styles at intermediate widths

## [0.33.76] - 2026-11-02

### Changed
- regenerate plugin bundles
- Record dismissed consent banners as a portable consent-banner fact

## [0.33.75] - 2026-11-02

### Changed
- regenerate plugin bundles

### Fixed
- prefer declared site names in adapter discovery

## [0.33.74] - 2026-11-02

### Changed
- regenerate plugin bundles
- Strip HTTP/2 pseudo-headers before replaying the probe navigation

## [0.33.73] - 2026-11-02

### Changed
- regenerate plugin bundles
- Drop site builder default favicons from liberated sites
- Confirm site device-mode HTML differences before choosing dual

## [0.33.72] - 2026-11-02

### Changed
- regenerate plugin bundles

### Fixed
- serialize scroll-scrubbed inline styles in their in-view pose

## [0.33.71] - 2026-11-02

### Changed
- regenerate plugin bundles
- Make media writes non-clobbering with exclusive creates

### Fixed
- Fix device comparisons with matched resource policies and sub-step timings

## [0.33.70] - 2026-11-01

### Changed
- regenerate plugin bundles

### Fixed
- export dimension-limited rasters within the byte cap as real media

## [0.33.69] - 2026-11-01

### Changed
- regenerate plugin bundles
- Attribute device checks and reuse desktop capture navigation
- Stabilize shared-chrome signatures across runtime UUID IDs

## [0.33.68] - 2026-11-01

### Changed
- regenerate plugin bundles

### Fixed
- Fix overlapping source URL ownership for exported image renditions

## [0.33.67] - 2026-11-01

### Changed
- regenerate plugin bundles
- Acquire verified smaller image renditions before budget blanking

### Fixed
- Fix portable media admission to prioritize coverage before resolution

## [0.33.66] - 2026-11-01

### Changed
- regenerate plugin bundles
- Select the host's viewport meta in the device-selection runtime

## [0.33.65] - 2026-11-01

### Changed
- regenerate plugin bundles
- Preserve static open-shadow content in portable capture
- Share the source HTTP identity across media downloads and discovery
- Retry a referenced resource once after a transient fetch failure

## [0.33.64] - 2026-11-01

### Changed
- regenerate plugin bundles
- Bound asset evidence to an 8 MiB byte budget

## [0.33.63] - 2026-11-01

### Changed
- regenerate plugin bundles

### Fixed
- Fix atom.bio discovery with shared tenant-handle scoping

## [0.33.62] - 2026-11-01

### Changed
- regenerate plugin bundles
- Exclude ported widget runtime dialogs from capture
- Align route device checks with export equivalence

## [0.33.61] - 2026-10-31

### Changed
- regenerate plugin bundles
- Export head-only social image originals without a portable rendition

## [0.33.60] - 2026-10-31

### Changed
- regenerate plugin bundles
- Stabilize redirect deadline verification for G19 gate — Refs #1090, #1034

## [0.33.59] - 2026-10-31

### Changed
- regenerate plugin bundles
- Preserve WordPress emoji runtime markers for native emoji

### Fixed
- Fix resting menu restoration for duplicate responsive panel IDs

## [0.33.58] - 2026-10-31

### Changed
- regenerate plugin bundles
- Preserve resting navigation panels in synthesized dialogs

## [0.33.57] - 2026-10-31

### Changed
- regenerate plugin bundles
- Mark pages whose WordPress runtime emoji were restored

## [0.33.56] - 2026-10-31

### Changed
- regenerate plugin bundles

### Fixed
- Fix media families with stacked WordPress rendition suffixes

## [0.33.55] - 2026-10-31

### Changed
- regenerate plugin bundles

### Fixed
- download assets at the origin's full concurrency once routes stop starting

## [0.33.54] - 2026-10-31

### Changed
- regenerate plugin bundles
- Ignore node_modules whether it is a directory or a symlink
- Retry a route whose source app crashed into its client error shell
- Place a device-only wrapper that has no default counterpart
- Cap vitest workers so browser tests stay within runner memory
- Reconcile source-selected device documents into one tree

### Fixed
- admit a route only if captured routes' assets can still be fetched
- serialize reused inline navigation panels in their resting state
- fetch one representative rendition per srcset
- skip @font-face sources no browser loads

## [0.33.53] - 2026-10-30

### Changed
- regenerate plugin bundles
- Refuse Medium's error view as route content
- Name Medium copies after their owner instead of the platform
- Treat tracking and platform referral parameters as non-identity in route keys

## [0.33.52] - 2026-10-30

### Changed
- regenerate plugin bundles

### Fixed
- export verified images that only stylesheets reference

## [0.33.51] - 2026-10-30

### Changed
- regenerate plugin bundles
- Record an SVG's declared size instead of the browser's default object size

## [0.33.50] - 2026-10-30

### Changed
- regenerate plugin bundles
- Normalize scroll, animation clock and generated IDs before reading a route

### Fixed
- serialize viewport-height-sized inline lengths as 100vh

## [0.33.49] - 2026-10-30

### Changed
- regenerate plugin bundles
- Remove Medium platform chrome and stop probing its account-gated controls
- Scope Medium author and publication captures to their owner path

### Fixed
- serialize one head title matching document.title
- follow a redirecting route's sample slot to its alias target
- resolve query renditions to their rendered rel=canonical route before the full pipeline

## [0.33.48] - 2026-10-30

### Changed
- Cover fonts served through a same-origin stylesheet proxy

## [0.33.47] - 2026-10-30

### Changed
- Record the source commit in the packed release tarball

## [0.33.46] - 2026-10-30

### Changed
- regenerate plugin bundles
- Bound post-baseline interaction phases by the route deadline

## [0.33.45] - 2026-10-30

### Changed
- regenerate plugin bundles

### Fixed
- project route admission from non-entrypoint routes, so a slow entrypoint no longer closes admission

## [0.33.44] - 2026-10-30

### Changed
- regenerate plugin bundles
- Keep verified image originals when section media shares a filename
- Keep script-built paragraph content parser-stable in captured HTML

### Fixed
- Fix lazy-load sweeps for primary inner scrollers

## [0.33.43] - 2026-10-30

### Changed
- regenerate plugin bundles
- Ship a component with differing destinations per viewport, not the page

## [0.33.42] - 2026-10-30

### Changed
- regenerate plugin bundles

### Fixed
- Fix fidelity clipping for device-document wrappers

## [0.33.41] - 2026-10-30

### Changed
- regenerate plugin bundles
- Capture paginated, searched and filtered collections as component nodes

## [0.33.40] - 2026-10-30

### Changed
- regenerate plugin bundles
- Capture carousels as v2 slideshow component nodes
- Resolve same-page fragment links without constructing URLs

### Fixed
- Fix repeated-image correspondence with document-order pairing

## [0.33.39] - 2026-10-29

### Changed
- regenerate plugin bundles
- Drop stale integrity from exported resources whose bytes were rewritten

## [0.33.38] - 2026-10-29

### Changed
- regenerate plugin bundles
- Reuse swept fluid series across a capture's routes

## [0.33.37] - 2026-10-29

### Changed
- regenerate plugin bundles
- Respect viewport URL identity in single-tree correspondence
- Stop probing a selectable set whose member opens another window

### Fixed
- match clipped text in the case text-transform renders

## [0.33.36] - 2026-10-29

### Changed
- regenerate plugin bundles
- Fetch asset originals while routes are captured

## [0.33.35] - 2026-10-29

### Changed
- regenerate plugin bundles
- Attribute third-party overlays inserted as HTML or through adjacent-node APIs

### Fixed
- Fix frozen reference readiness for unreachable lazy images

## [0.33.34] - 2026-10-29

### Changed
- regenerate plugin bundles
- Preserve locally captured assets after the acquisition deadline

## [0.33.33] - 2026-10-29

### Changed
- regenerate plugin bundles

### Fixed
- Fix social-image metadata localization during export

## [0.33.32] - 2026-10-29

### Changed
- regenerate plugin bundles
- Capture routes as an initial snapshot plus component state nodes

## [0.33.31] - 2026-10-29

### Changed
- regenerate plugin bundles
- Extend asset records to fonts, downloads and video

## [0.33.30] - 2026-10-29

### Changed
- regenerate plugin bundles
- Extend image asset records to CSS, lightbox and head references

## [0.33.29] - 2026-10-29

### Changed
- regenerate plugin bundles
- Add image asset records keyed by source resource
- Classify owned listboxes and record client-routed destinations

### Fixed
- Fix Shopify product JSON-LD on locale-prefixed routes

## [0.33.28] - 2026-10-28

### Changed
- regenerate plugin bundles

### Fixed
- Fix linked-page frontier admitting file downloads

## [0.33.27] - 2026-10-28

### Changed
- regenerate plugin bundles

### Fixed
- keep interaction probes read-only

## [0.33.26] - 2026-10-28

### Changed
- regenerate plugin bundles
- Gallery alignment reports an absent root unverified instead of timing out the route
- Gallery lightbox probe no longer follows slide links to other documents

### Fixed
- dismiss modals opened by selectable-set probes
- contain per-profile page-error storms

## [0.33.25] - 2026-10-28

### Changed
- regenerate plugin bundles

### Fixed
- Fix pointer probe clicking labels inside ARIA controls

## [0.33.24] - 2026-10-27

### Changed
- regenerate plugin bundles
- Prevent disclosure hydration from opening controlled dialogs

## [0.33.23] - 2026-10-27

### Changed
- regenerate plugin bundles
- Add routeReserveMs: a per-route downstream reserve in the capture time budget

## [0.33.22] - 2026-10-27

### Changed
- regenerate plugin bundles
- Stop a second path rewrite from blanking a CSS background

## [0.33.21] - 2026-10-27

### Changed
- regenerate plugin bundles
- Deduplicate shared device stylesheets without changing per-device cascade

## [0.33.20] - 2026-10-27

### Changed
- regenerate plugin bundles
- Publish to an existing Spacefast space

## [0.33.19] - 2026-10-27

### Changed
- regenerate plugin bundles
- Capture a local source site: caller-vouched trusted origins through the SSRF guard

### Fixed
- Fix responsive navigation resting-state capture

## [0.33.18] - 2026-10-27

### Changed
- regenerate plugin bundles

### Fixed
- Fix Wix anchor capture leaving collapsed menus open

## [0.33.17] - 2026-10-27

### Changed
- regenerate plugin bundles
- Disclosure probing survives a frozen window.open
- skip the Blog comments and engagement widget during interaction probing

## [0.33.16] - 2026-10-26

### Changed
- regenerate plugin bundles
- Keep capturing when an inert-probe component changes on its own
- Batch inert-control proofs across disjoint components

## [0.33.15] - 2026-10-26

### Changed
- regenerate plugin bundles
- Mark pointer controls with no observable click effect as inert capture evidence

## [0.33.14] - 2026-10-26

### Changed
- regenerate plugin bundles
- replay cross-route resources under RFC 9111 shared-cache semantics

## [0.33.13] - 2026-10-26

### Changed
- regenerate plugin bundles
- Record unrendered native form controls during capture

## [0.33.12] - 2026-10-26

### Changed
- regenerate plugin bundles

### Fixed
- Fix closed-select visible text in compare

## [0.33.11] - 2026-10-26

### Changed
- regenerate plugin bundles
- Rewrite body selectors for variant-only body classes onto the responsive document wrappers

## [0.33.10] - 2026-10-26

### Changed
- regenerate plugin bundles
- Rewrite same-site URL option values to captured routes

### Fixed
- Fix mixed-content stylesheet localization in HTTPS captures

## [0.33.9] - 2026-10-25

### Changed
- regenerate plugin bundles
- Carry both translation axes per band for script-placed grid items

## [0.33.8] - 2026-10-25

### Changed
- regenerate plugin bundles
- Export server-script document routes as HTML

## [0.33.7] - 2026-10-24

### Changed
- regenerate plugin bundles
- Keep populated ARIA disclosures collapsed through capture and replay them offline

## [0.33.6] - 2026-10-24

### Changed
- regenerate plugin bundles
- Hoist shared device-marked styles onto stylesheet links

## [0.33.5] - 2026-10-24

### Changed
- regenerate plugin bundles
- Compare empty containers by presence in the device-mode structure check

### Fixed
- Fix false responsive duplication of captured page islands

## [0.33.4] - 2026-10-24

### Changed
- regenerate plugin bundles
- Learn script-written, width-dependent inline min-height in the fluid sweep

## [0.33.3] - 2026-10-24

### Changed
- regenerate plugin bundles
- Bound how long a pending data request holds readiness quiet

## [0.33.2] - 2026-10-23

### Changed
- regenerate plugin bundles

### Fixed
- send a self-consistent browser identity on the wire for every source profile

## [0.33.1] - 2026-10-23

### Changed
- regenerate plugin bundles
- Drop captcha runtime widgets from captured forms

## [0.33.0] - 2026-10-23

### Added
- derive the default browser route budget from the capture deadline

### Changed
- regenerate plugin bundles

### Fixed
- calibrate memory admission on degraded routes so capture runs in parallel

## [0.32.30] - 2026-10-23

### Changed
- regenerate plugin bundles

### Fixed
- restore runtime emoji replacement images to their text

## [0.32.29] - 2026-10-23

### Changed
- regenerate plugin bundles

### Fixed
- count a password field as membership, not a login link

## [0.32.28] - 2026-10-22

### Changed
- regenerate plugin bundles
- Remove third-party runtime widgets and stabilize scroll-reveal settling

## [0.32.27] - 2026-10-22

### Changed
- regenerate plugin bundles
- Name script-served resources by their served content type
- Complete Shopify product-page ProductGroup JSON-LD

### Fixed
- reclaim custom-element hosts a removed service widget left empty

## [0.32.26] - 2026-10-22

### Changed
- regenerate plugin bundles
- Discovery leaves Jetpack image/video sitemaps out of the route inventory

## [0.32.25] - 2026-10-22

### Changed
- regenerate plugin bundles
- Negotiate like the browser when resource capture fetches images directly

## [0.32.24] - 2026-10-22

### Changed
- regenerate plugin bundles

### Fixed
- localize protocol-relative media in captured interaction states

## [0.32.23] - 2026-10-22

### Changed
- regenerate plugin bundles
- install Playwright Chromium without apt deps and cache it

### Fixed
- prune wrappers vacated by relocated dialog panels

## [0.32.22] - 2026-10-22

### Changed
- regenerate plugin bundles
- Restore the capture baseline after unproven disclosure probes

### Fixed
- remove shipping estimator service and dedicated disclosure

## [0.32.21] - 2026-10-21

### Changed
- regenerate plugin bundles
- Discovery leaves index-named attachment sitemaps out of the route inventory

## [0.32.20] - 2026-10-21

### Changed
- regenerate plugin bundles
- Discovery leaves attachment viewer URLs (?attachment_id=) out of the route inventory

## [0.32.19] - 2026-10-21

### Changed
- regenerate plugin bundles
- Sample each distinct icon glyph once per run so shared footers serialize identically

## [0.32.18] - 2026-10-21

### Changed
- regenerate plugin bundles
- drop the per-phase start lines from stderr

### Fixed
- remove provider-service chat and cart-sync widgets

## [0.32.17] - 2026-10-21

### Changed
- regenerate plugin bundles

### Fixed
- Fix metadata-only image capture and localization

## [0.32.16] - 2026-10-20

### Changed
- regenerate plugin bundles
- Restore the route after a click-disclosure member navigates, without re-clicking the group

## [0.32.15] - 2026-10-20

### Changed
- regenerate plugin bundles
- Hide stubborn overlays in place and refuse a client-error shell capture

## [0.32.14] - 2026-10-20

### Changed
- regenerate plugin bundles
- Preserve runtime Google Maps as editable iframe embeds
- Reserve a render-critical slice of the captured-resource budget so media cannot starve stylesheets and fonts

## [0.32.13] - 2026-10-20

### Changed
- regenerate plugin bundles

### Fixed
- leave rules with an invalid selector list as authored instead of aborting capture

## [0.32.12] - 2026-10-20

### Changed
- regenerate plugin bundles
- Declare importer-facing sidecar reports in the capture receipt
- Pace template grouping and HTTP acquisition through one per-origin source governor

## [0.32.11] - 2026-10-20

### Changed
- regenerate plugin bundles

### Fixed
- keep a source ready when its own media playback interrupts play()
- name binary resources served with a text MIME by their bytes

## [0.32.10] - 2026-10-19

### Changed
- regenerate plugin bundles
- Capture non-ARIA click accordions as local disclosures and report unreplayable choice groups
- Guard selectable-set region text normalization against whitespace-only changes
- Keep site-chrome toggles in their resting state during content hydration
- Bound media filenames to the 255-byte filesystem limit (fixes #898)

## [0.32.9] - 2026-10-17

### Changed
- regenerate plugin bundles
- Exclude routes whose rendered document is empty

## [0.32.8] - 2026-10-16

### Changed
- regenerate plugin bundles

### Fixed
- carry Pro Gallery horizontal strips as host-relative widths

## [0.32.7] - 2026-10-16

### Changed
- regenerate plugin bundles

### Fixed
- name the site from the title segment every captured route repeats

## [0.32.6] - 2026-10-16

### Changed
- regenerate plugin bundles
- carry declared Wix image geometry as container-relative CSS before the fluid sweep

## [0.32.5] - 2026-10-16

### Changed
- regenerate plugin bundles
- Do not count or sweep for non-pixel custom-property fluid series

## [0.32.4] - 2026-10-16

### Changed
- regenerate plugin bundles
- Name query renditions from their slug value instead of a counter

## [0.32.3] - 2026-10-16

### Changed
- regenerate plugin bundles

### Fixed
- prove slideshows whose arrows are not rendered at the capture width

## [0.32.2] - 2026-10-16

### Changed
- regenerate plugin bundles

### Fixed
- cook data-liberation-agent

## [0.32.1] - 2026-10-16

### Changed
- regenerate plugin bundles
- Let adapter-declared telemetry stop holding network quiet

## [0.32.0] - 2026-10-16

### Added
- record the source's declared generator in the capture receipt

### Changed
- regenerate plugin bundles

## [0.31.1] - 2026-10-16

### Changed
- regenerate plugin bundles
- stop re-parsing projected stylesheets in device assembly
- cut selectable-state probing that cannot change its outcome
- end per-width rest on observed viewport work instead of a fixed window
- Settle scroll reveals before an interaction visibility baseline

### Fixed
- reserve memory per route kind so routes without reference pages admit against their own working set
- keep third-party form actions and record form action rewrites

## [0.31.0] - 2026-10-15

### Added
- derive verified template-cluster routes from captured representatives
- carry blog engagement counts as receipt data and mark the frozen counters

### Changed
- regenerate plugin bundles
- skip query-only route aliases whose canonical is another inventory route
- reuse shared-chrome states whose panels render outside the landmark
- skip the Wix slideshow sweep when the server document has none
- Close navigation panels mounted while expanding collapsed content

### Fixed
- capture slideshows driven by unnamed icon controls
- abandon a stalled route at a per-route deadline
- release a drawer's scroll lock and end a landing that never starts
- Wix-owned normalization of per-request page styles for template grouping

## [0.30.2] - 2026-10-15

### Changed
- regenerate plugin bundles

### Fixed
- address Automattic/data-liberation-agent#850

## [0.30.1] - 2026-10-15

### Changed
- regenerate plugin bundles

### Fixed
- keep pinned site menus that link to a privacy policy

## [0.30.0] - 2026-10-15

### Added
- name each phase as it opens and split mislabeled ledger phases

### Changed
- regenerate plugin bundles
- resolve readiness network waits at render-affecting quiet
- probe interactions only for the per-device documents
- reuse the previous width's lazy sweep when nothing new can load
- wait on observed conditions for anchor sweeps and slide collection
- Count reclaimable memory on macOS in capture memory admission

## [0.29.5] - 2026-10-14

### Fixed
- bundle CLI runtime dependencies

## [0.29.4] - 2026-10-14

### Changed
- regenerate plugin bundles

### Fixed
- retire redundant srcset renditions before unique assets under the total budget

## [0.29.3] - 2026-10-14

### Changed
- regenerate plugin bundles
- fetch DOM render dependencies through a rolling pool

## [0.29.2] - 2026-10-14

### Changed
- regenerate plugin bundles

### Fixed
- rest fluid widths when scroll-linked chrome regrows at the top

## [0.29.1] - 2026-10-14

### Changed
- regenerate plugin bundles

### Fixed
- do not count time-budget skips against capture usability

## [0.29.0] - 2026-10-14

### Added
- log a per-route phase timing breakdown

### Changed
- regenerate plugin bundles

## [0.28.2] - 2026-10-14

### Changed
- regenerate plugin bundles
- bound default capture concurrency by machine memory when no cgroup limit applies

## [0.28.1] - 2026-10-14

### Changed
- regenerate plugin bundles
- count reclaimable page cache as available in memory admission

## [0.28.0] - 2026-10-13

### Added
- bound the website output with a total byte and file budget
- add a Framer platform adapter that removes the host badge

### Changed
- regenerate plugin bundles

## [0.27.7] - 2026-10-13

### Changed
- regenerate plugin bundles
- Stamp scroll entrances inside tab panels the capture opens

### Fixed
- restore page state flipped by a no-dialog probe click

## [0.27.6] - 2026-10-13

### Changed
- regenerate plugin bundles
- Keep video iframes in tab panel snapshots

## [0.27.5] - 2026-10-13

### Changed
- regenerate plugin bundles

### Fixed
- replay viewport entrances for content the width sweep remounted

## [0.27.4] - 2026-10-13

### Changed
- regenerate plugin bundles
- Keep ?tab= links on the captured route and record each tab's key
- Do not save analytics beacon replies as site resources

### Fixed
- retry a timed-out source document once with a longer budget

## [0.27.3] - 2026-10-13

### Changed
- regenerate plugin bundles
- sample adaptively and refine only unexplained intervals
- probe shared chrome once and reuse it on every route

## [0.27.2] - 2026-10-13

### Changed
- regenerate plugin bundles
- decide the phone capture per route

### Fixed
- report a route whose passes disagreed about a redirect as failed

## [0.27.1] - 2026-10-13

### Changed
- close the protocol-redirect fixture's unrequested sockets

## [0.27.0] - 2026-10-13

### Changed
- regenerate plugin bundles
- write only the Blocks Engine capture vocabulary and source-findings.json

## [0.26.1] - 2026-10-13

### Changed
- regenerate plugin bundles
- Record the ancestor state that shows a modal menu
- Keep a page's dialog states when a probed panel unmounts itself

## [0.26.0] - 2026-10-13

### Added
- template grouping report and template-coverage route selection

### Changed
- regenerate plugin bundles

## [0.25.0] - 2026-10-13

### Added
- record rendered glyph colour as data-dla-glyph-color
- export partial output under a capture time budget and cap exported file size

### Changed
- regenerate plugin bundles

## [0.24.0] - 2026-10-13

### Added
- carry capture findings inside the website artifact

### Changed
- regenerate plugin bundles
- exclude perpetual movers from rest and stop after a constant probe

## [0.23.3] - 2026-10-12

### Changed
- regenerate plugin bundles
- guard that capture/export throw and reject sites declare a failure class

### Fixed
- find head and body by real tags, not by text inside scripts

## [0.23.2] - 2026-10-12

### Changed
- regenerate plugin bundles

### Fixed
- do not admit state-changing action URLs as routes
- give each document hop the remaining navigation budget
- drop colliding routes, off-origin URLs and lost evidence blocks instead of failing the capture

## [0.23.1] - 2026-10-12

### Changed
- regenerate plugin bundles

### Fixed
- navigate on document readiness, not the full load event

## [0.23.0] - 2026-10-11

### Added
- bound browser capture with a shared route budget

### Changed
- regenerate plugin bundles

## [0.22.3] - 2026-10-11

### Changed
- regenerate plugin bundles

### Fixed
- count routes with saved HTML as captured and contain per-route export failures

## [0.22.2] - 2026-10-11

### Changed
- regenerate plugin bundles

### Fixed
- count real body elements and keep fluid learning from failing routes

## [0.22.1] - 2026-10-11

### Changed
- stand down when a newer merge supersedes the bundle push

## [0.22.0] - 2026-10-11

### Added
- report a usable partial-capture contract

### Changed
- regenerate plugin bundles

### Fixed
- count failed routes, not failure records

## [0.21.9] - 2026-10-11

### Changed
- regenerate plugin bundles
- normalize each route document once

### Fixed
- share bounded source document admission
- preserve disclosure hydration baselines
- complete admitted inventory beyond discovery deadlines

## [0.21.8] - 2026-10-11

### Changed
- regenerate plugin bundles
- accept desktop and mobile requests in either order
- freeze reference evidence for the entrypoint by default (route-sample option, 'all' for full parity)
- refine the tablet sweep band only on observed change
- admit routes against a per-route working set above the idle floor
- compare sampled drift routes concurrently
- bound observation settle by readiness instead of a fixed sleep
- run viewport passes concurrently

### Fixed
- restore an abandoned sweep's pose and resolve served routes once
- fetch rendered sample requests with a browser-like connection limit
- name the network cause when a source request fails
- settle a source's own same-document reload
- skip non-HTML routes before the document byte budget
- do not read image sitemap entries as page routes

## [0.21.7] - 2026-10-09

### Changed
- regenerate plugin bundles

### Fixed
- verify src-swap slot continuity

## [0.21.6] - 2026-10-09

### Changed
- regenerate plugin bundles
- resweep only when the document grew or revealed a pending image

### Fixed
- avoid retry after stage mutation

## [0.21.5] - 2026-10-09

### Changed
- regenerate plugin bundles
- remove unused design capture path

## [0.21.4] - 2026-10-09

### Changed
- regenerate plugin bundles
- prove cycles with fewer actions

## [0.21.3] - 2026-10-09

### Changed
- regenerate plugin bundles
- settle dialog content and scroll-state snapshots through settleDocument
- share baseline-owned geometry predicates
- one document readiness primitive with recorded outcomes

### Fixed
- settle gallery restore through shared readiness
- share rendered text clip accounting

## [0.21.2] - 2026-10-09

### Changed
- regenerate plugin bundles

### Fixed
- wire portable src-swap cycles

## [0.21.1] - 2026-10-09

### Changed
- regenerate plugin bundles

### Fixed
- retain observed lightboxes through bounded proof

## [0.21.0] - 2026-10-09

### Added
- record per-profile wall-clock phases in the manifest

### Changed
- regenerate plugin bundles
- record viewport failures and serialize documents through one path
- consolidate reference-cell cleanup ownership

## [0.20.17] - 2026-10-09

### Changed
- regenerate plugin bundles
- skip the responsive sweep when inline geometry is constant

## [0.20.16] - 2026-10-09

### Changed
- regenerate plugin bundles
- skip scroll-only waits when the document cannot scroll

### Fixed
- capture looping src-swap galleries

## [0.20.15] - 2026-10-09

### Changed
- consolidate expensive evidence cases

## [0.20.14] - 2026-10-09

### Changed
- regenerate plugin bundles
- observe reference cells concurrently
- avoid resweeping completed image renditions
- consolidate fluid capture sweeps
- reduce linked-frontier browser test time
- settle selectable activations on quiet and stop probing inert sets
- settle on page signals
- share Chromium across interaction suites
- consolidate browser capture suites
- share browser across replay suites
- document browser test cost guidance

### Fixed
- carry adapter route ownership through admission and export

## [0.20.13] - 2026-10-09

### Changed
- regenerate plugin bundles
- skip unreachable clipped native-lazy images in readiness waits
- rely on loading-cover wait for startup splash evidence
- bound structural indexes and release source pairs
- shard Vitest across four jobs

### Fixed
- admit route workers against observed runtime memory
- preserve descriptorless comma-bearing srcset candidates
- settle startup and sweep motion before frozen proof
- wait out textless loading covers and restore swept pose
- preserve observed native control state in baseline HTML

## [0.20.12] - 2026-10-08

### Changed
- regenerate plugin bundles

### Fixed
- expand bounded rendered linked-page frontier

## [0.20.11] - 2026-10-08

### Changed
- give the browser test job headroom past 20 minutes

## [0.20.10] - 2026-10-08

### Changed
- regenerate plugin bundles
- avoid image readiness waits for inactive alternatives

### Fixed
- freeze bounded external redirect outcomes

## [0.20.9] - 2026-10-08

### Changed
- regenerate plugin bundles

### Fixed
- close bounded linked-page fallback

## [0.20.8] - 2026-10-08

### Changed
- regenerate plugin bundles

### Fixed
- preserve Wix resting overflow navigation

## [0.20.7] - 2026-10-08

### Changed
- regenerate plugin bundles
- consolidate responsive geometry readiness

### Fixed
- derive wired panel aria-modal from observed presentation

## [0.20.6] - 2026-10-08

### Changed
- regenerate plugin bundles

### Fixed
- activate device styles from the single selection runtime
- learn runtime-written stylesheet offsets across the width sweep
- make the media exclusion auditable, and filter it before the link cap
- replay source-observed finite CSS lifecycle

## [0.20.5] - 2026-10-08

### Changed
- regenerate plugin bundles
- compare frozen cells with bounded concurrency

### Fixed
- exclude removed Lovable chrome from behavior evidence
- preserve native details resting state during hydration
- preserve source controls through popup probing

## [0.20.4] - 2026-10-08

### Changed
- regenerate plugin bundles

### Fixed
- show the default device document where the selection runtime never runs
- do not inventory linked media as routes

## [0.20.3] - 2026-10-07

### Changed
- regenerate plugin bundles

### Fixed
- keep HTTP runtime projection responsive

## [0.20.2] - 2026-10-07

### Changed
- regenerate plugin bundles

### Fixed
- exclude copied popup nodes from source trigger wiring
- preserve source device documents and profile identity
- handle removed nodes during fluid transform validation

## [0.20.1] - 2026-10-07

### Changed
- regenerate plugin bundles

### Fixed
- preserve fluid geometry across cloned source roles

## [0.20.0] - 2026-10-07

### Added
- retain source-proven CMS collection evidence
- project declared runtime regions in HTTP review

### Changed
- regenerate plugin bundles
- cover layered responsive disclosure visibility

### Fixed
- canonicalize equivalent painted inline typography

## [0.19.10] - 2026-10-07

### Changed
- regenerate plugin bundles
- Add Ghost platform detection and capture cleanup

### Fixed
- retain challenge evidence in HTTP rejection diagnostics
- preserve bounded image gallery and lightbox cycles
- preserve distinct repeated-slash source documents
- port Wix maps to Google Maps embeds and mark Wix app widgets
- mark Wix sign-in controls for the destination's login
- stop a `//path` sitemap entry from aborting the capture
- report why the source homepage was not captured
- store text/css responses under a .css name
- keep in-page helpers working when a page library patches Array
- scope Soloist routes to the customer tenant
- keep source browser locale consistent

## [0.19.9] - 2026-10-07

### Changed
- regenerate plugin bundles

### Fixed
- drop the Wix members login and keep members-only pages as placeholders

## [0.19.8] - 2026-10-06

### Changed
- regenerate plugin bundles

### Fixed
- retry crashed renderers in fresh contexts

## [0.19.7] - 2026-10-06

### Changed
- regenerate plugin bundles

### Fixed
- recover orphan CSS priority fragments

## [0.19.6] - 2026-10-06

### Changed
- regenerate plugin bundles
- isolate shared stylesheet materialization

### Fixed
- preserve linked PDFs as portable assets
- preserve dropdown ancestor state and source flow placement
- follow bounded candidate-local redirects

## [0.19.5] - 2026-10-06

### Changed
- regenerate plugin bundles
- Store shared chrome once in the canonical site tree
- isolate portable media materialization

## [0.19.4] - 2026-10-06

### Changed
- await source resize fixture transitions

## [0.19.3] - 2026-10-06

### Changed
- regenerate plugin bundles

### Fixed
- learn and preserve mobile fluid geometry
- resolve resources against rendered document base

## [0.19.2] - 2026-10-06

### Changed
- regenerate plugin bundles
- isolate capture evidence projection

## [0.19.1] - 2026-10-06

### Changed
- regenerate plugin bundles
- complete browser doubles for native timeline probes
- isolate portable resource materialization

### Fixed
- preserve resting navigation and existing panel identity
- normalize portable document relation links
- preserve native view timeline motion and responsive ranges
- recognize same-site protocol redirects
- follow extensionless sitemap index children

## [0.19.0] - 2026-10-06

### Added
- orchestrate opt-in HTTP review capture

### Changed
- regenerate plugin bundles

## [0.18.7] - 2026-10-06

### Changed
- regenerate plugin bundles

### Fixed
- probe header navigation buttons for the link panels they reveal

## [0.18.6] - 2026-10-05

### Changed
- regenerate plugin bundles
- prepare stable portable replacements once

## [0.18.5] - 2026-10-05

### Changed
- regenerate plugin bundles

### Fixed
- preserve viewport-triggered transition entrances

## [0.18.4] - 2026-10-05

### Changed
- regenerate plugin bundles
- share srcset tokenization across capture and export

### Fixed
- use local images inside captured interaction states
- capture the region of exclusive aria-pressed segmented controls
- preserve distinct query route documents

## [0.18.3] - 2026-10-05

### Changed
- regenerate plugin bundles
- collect retained media references once

### Fixed
- capture every panel of ARIA tablists that select on mousedown
- probe plain action buttons for the dialogs they open
- give selectable-set probing a 30s drive budget

## [0.18.2] - 2026-10-05

### Changed
- regenerate plugin bundles

### Fixed
- capture and replay coherent mobile viewport evidence

## [0.18.1] - 2026-10-04

### Changed
- regenerate plugin bundles
- reuse planned media content hashes
- publish website and sidecars with recovery

## [0.18.0] - 2026-10-04

### Added
- capture finite bootstrap-backed collections

### Changed
- regenerate plugin bundles

### Fixed
- replay populated disclosures with observed ancestor concealment

## [0.17.2] - 2026-10-03

### Changed
- regenerate plugin bundles

### Fixed
- reconcile named aliases in single documents

## [0.17.1] - 2026-10-02

### Changed
- regenerate plugin bundles

### Fixed
- honor receipt-proven source route aliases

## [0.17.0] - 2026-10-02

### Added
- add HTTP acquisition and observed child export

### Changed
- regenerate plugin bundles

### Fixed
- observe clipped offstage text and baseline pose

## [0.16.6] - 2026-10-02

### Changed
- regenerate plugin bundles
- Preserve learned slide transforms through responsive counterpart assembly

### Fixed
- strip app builder acquisition chrome

## [0.16.5] - 2026-10-02

### Changed
- regenerate plugin bundles

### Fixed
- preserve authored dialog trigger layout and interaction

## [0.16.4] - 2026-10-02

### Changed
- regenerate plugin bundles
- plan portable media selection once

## [0.16.3] - 2026-10-02

### Changed
- regenerate plugin bundles
- bind responsive HTML and evidence to one assembly

### Fixed
- exclude clipped accessible-only text metrics
- preserve coherent responsive source baselines

## [0.16.2] - 2026-10-02

### Changed
- regenerate plugin bundles

### Fixed
- interpret CSS dependency URLs and empty stylesheets correctly

## [0.16.1] - 2026-10-02

### Changed
- regenerate plugin bundles

### Fixed
- preserve body-class-gated mobile documents

## [0.16.0] - 2026-10-01

### Added
- add a narrow Next.js platform adapter

### Changed
- regenerate plugin bundles
- Preserve semantic headers containing nested consent notices

### Fixed
- normalize responsive named-anchor aliases

## [0.15.0] - 2026-10-01

### Added
- preserve portable native branding evidence

## [0.14.0] - 2026-10-01

### Added
- preserve portable native branding evidence

### Changed
- regenerate plugin bundles

## [0.13.5] - 2026-10-01

### Changed
- regenerate plugin bundles

### Fixed
- replay frozen source pixel density and browser identity

## [0.13.4] - 2026-10-01

### Changed
- regenerate plugin bundles

### Fixed
- preserve fractional constant typography

## [0.13.3] - 2026-10-01

### Changed
- regenerate plugin bundles

### Fixed
- reuse capture route identity for frozen readiness

## [0.13.2] - 2026-10-01

### Changed
- regenerate plugin bundles

### Fixed
- inspect unscheduled source links for outbound redirects
- preserve adjacent text shaping boundaries

## [0.13.1] - 2026-10-01

### Changed
- regenerate plugin bundles

### Fixed
- match exact image resources before perceptual hashes
- preserve responsive disclosure layout participation
- settle painted font stacks before freezing evidence

## [0.13.0] - 2026-10-01

### Added
- render a portable homepage preview

### Changed
- regenerate plugin bundles
- stop lazy sweeps at the reachable scroll bottom

### Fixed
- disambiguate authored responsive fragment targets
- preserve resting disclosures and painted text

## [0.12.0] - 2026-09-30

### Added
- verify and replay local collection search

### Changed
- regenerate plugin bundles

## [0.11.0] - 2026-09-30

### Added
- expose owned capture preview server

### Changed
- regenerate plugin bundles

### Fixed
- hydrate locally mounted disclosure panels
- cook data-liberation-agent

## [0.10.0] - 2026-09-30

### Added
- freeze capture-session references and compare adjacent stages

### Changed
- regenerate plugin bundles

## [0.9.0] - 2026-09-30

### Added
- learn editable motion, sandbox source canvas code, and promote after live verification

### Changed
- regenerate plugin bundles

## [0.8.11] - 2026-09-30

### Changed
- regenerate plugin bundles
- classify native disclosures and passive link wrappers before probing

## [0.8.10] - 2026-09-30

### Changed
- regenerate plugin bundles
- Let layered author CSS win over converted-trigger base styles
- Stop blaming the copy for the source page's exit beacons
- Keep article prose out of credit-text cleanup
- Add Substack platform detection and capture cleanup

## [0.8.9] - 2026-09-30

### Changed
- regenerate plugin bundles

### Fixed
- project mobile inline styles in equivalent documents

## [0.8.8] - 2026-09-29

### Changed
- regenerate plugin bundles

### Fixed
- verify editable route-tab links with painted labels

## [0.8.7] - 2026-09-29

### Changed
- regenerate plugin bundles
- avoid fluid sweeps for blank editorial formatting

## [0.8.6] - 2026-09-29

### Changed
- regenerate plugin bundles

### Fixed
- snapshot baseline before interaction probes

## [0.8.5] - 2026-09-29

### Changed
- regenerate plugin bundles

### Fixed
- follow absolute gallery inset positions

## [0.8.4] - 2026-09-29

### Changed
- regenerate plugin bundles
- Add EmDash CMS platform detection

### Fixed
- keep a fixed layer that holds the page's content
- fail fast when a page stops responding while settling
- keep the expansion probe from loading another document
- preserve source-observed mobile route tabs
- exclude popup descendants from selectable probes
- strip freemium acquisition overlay

## [0.8.3] - 2026-09-29

### Changed
- regenerate plugin bundles

### Fixed
- preserve blog publication evidence

## [0.8.2] - 2026-09-29

### Changed
- regenerate plugin bundles

### Fixed
- retain fluid gallery descendants through narrow regimes

## [0.8.1] - 2026-09-29

### Changed
- regenerate plugin bundles

### Fixed
- fit bounded desktop gallery widths

## [0.8.0] - 2026-09-29

### Added
- verify authored motion in portable HTML

### Changed
- regenerate plugin bundles

## [0.7.4] - 2026-09-29

### Changed
- regenerate plugin bundles

### Fixed
- retain expanded-state navigation popups

## [0.7.3] - 2026-09-29

### Changed
- regenerate plugin bundles

### Fixed
- wait for finite canvas ripple to settle

## [0.7.2] - 2026-09-29

### Changed
- regenerate plugin bundles

### Fixed
- localize compact CSS font imports

## [0.7.1] - 2026-09-29

### Changed
- regenerate plugin bundles
- Capture linked Word downloads as portable assets
- Treat expired Wix event forms as parent-event aliases

## [0.7.0] - 2026-09-29

### Added
- verify candidate motion against source behavior

### Changed
- regenerate plugin bundles

## [0.6.14] - 2026-09-29

### Changed
- regenerate plugin bundles

### Fixed
- exclude clipped focus-only links from visible text

## [0.6.13] - 2026-09-28

### Changed
- regenerate plugin bundles

### Fixed
- wait for declared finite loading sequences

## [0.6.12] - 2026-09-28

### Changed
- regenerate plugin bundles
- isolate capture route allocation and aliases

### Fixed
- preserve desktop body-gated width rules

## [0.6.11] - 2026-09-28

### Changed
- regenerate plugin bundles
- expect browser-encoded rendition URLs

### Fixed
- surface unreproduced source motion in parity checks
- scope mobile-only classes to mobile styles
- preserve authored responsive image ratios
- encode copied asset paths for browser URLs
- probe disclosures with trusted pointer clicks
- match images through CDN transform paths
- resolve percent-encoded captured route directories
- preserve comma-bearing responsive image URLs
- recover cleanup after source document reinit
- preserve off-screen mobile drawer interactions

## [0.6.10] - 2026-09-28

### Changed
- regenerate plugin bundles

### Fixed
- place captured anchor targets inside their sections, not at page coordinates

## [0.6.9] - 2026-09-28

### Changed
- regenerate plugin bundles

### Fixed
- stabilize unreferenced shared header widget ids
- learn responsive image owner geometry

## [0.6.8] - 2026-09-28

### Changed
- regenerate plugin bundles

### Fixed
- collapse a page whose phone layout re-parents one component, and capture Wix phone anchors at rest

## [0.6.7] - 2026-09-27

### Changed
- regenerate plugin bundles

### Fixed
- canonicalize per-page component instance ids so shared chrome matches across pages

## [0.6.6] - 2026-09-27

### Changed
- regenerate plugin bundles
- Make captured image containers reflow at desktop widths

## [0.6.5] - 2026-09-26

### Changed
- regenerate plugin bundles

### Fixed
- point captured phone menu links at the phone document's section targets

## [0.6.4] - 2026-09-26

### Changed
- regenerate plugin bundles

### Fixed
- resolve each runtime anchor from the starting scroll, and mark unclickable triggers instead of aborting

## [0.6.3] - 2026-09-26

### Changed
- regenerate plugin bundles

### Fixed
- keep expand toggles collapsed in the base document

## [0.6.2] - 2026-09-26

### Changed
- regenerate plugin bundles

### Fixed
- match a viewport-switched image to its declared rendition

## [0.6.1] - 2026-09-25

### Changed
- regenerate plugin bundles

### Fixed
- bind a density-list image src to the loaded file

## [0.6.0] - 2026-09-25

### Added
- reconcile responsive captures by element identity and project per-viewport presentation

### Changed
- regenerate plugin bundles

## [0.5.12] - 2026-09-25

### Changed
- regenerate plugin bundles

### Fixed
- record server-redirect aliases in website/_redirects

## [0.5.11] - 2026-09-25

### Changed
- regenerate plugin bundles

### Fixed
- keep cross-page data-anchor section links as <page>#fragment

## [0.5.10] - 2026-09-25

### Changed
- regenerate plugin bundles

### Fixed
- compare routes with proven cleanup instead of refusing the whole capture

## [0.5.9] - 2026-09-25

### Changed
- regenerate plugin bundles

### Fixed
- follow sampled sizes when a container percentage fails verification

## [0.5.8] - 2026-09-25

### Changed
- regenerate plugin bundles
- recognize CDN-served Squarespace sites from their page markers

### Fixed
- serve tablet widths the desktop document, not the phone capture
- never persist blob: media URLs; keep a poster for MSE video
- capture external SVG sprites referenced by <use> and keep their fragments
- store and count identical resource bytes once
- queue homepage links the sitemap omits
- keep lazy images on their localized renditions instead of the placeholder
- verify every container percentage before fluid capture writes it

## [0.5.7] - 2026-09-25

### Changed
- regenerate plugin bundles

### Fixed
- pair slugified re-encoded images in compare

## [0.5.6] - 2026-09-25

### Changed
- regenerate plugin bundles

### Fixed
- capture the panel a menu button reveals, keep its styles, and render in-flow menus as dropdowns
- resolve server-redirected routes to their target instead of reporting drift
- dismiss consent banners on the compare source, as capture already does

## [0.5.5] - 2026-09-25

### Changed
- regenerate plugin bundles

### Fixed
- probe role="button" menu controls for captured dialogs

## [0.5.4] - 2026-09-24

### Changed
- regenerate plugin bundles

### Fixed
- keep Shopify storefronts on their route while capturing

## [0.5.3] - 2026-09-23

### Changed
- regenerate plugin bundles

### Fixed
- give injected disclosure base rules zero specificity

## [0.5.2] - 2026-09-23

### Changed
- regenerate plugin bundles

### Fixed
- wait for the Wix mobile drawer to open before deciding to close it

## [0.5.1] - 2026-09-23

### Changed
- regenerate plugin bundles

### Fixed
- omit empty custom elements that neither paint nor shape layout
- close the Wix mobile drawer after revealing its links
- hoist shared styles whose extra attributes are inert runtime identifiers
- relaunch the capture browser after a mid-run disconnect

## [0.5.0] - 2026-09-23

### Added
- compare the source against any rendered copy with candidateUrl

### Changed
- regenerate plugin bundles

## [0.4.23] - 2026-09-23

### Changed
- regenerate plugin bundles

### Fixed
- measure only this page's own fragment anchors in compare

## [0.4.22] - 2026-09-23

### Changed
- regenerate plugin bundles

### Fixed
- sweep source cleanup immediately before saving page HTML

## [0.4.21] - 2026-09-23

### Changed
- regenerate plugin bundles

### Fixed
- treat all script pseudo-URL schemes as non-navigable and harden test fixtures

## [0.4.20] - 2026-09-23

### Changed
- regenerate plugin bundles

### Fixed
- learn runtime-written header offsets and keep learned rules above author CSS

## [0.4.19] - 2026-09-22

### Changed
- regenerate plugin bundles

### Fixed
- match compared images by pixel content when their URL names drift

## [0.4.18] - 2026-09-22

### Changed
- regenerate plugin bundles

### Fixed
- learn a rule per viewport regime when one relationship spans a breakpoint

## [0.4.17] - 2026-09-22

### Changed
- regenerate plugin bundles

### Fixed
- keep the shorthand repair factory self-contained under minification

## [0.4.16] - 2026-09-22

### Changed
- regenerate plugin bundles

### Fixed
- Squarespace capture fidelity (fonts, fluid text, provider chrome, compare readiness)

## [0.4.15] - 2026-09-22

### Changed
- attach the npm pack tarball to each GitHub Release

## [0.4.14] - 2026-09-22

### Changed
- regenerate plugin bundles

### Fixed
- preserve icon-only choice transitions

## [0.4.13] - 2026-09-22

### Changed
- regenerate plugin bundles

### Fixed
- make fidelity observations stable across serialization

## [0.4.12] - 2026-09-22

### Changed
- regenerate plugin bundles

### Fixed
- scale video/audio capture limits with the aggregate resource budget
- preserve portable combobox interactions

## [0.4.11] - 2026-09-22

### Changed
- regenerate plugin bundles

### Fixed
- hoist repeated styles when base markup cannot change URL resolution

## [0.4.10] - 2026-09-21

### Changed
- regenerate plugin bundles

### Fixed
- derive a redirected resource's local path and manifest key from the requested url
- settle scroll-reveal capture on documents that grow while scrolling

## [0.4.9] - 2026-09-21

### Changed
- regenerate plugin bundles

### Fixed
- capture and localize video sources, and never drop a failed one

## [0.4.8] - 2026-09-21

### Changed
- regenerate plugin bundles

### Fixed
- recover shorthand-with-var() declarations the live CSSOM cannot re-serialize

## [0.4.7] - 2026-09-21

### Changed
- regenerate plugin bundles

### Fixed
- pair default-document captures by normalized URL

## [0.4.6] - 2026-09-21

### Changed
- regenerate plugin bundles

### Fixed
- carry a source's entry-URL session through capture and media fetch
- root sitemap and robots.txt probes at the entry origin

## [0.4.5] - 2026-09-21

### Changed
- regenerate plugin bundles

### Fixed
- remove Wix 'Powered and secured by' credits

## [0.4.4] - 2026-09-21

### Changed
- regenerate plugin bundles

### Fixed
- Fix delayed Wix desktop anchor scrolling

## [0.4.3] - 2026-09-21

### Changed
- regenerate plugin bundles

### Fixed
- wait for images before responsive capture

## [0.4.2] - 2026-09-21

### Changed
- regenerate plugin bundles

### Fixed
- capture and localize linked audio files

## [0.4.1] - 2026-09-21

### Changed
- regenerate plugin bundles

### Fixed
- distinguish absent source routes from incomplete captures

## [0.4.0] - 2026-09-21

### Added
- record selectable sets that drive a shared region

### Changed
- regenerate plugin bundles only on main

### Fixed
- keep a selectable-set probe from navigating the page
- stop pager probing from clicking picture-only links off the route
- remove the "Powered and secured by Wix" footer credit
- ignore live text in the responsive document signature
- preserve distinct directory and default-document captures
- root the website export at the discovered origin, not the entry URL
- replay captured dialogs onto the captured trigger, not a label match

## [0.3.1] - 2026-09-18

### Fixed
- discover sitemap-index.xml and make incomplete captures explicit
- reclaim the space a removed provider bar reserved in custom properties
- load desktop source pages as desktop Chrome, not HeadlessChrome
- rebase relative links when captured documents move
- accept http and www variants of the entry host in sitemaps, and report rejections
- discover every same-origin homepage link with a DOM, not landmark regexes
- recognize a client-routed SPA not-found screen served as HTTP 200
- stop a client-routed SPA control from navigating capture off its route
- recognize unnamed builder chrome by structure, not vendor name
- capture interaction triggers covered at the click point
- stop treating data: and blob: URIs as unresolved dependencies

## [0.3.0] - 2026-09-17

### Added
- declare the capability vocabulary as a join contract
- measure rendered source complexity
- declare responsive content counterparts
- add bounded source assessment
- gate rendered media, type, and motion parity
- open captured dialogs from a static click
- fail when a source dialog does not open in the copy
- fail when in-page or internal nav does not resolve
- publish a liberated site to Spacefast
- liberate a site from a bare URL

### Changed
- Decide responsive collapse before viewport peeling.
- detect scroll-driven header/logo toggles
- Collapse one-document captures that only differ by hydration attributes.
- Collapse equivalent responsive captures when only runtime ids differ.
- Skip discovered routes that return HTTP 404 or 410
- Preserve mobile-only linked styles during responsive export
- Detect Lovable sites and strip the Made with Lovable badge
- wait for visible menu ancestors during capture
- preserve captured dialog root display
- Add Homeboy-managed continuous release workflow
- raise HTML document fetch ceiling above 2 MB
- Detect Wix Events ticketing as a commerce capability
- Adopt Homeboy-managed releases for version-synced manifests
- Stop concurrent PRs conflicting on the generated dist bundles
- Stop treating cleanup mutation-budget exhaustion as a capture failure
- Stop liberated copies reaching the source CDN via leftover sourcemap/canonical/provenance references
- surface Spacefast's ignored-file count instead of discarding it
- reject unparseable first arguments before the fetch layer
- Capture ARIA disclosure/accordion panels a runtime unmounts while collapsed
- Expose inspect, capture, compare and publish to embedded consumers
- preserve localized CSS backgrounds
- Strip source attribution and ads with cleanup-aware comparison
- filter sitemap page origins
- Add bounded asset source evidence
- resolve the canonical origin before filtering Wix's linked-route crawl
- don't classify store/shop category pages as products
- Recover Squarespace blog routes through bounded archive discovery
- Discover Squarespace navigation from public homepage HTML
- Verify registry-owned platform detection and adapter routing
- Remove the WordPress destination
- document intentional media control-character validation
- Preserve source JSON-LD metadata
- Hoist repeated captured styles
- Settle Wix navigation before capture
- Capture bounded Wix slideshow states
- Parse captured srcsets safely
- Preserve Wix transform media URLs
- Preserve hydrated video sources
- Preserve narrow viewport source variants
- Preserve captured CDN image formats
- Add an extensible Platform API
- Align screenshots with serialized capture state
- Peel remaining capture fixes from Studio PR 3952
- Peel remaining capture fixes from #119
- Encode whitespace in portable srcsets
- Preserve complex URLs during capture export
- Keep apostrophes in rewritten media URLs
- Land capture fixes independently of reconstruction removal
- Capture automatic dialog dismissal
- Speed up portable capture resource settling
- Bound semantic capture evidence
- Prevent root media aliases from corrupting exports
- Rescan disclosures during capture hydration
- Preserve lazy disclosure content in captures
- Keep the comma when un-pausing an animation shorthand
- Keep completion gates on restored animations
- Remove the second CLI
- Preserve bounded visual iframes in captures
- Preserve fluid geometry above mobile breakpoints
- Drive script-gated entrance animations from the scroll timeline
- Make the gate measure the whole site, and let liberation exit
- Open the comparison to contributed checks
- Make image identity survive our own localization
- Keep the Wix StripShowcase host box so the slideshow matches live geometry
- Turn Wix StripShowcase into a CSS slideshow of real images
- Give a liberated copy real same-page anchor targets
- Stop srcset placeholders from blowing the layout to 2660px
- Collapse canonical duplicate routes instead of failing export
- Drop leftover remote asset requests from a liberated copy
- Compare a liberated copy to its source at unsampled widths
- Register publish targets through a public API
- Move platform CDN knowledge behind the adapter seam
- Learn how a source sizes itself instead of freezing one width
- Make the stated contract the liberated HTML site
- decouple core from MCP
- Remove stub commands that shadow skills
- Add portable website artifact handoff
- Sync standalone DLA with the Studio implementation
- adopt @automattic/blocks-engine as reconstruct core
- resolve conflicts

### Fixed
- keep unavailable capture resources observable instead of silently blank
- wait for DOM to quiesce before snapshotting deferred SPA content
- preserve CSSOM and constructed stylesheet styles in captures
- preserve encoded capture route paths
- keep an in-flow empty footer landmark in the website export
- settle scroll-reactive chrome before the freeze
- read pager slideshow states before layout measurement
- collect every state a thumbnail picker advertises
- run recovered entrance animations in the frozen document
- omit empty @font-face src sentinels so woff/ttf can load
- collect Wix slideshows on the DOM that is about to be frozen
- hydrate Wix slideshows into view before collecting states
- strip orphaned #id CSS rules when source cleanup removes an element
- collect Wix slideshow states in every viewport
- do not treat viewport-only iframes as a second document
- preserve localized media in captured stylesheets
- avoid polynomial evidence slug regex
- avoid navigating during disclosure expansion
- wait for Wix slideshow transitions before capturing states
- serialize observed Wix slideshow states even when nav over-declares them
- collapse equivalent responsive variants, keep structural ones
- keep disclosure hydration from losing the last panel's content
- name routes that never produced HTML instead of dropping them
- keep stylesheets shared by both viewports applying at every width
- Fix Wix anchor intent capture
- attribute host-injected surfaces to the host
- resolve relative canonical metadata
- discover rendered navigation routes
- Fix SPA route discovery from rendered navigation
- recover orphaned artifacts when resuming
- allow only safe navigation URL schemes
- capture every ARIA popup trigger, not only dialogs
- shard semantic evidence artifacts
- export destination-neutral capture sidecars
- recover malformed scoped CSS
- preserve source JSON-LD as standard inert HTML
- capture mobile pages as iPhone 17
- Fix dismissal for portable captured dialogs
- preserve static capture layout
- rewrite captured dialog route links
- reveal captured dialog roots
- default fluid learning on
- cook data-liberation-agent
- keep mobile CSS when responsive bodies match
- adopt blocks-engine 0.2.2 with structured strategy on the blocks path
- Fix npm ci command

## [0.2.2] - 2026-06-19

### Fixed

- Local-site conversion preserved nested styling, classless spans, list-item
  classes, and loose body-level siblings of `<main>` that were previously
  dropped during the block conversion.

## [0.2.1] - 2026-06-19

### Added

- Local-site conversion carries HTML `<img>`/SVG assets into the theme and
  hardens carried inline `<script>`/`<style>` handling.
