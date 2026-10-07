# Source collection evidence

The Wix adapter retains source-proven CMS data as inert metadata inside portable HTML:

```html
<script type="application/json" data-dla-source-evidence="collections">
{"schema":"source/collections/v1","source_url":"https://example.test/agencies","collections":[],"diagnostics":[]}
</script>
```

Capture reads the publicly served `wix-warmup-data` collection schemas and record store, and the viewer's explicit source URL. It retains stable collection/record IDs, source field types and labels, declared relationships, observed field values, authored detail-page links, and dataset membership/counts. Publisher identity (`_owner`) and deleted fields are excluded. Draft/unproven record identities, invalid values, cross-origin/query/fragment detail routes, unavailable relationship inventories/values, and partial or ambiguous dataset membership remain diagnosed.

Collection fields contain `id`, `label`, `source_type`, and `system`, with optional `reference_collection` and `route_pattern`. Record fields contain `id`, observed `values`, and explicit `source_routes`. Values retain their source encoding: image identifiers and date wrappers are source evidence, not destination-specific values.

`coverage.dataset_complete` proves only distinct membership and count agreement for the **observed datasets**. It does not prove an entire backend collection, related-record completeness, filtering equivalence, or native destination compatibility. Consumers must make those decisions from the retained evidence and diagnostics.

Bounds are 20 collections, 64 fields per collection, 200 records per collection, bounded nested values, 2 MB per source JSON document, and 256 KB per generated evidence document. Oversized output produces an explicit empty/unproven evidence envelope rather than a truncated complete claim. Ordinary rendered capture remains available.

The generic HTML exporter preserves versioned inert `data-dla-source-evidence` scripts alongside JSON-LD, without retaining executable provider runtime. Each evidence script is bounded to 256 KB and a route retains at most eight scripts. Invalid or over-limit evidence is recorded as `source_evidence_unproven`. Collapsed canonical aliases carry their source metadata to the retained document through the same route-allocation stage.

## Verification

Unit and portable-export regressions cover typed records/routes, incomplete or ambiguous datasets, unavailable relationship evidence, publisher exclusion, malformed/bounded metadata, inert end-tag handling, and canonical alias preservation.

`node scripts/verify-wix-collections-live.mjs .tmp-test/wix-collections-live` runs a caller-owned bounded Platform API recipe against one real KMR collection-listing route. It uses the built-in Wix capture hooks, normal browser capture/export, and the frozen fidelity API. It verifies the nine observed source record identities, typed fields, authored agency routes, and the portable evidence document.

The retained live result distinguishes source-evidence verification from whole-site capture, visual fidelity, and native WordPress acceptance. The bounded listing run is not a complete site import. Before/after runs both passed self-consistency and tablet/desktop fidelity; both reported the same phone text-count mismatch (348 source vs. 331 portable characters). The before run used the prior Wix canonicalizer and retained no collection metadata; the after run retained the nine actual record identities. Add `--baseline` to the reproduction command for that prior-hook run. Results identify the executed runtime bundle hash and remain pending while a new run is active. The site candidate remains review evidence until its requested acceptance scope passes.

Owning trackers: [Data Liberation Agent #615](https://github.com/Automattic/data-liberation-agent/issues/615), [Blocks Engine #2567](https://github.com/Automattic/blocks-engine/issues/2567), and [Static Site Importer #1979](https://github.com/Automattic/static-site-importer/issues/1979).
