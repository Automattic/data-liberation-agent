# Runtime-ID export audit (#1678)

## Reproduction

Run `node --import tsx scripts/benchmark-export.ts` from a source checkout.
The fixture feeds the real exporter 320 distinct routes, each with 80 runtime
IDs, repeated prose, and a dangling image with two srcset candidates. It needs
no browser or network. `PAGES` and `ITEMS` override the dimensions. Fixture
construction and the resolved-output hash are outside the measured export.

Measurements in the same workspace (milliseconds, Node 24.18.0):

| Source | Pages | Export |
| --- | ---: | ---: |
| 93876e7e | 320 | 8,090 |
| main before fix | 320 | 31,184 |
| fixed | 320 | 8,048 |
| fixed, output-hash/profile run | 320 | 9,111 |
| fixed | 640 | 16,868 |

A later paired output-hash run was noisier (37,475 ms before, 31,378 ms
after); both emitted the same resolved-route SHA-256:
`2c483c90d86a2b323acc408ed80137b0b06aff969a80025ecc0fdf7eeba78166`.
Timing is evidence, not a test assertion.

## Diagnosis

The before-fix CPU profile recorded 22,220 self samples in the anonymous
`capture-export.ts` callback, versus 2,616 in
`removeDanglingVisualMediaSource`. The runtime-ID audit called `includes(id)`
against every other retained text for every candidate ID. Thus even fixed-size
pages accumulated quadratic cross-route text scanning. A media-heavy variant
(80 dangling srcset images per route) did **not** reproduce the historical
slowdown: old export took 206,920 ms versus 43,107 ms on main. Batching dangling
media was not the regression in these measurements.

The replacement builds one candidate trie with failure links, scans retained
texts once, and records whether each candidate occurs in one file or multiple
files. Queries exclude the current file in constant time. This preserves raw
substring matching (including candidate prefixes inside longer names), the
original pre-rewrite snapshot, and fail-closed behavior when the existing
bounded text inventory cannot be read completely. Work is proportional to
input bytes, candidate bytes and reported matches, rather than the number of
routes times the entire retained text inventory.

The deterministic real-export test observes bytes searched by per-ID
`String.includes`: the original implementation searches 2,232,480 bytes on a
16-page fixture; the fixed implementation searches zero. Separate index tests
compare answers with the original substring predicate, including encoded IDs,
prefixes, uppercase names and Unicode.
