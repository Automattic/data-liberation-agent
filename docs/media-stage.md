# Media stage

Template-cluster derivation (#784, #1701) can produce thousands of member documents without a page fetch. Their media is not downloaded while deriving; it is queued and downloaded by a separate, resumable job after the content export.

## Queue

`<output>/media-queue.json` (`data-liberation-agent/media-queue/v1`) holds one entry per referenced URL:

| Field | Meaning |
|---|---|
| `url` | URL the derived document references (image `src`, `srcset` candidate, video `poster`/`src`, metadata image, linked media). |
| `originalUrl` | Rendition to download: the adapter's `resolveImageOriginal`, applied to a fixed point. Renditions of one original share one file. |
| `path` | Deterministic portable path, `deferred-media/<sha256(originalUrl)[0:16]>/<name>`. An extensionless URL takes its extension from the response content type. |
| `status` | `pending`, `done` or `failed`. |
| `attempts`, `lastError`, `httpStatus`, `contentType`, `bytes` | Download evidence. |

Media already captured with the representative stays on the existing resource path. Template dependencies (stylesheets, fonts) are still captured during derivation.

## Export

The export rewrites queued references to `/<path>` whether the file has landed or not, so files that land later need no re-export. Downloaded files live in `<output>/deferred-media/`, outside the export generation, and are hard-linked (or copied) into `website/` after each export. Queued media is not counted against the export byte and file budgets.

## Job

`data-liberation media <output-dir>` runs the job; `data-liberation <url>` runs it after the export unless `--defer-media` is passed. A re-run skips stored files and retries pending and failed entries. `SIGINT` stops the job and keeps the queue.

- Every request goes through the source request governor (`asset-original` category), which already waits for `Retry-After` on 429/503.
- The job adds bounded retries per file (default 4 requests): 429/503 wait for `Retry-After`, other 5xx, 408 and transport failures back off exponentially (1 s, doubling, capped at 60 s). A refused original (4xx) falls back to the referenced rendition.
- At most 4 downloads per origin are in flight.

## Ledger

The job writes `media` (`total`, `done`, `failed`, `pending`, `failures[]` with `url`, `status`, `reason`) into `capture-receipt.json`, and one `media_download_failed` row per failed file into `discoveryDiagnostics` (see the [loss ledger](contracts/loss-ledger.md)). The CLI exits non-zero while any file is failed or pending.
