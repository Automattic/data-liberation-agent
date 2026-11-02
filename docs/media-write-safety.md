# Media write ownership (#1154)

The BMOA evidence identifies the conflicting acquisitions, not merely two
similarly named originals:

- The JS200 `Step+2+-+wetting-2.jpg?format=300w` acquisition owned
  `media/Step-2-wetting-2.webp`, succeeded at 23:02:58.337Z, and was verified
  as SHA-256 `61a1da4f…`.
- At 23:04:33, during later 500w rendition acquisition, that path changed:
  its resulting SHA-256 is `ab468a42…`, length 24282, while the two recorded
  500w stubs point at `-5.webp` (24260 bytes) and `-6.webp` (20600 bytes).
  Thus the replacement is not simply the bytes recorded at `-5` or `-6`.

The stage-level writer pair implicated by the timestamps is the early URL-owned
original acquisition (the asset queue, subsequently verified by `captureAssets`)
and later rendition acquisition inside `captureAssets`. The similarly slugged F7Q29 source adds contention but
its recorded 300w file (`-2.webp`) still matches its verified hash. The section
media downloader runs after `captureAssets` with a fresh directory snapshot;
it is not evidence for an overlapping queue/section writer race. The queue is
also drained before verification starts.

The supplied artifacts do not record individual filesystem operations, response
headers, or the overwritten payload's source URL, so they cannot distinguish a
direct download write from a signature-driven extension-correction rename as
the final destructive syscall. Both were overwrite-capable, as was copying a
captured resource. The fix does not depend on choosing one: filesystem-exclusive
creation arbitrates every acquisition, copy, and correction. Name maps are only
hints; EEXIST retries with the next numeric name. Extension correction uses an
exclusive hard link followed by removal of the source, never replacing rename.
Stream failure cleanup removes only a file whose descriptor this writer owns.
Raster siblings and portable media copies use the same exclusive primitives.

The regressions exercise stale independent downloader snapshots and inject a
second same-slug writer during rendition acquisition, after the verifier's name
snapshot but before its extension correction. Both fail against main. The
browser regression costs approximately one second; it verifies every retained
record's bytes against its recorded hash, including the competing writer's files.
