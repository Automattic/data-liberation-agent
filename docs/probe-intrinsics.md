# Source-page JavaScript intrinsics

Source scripts may replace globals such as `Number`, `Array`, `Object`, `Math`,
`JSON` and `parseFloat`. Capture must not repair these globals: doing so changes
how the source renders and handles interactions.

`browser-kit/probe-intrinsics.ts` installs an immutable intrinsic-reference
snapshot before source scripts in every source context. Probe functions and
string expressions receive lexical bindings to that snapshot. Init-script
observers and functions they retain receive the same bindings, including
probe-created `Function` factories. Page-owned globals and DOM remain untouched.

Probe evaluation uses Chromium CDP in the actual document's main world. This
also bypasses Playwright's argument/result serializer, which depends on the
page's `Object` and `Array`. Object handles stay in that document and are released
by their owners. Navigation selects the new main-world context and its snapshot.

Locator resolution still uses Playwright's utility-world selector engines.
Temporary `probe-<uuid>` node attributes bridge the selected node to CDP; they
are removed before invoking the callback, with failure cleanup as well. They
must never appear in serialized capture evidence. Frozen-reference contexts
install this boundary independently of their capture context.

The HTTP-served `clobbered-builtins.html` regression replaces several globals,
retains resize-driven geometry, and exercises page, locator, string and retained
handle evaluation, native timelines, capture and frozen-reference readiness.
