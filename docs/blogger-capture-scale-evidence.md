# Blogger capture scale: issue 467

Source: https://reflectingtheimage.blogspot.com/

## Measured bottleneck

The Studio URL import with DLA 0.8.0 discovered 2,700 routes and completed
166 browser captures in 30 minutes before the orchestration timeout. This
is an observed partial run, not a full-site timing result.

Direct profiling in the issue worktree (DLA 0.8.1) measured individual recent
and older posts at 44–46 seconds including desktop and mobile. The fluid
learner found no runtime-sized candidates on these posts, and disabling
fluid learning did not materially improve the bounded sample. Selectable-set
probing spent about six seconds per viewport on candidates that did not vary.

The generic recognizer excluded popup and disclosure controls themselves,
but still admitted their descendants through inherited `cursor: pointer`.
Activating those descendants bubbles to the excluded control. They are not
independent selectable members; popup/disclosure capture already owns them.

## Scoped improvement

Apply the existing popup/disclosure exclusions to descendants too. This
preserves the existing recognition and capture of pointer-only pickers,
tabs, form choices, and genuine selectable groups. A neutral browser
regression verifies both empty selectable evidence and zero accidental
activations for nested control labels. It fails on the baseline.

Fresh browser pages, same source, same probe defaults:

| Post | Width | Baseline ms | Candidate ms |
| --- | ---: | ---: | ---: |
| 2026/08/a-new-chapter.html | 390 | 5,204 | 3,386 |
| 2026/08/a-new-chapter.html | 768 | 4,986 | 3,398 |
| 2026/08/a-new-chapter.html | 1440 | 5,048 | 3,244 |
| 2021/04/a-people-of-mercy.html | 390 | 4,900 | 3,199 |
| 2021/04/a-people-of-mercy.html | 768 | 4,794 | 3,326 |
| 2021/04/a-people-of-mercy.html | 1440 | 4,809 | 3,367 |

Probe time totals: 29,741 ms baseline → 19,920 ms candidate (33.0% reduction).
Both produced zero confirmed selectable states on these routes. Remaining
negative probes concern Read more and Archive controls. This is a measured
probe improvement, not a 33% end-to-end capture speedup.

## Verification and boundary

- `npm test`: 121 files, 1,417 tests passed.
- `npm run build`: passed.
- `npm run test:package`: passed, including relocated browser-backed capture
  and comparison.
- A fresh homepage/recent-post/older-post sample captured 3/3 routes with
  zero capture failures in 72,937 ms including export and screenshots.
  The sample intentionally omits the rest of the archive and therefore
  correctly reports `complete: false` for unresolved source links.
- `compare` on both the baseline and candidate reports the same seven
  source-check failures and three offline findings: external resource
  requests, duplicate anchor targets, and the Labels interaction. The
  comparison gate is still red. No full-site parity claim is made.
- WordPress sample materialization was attempted; the shared Studio trunk
  build could no longer resolve its `zod` dependency at that time.

The public Blogger feed returns bulk content quickly (2.4 MB in 3.4 seconds
in a bounded request), but full content is not the same as full rendered
HTML. Reusing one rendered post shell for every post would need to account
for post-specific navigation, comments, widgets, styles, media, and runtime
behavior. This change does not claim that equivalence. Complete-site
acceleration remains open under issue 467.

## Execution provenance

Chris authorized direct OpenCode execution after the Homeboy attempt and
retry reported cancellation. The isolated issue worktree retained a prior
Blogger detection/discovery commit; the interaction-probe change above was
implemented and verified directly with OpenCode using OpenAI GPT-6 Sol.
Homeboy did not execute the final deterministic gates for this change.
