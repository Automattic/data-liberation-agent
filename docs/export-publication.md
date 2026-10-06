# Export publication

`exportWebsiteCapture` builds the next portable generation in a same-filesystem stage, then publishes it under a single-writer lock. The public `website/` tree and the export-owned root sidecars are one generation. Capture input and later capture steps are not.

## Owned names

Required, in publication order:

| Path | Kind |
| --- | --- |
| `website` | directory |
| `layout-geometry-report.json` | file |
| `source-profile.json` | file |
| `asset-evidence.json` | file |
| `diagnostics.json` | file |
| `capture-receipt.json` | file, commit marker, published last |

Optional. A generation that does not produce one deletes the previous file or directory:

| Path | Kind |
| --- | --- |
| `layout-geometry-proof.json` | file |
| `source-interactivity.json` | file |
| `semantic-evidence.index.json` | file |
| `semantic-evidence` | directory, including every shard |
| `interaction-states.json` | file |
| `scroll-states.json` | file |
| `cleanup-evidence.json` | file |

Not owned, and never replaced or deleted by publication: captured HTML, `screenshots/`, `resources/`, `layout-geometry/` observations, section specs, `http-acquisition.json`, `reference/`, `fidelity-reference.json`, `source-behavior.json`, and any other run file. `capture.ts` writes preview onto the receipt and finalizes the fidelity reference after export returns. Those steps are outside this transaction.

Report identities stay public relative paths (`website/index.html`, `semantic-evidence/shard-0001.json`). They do not contain the staging directory or its generation id.

## Lock

`.export-publication.lock` is created with `O_EXCL`. It records pid, process start time (`ps -o lstart`), generation id, and token. A live pid whose start time still matches rejects the second export. Rejection is not a queued or merged rematerialization: the second call throws `ExportPublicationRejected` and does not remove the in-flight stage. `materializeHttpDocuments` uses the same export, so a concurrent rematerialization is rejected the same way.

`.export-publication.recoverer` is a separate `O_EXCL` claim. It is never unlinked by another process. A live or stale recoverer rejects both recovery and a new export, so publication does not rename public files while recovery is claimed. A stale recoverer is operator recovery: remove that file only after confirming no recovery is in progress. A corrupt publication lock is not stolen.

A pid is stale only when `kill(pid, 0)` fails with `ESRCH`, the recorded start time no longer matches, or the lock was marked `pid: 0` after a failed rollback. A reused pid is not signaled. If start time cannot be read, a live pid is not stolen.

Each attempt has its own `.export-publication/<generation>/` directory: `owner.json`, `journal.jsonl`, `stage/`, and `backups/`. The stage is on the output filesystem so each replacement is a rename. Publication does not create symlinks and refuses to replace a symlink at an owned path.

## Journal and recovery

The journal is append-only JSONL. Before any public rename, the plan lists every owned path and whether this generation replaces or deletes it. Each public mutation then records `mutate-begin` (existed, backup path), `backed-up` when a previous entry was renamed aside, and `applied` after the new entry is renamed into place. `capture-receipt.json` is last. The following `committed` line is the recovery authority, and only when its generation id matches that journal's directory.

A trailing fragment that does not parse, and is not terminated by a newline, is an in-progress append and is ignored. A newline-terminated line that does not parse, a record in the middle of the file that does not parse, or a record whose type, path, backup, or generation does not match the known fields fails closed. Recovery then neither restores nor deletes. A later `committed` line is not trusted past that break, so a corrupt record cannot hide or invent a commit.

Recovery does not recapture. If a validated `committed` record is present, recovery deletes only the private generation directory and lock. If a mutation started and `committed` is absent, recovery restores each backup in reverse order, or removes an entry this attempt created. A plan with no mutations discards the private stage and leaves the public generation unchanged.

Process-death recovery runs at the next `recoverExportPublication` or at the start of the next export. An in-process failure rolls back before the original error is rethrown. If rollback, journal read, or journal validation fails, that original error is preserved, `exportPublicationRollbackFailure` is attached, and the journal, backups, and stage remain. The lock is marked `pid: 0` so a later recovery can finish a readable journal. A failed journal read does not replace the export exception.

## Read visibility

Do not treat owned outputs as coherent while `.export-publication.lock` exists.

| Window | What a reader can observe |
| --- | --- |
| Before the first public rename | Previous generation, or absence on a first export |
| After a rename and before `committed` | A mix of new and old owned names. The receipt may still be old, or, after the receipt rename and before `committed`, already new. Recovery will roll this window back |
| After `committed`, before lock removal | New generation. Recovery will not roll it back. Private stage and lock may still be present |
| After successful return | Lock and `.export-publication/` are gone. `capture-receipt.json` matches the owned set |

There is no multi-file atomicity. A reader during publication can see a new `website/` beside an old receipt, or a new receipt that recovery later restores. There is no `fsync` and no power-loss durability: a completed `write` survives process death, not a disk that lost its cache. A first export that fails before `committed` leaves no `website/` and no `capture-receipt.json`.
