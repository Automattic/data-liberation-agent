# Selectable control ownership (issue 467)

Source: https://reflectingtheimage.blogspot.com/

The pinned 25-route, 50-viewport profile on DLA 0.8.8 recorded selectable
probes as 30.9% of accumulated worker time: 242.2 seconds, 4.84 seconds per
viewport. There were no confirmed selectable sets. Read more wrappers and
native Archive summaries were being probed as independent set members.

## Change

Extend the existing disclosure predicate to native details' first summary,
including descendants through the existing ancestor predicate. Exclude
pointer-only wrappers whose sole text/action is one navigable link. Explicit
selectable semantics, inline handlers, nested controls and mixed editorial
content remain candidates. No site-specific class/host match or reduced
settle budget is used. Show more and Reply/Delete remain negative probes;
their ownership needs separate evidence.

Neutral browser regression fails on baseline with negative selectable
records for both fixture groups. Candidate produces no records or accidental
activations; actual summary clicks still open details and link clicks still
navigate. Positive regression retains semantic tabs containing links and
pointer pickers with mixed link/content, alongside existing picker tests.

## Live matched sample

Same 25 routes and six-worker capture configuration, fresh directories:

| Measurement | Before | After |
| --- | ---: | ---: |
| Selectable worker time (50 observations) | 242.2 s | 76.0 s |
| Mean selectable time per viewport | 4.84 s | 1.52 s |
| Browser wall time | 156.4 s | 131.3 s |
| Capture/export wall time | 178.6 s | 152.3 s |
| Routes captured / failures | 25 / 0 | 25 / 0 |

The selectable stage reduced by 68.6%. Observed browser wall time reduced
16.0%, total wall time 14.7%. This is one matched live pair; it does not
establish a full-archive timing promise. Prior timing runs showed variance.

Fresh source/capture comparison on homepage, recent post and year archive
at 390/768/1440: all nine views retain exact visible-text and image counts;
baseline screenshot similarity rounds to 1.0000. Existing external-frame,
ambiguous-anchor and sidebar interaction findings remain. All-route offline
comparison still reports 29 ambiguous-anchor findings. The bounded sample
correctly remains incomplete because it omits unsampled routes.

## Verification

Full local suite: 1,430 passed with one unrelated large-route export test
timing out under load. That test passed when rerun alone. Build and packaged
runtime checks passed. Final CI status is recorded on the PR.

Execution: Chris authorized direct isolated-worktree implementation after
Homeboy cancellation. OpenAI GPT-6 Sol using OpenCode implemented the scoped
predicate refactor, reproduced regression, profiled live capture and ran
verification. Finalization occurred outside Homeboy. Full capture remains
paused at human request.
