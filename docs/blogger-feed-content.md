# Blogger feed content

With `--template-clusters`, Blogger capture enumerates the post feed through the source request governor and includes every retained permalink in the route inventory. Two post samples establish a provisional template cohort; normal browser representative and verification captures still own acceptance. Canonical probing does not fetch Atom alternate permalinks again.

Before using feed bodies, the representative and verification bodies must match the feed on normalized text, links, image sources and srcsets. The synthesized verification document also passes the existing derived-versus-captured checks. A failure disables feed acquisition for that cluster and uses governed page acquisition instead. Ambiguous or empty bodies are not proofs. Derived documents retain the existing derived/uncompared fidelity scope; these checks do not prove unsampled posts identical to their source pages.

The ordinary slot mapper transplants the synthesized member document into the captured representative, including a separate phone document when present. The export uses the feed permalink's slug and publishes `website/blogger-content.json`:

- `posts`: retained feed entries, including content HTML, title, dates, author, permalink slug, labels, `terms` and allocated portable `path`;
- `terms`: label names, `kind: "term-archive"`, source label URLs and portable paths;
- `redirects`: old absolute permalinks and label URLs mapped to allocated portable paths.

The HTML export also writes changed paths to `_redirects`. Captured label listings remain listings, not posts in the content index. A label without a captured listing gets a generated UTF-8 term archive linking to its retained posts. Generated archives never replace captured resources. Like other export files, the index and generated archives are staged in the atomic website publication and count toward export budgets. Only retained posts appear in the semantic index and redirect map.

## Validation and remaining scope

The offline fixture exercises derivation beyond a two-document browser budget, no HTTP requests for derived member pages, fallback on a truncated verification feed, export metadata, term archives, and redirect coverage. Existing feed fixtures cover a 2,181-entry archive and governed retry/exhaustion of 429 responses.

A live browser check of BoardGameMonkeys matched feed and browser post bodies on normalized text, links and images for these two verification samples:

- `https://www.boardgamemonkeys.com/2026/11/learning-star-buchstaben-und-laute.html`
- `https://www.boardgamemonkeys.com/2026/11/alpaka.html`

This is not a completed 2,000-post live capture or a fidelity claim about the rest of that archive.

**DLA #1701 (4) is a follow-up:** media still uses the existing blocking resource/materialization stages. This change does not add a resumable post-export media job, change rendition selection, or claim media retry/loss-ledger acceptance for that proposed job.
